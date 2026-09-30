// SERVER — rooms and seats (V1.5 Session 6). The protocol is in
// `src/net/protocol.ts`; the human-readable version is `docs/protocol.md`.
//
// A room is one match between two browsers. It holds a board, two seats and a
// `LocalAuthority` — **the very same `createLocalAuthority` that runs a solo
// game in the browser**, created here with both seats human. That is the whole
// point of Session 5's split: the server does not re-implement the match, it
// hosts it, so a networked game and a local one cannot drift apart.
//
// What this file adds is routing. The authority hands back a `MatchUpdates` with
// one entry per player, and each entry goes to **that seat's connection and no
// other**. That line — `seats[player].peer.send(updates[player])` — is where
// "the server sends each player only their filtered view" actually happens.
// `server.test.ts` records every byte one seat receives across a whole match and
// checks the other seat's hidden pieces never appear in it.
//
// **Session 7 adds time and return.** Each round has an order clock; when it runs
// out the server submits an empty turn for any seat still owing one, so a player
// who has gone, or gone quiet, cannot stall the other. And a seat belongs to its
// token: a browser that drops presents it again, retakes the seat, and is sent
// its whole filtered picture (`snapshot`). The room outlives an empty moment by a
// grace period so that a refresh, or a train going through a tunnel, is survivable.
//
// **Session 8 adds limits, for a server anyone can reach.** Each connection has
// a message allowance and each address a room-creation allowance (`./guard`);
// the server holds at most so many rooms; and no room lives forever — a finished
// match's room is let go a few minutes after the end, and any room is closed
// outright past a hard age, so rooms nobody plays cannot pile up.
//
// Deliberately free of sockets: a connection is anything with a `send`, so the
// room logic is tested with plain arrays, and `./server` glues it to `ws`.

import { randomInt, randomUUID } from 'node:crypto';
import { generateMap, type MapData } from '../src/sim/map';
import { validateSetup } from '../src/sim/setup';
import { PLAYERS, opponentOf, type PlayerId } from '../src/sim/types';
import {
  createLocalAuthority,
  type LocalAuthority,
  type MatchUpdate,
  type MatchUpdates,
} from '../src/state/authority';
import { HOTSEAT_SEATS } from '../src/state/seats';
import {
  PROTOCOL_VERSION,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  normaliseRoomCode,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type LogSlice,
  type ServerMessage,
} from '../src/net/protocol';
import { DEFAULT_LIMITS, createBucket, createIpLedger, type Limits } from './guard';

/** Anything the lobby can talk to: a WebSocket in production, an array in tests. */
export interface Peer {
  send(message: ServerMessage): void;
  /** Cut the connection — for a flooder, or a room closed under it. */
  close?(): void;
}

/** What the door knows about a connection. */
export interface PeerInfo {
  /** The visitor's address (see `clientIp` in `./guard`), for per-address limits. */
  ip?: string;
}

/** One browser's session with the lobby, from connecting to closing. */
export interface Connection {
  /** A raw message from the browser — untrusted, parsed before anything reads it. */
  receive(raw: string): void;
  /** The browser has gone. */
  close(): void;
}

export interface Lobby {
  connect(peer: Peer, info?: PeerInfo): Connection;
  /** Rooms currently open — for logging and tests. */
  roomCount(): number;
  /** Refusals since the server started — for the periodic stats line. */
  refusals(): { rateLimited: number; serverFull: number; cut: number };
  /** Close every room and stop every timer — the server is shutting down. */
  shutdown(): void;
}

/** Where a lobby gets its randomness. Injectable so tests can pin a board. */
export interface LobbyOptions {
  /** A room's map seed. Same range the client's "New map" uses. */
  seed?: () => number;
  log?: (line: string) => void;
  /** Timing, in milliseconds. Injectable so tests need not wait. */
  timing?: Partial<Timing>;
  /** Rate and size limits (`DEFAULT_LIMITS`). Injectable so tests can hit them quickly. */
  limits?: Partial<Limits>;
}

/** The clocks a lobby runs (designer's ruling, 2026-09-29: 25 s + ~5 s replay). */
export interface Timing {
  /** How long a round's orders may be sent, once the replay has had its time. */
  orderMs: number;
  /** Allowance for the previous round's replay, added when that round had events. */
  replayMs: number;
  /** Slack past the deadline for the browser's own auto-send to arrive. */
  graceMs: number;
  /** How long an empty room is kept for someone to come back to. */
  roomGraceMs: number;
  /** How long a finished match's room stays joinable after the end (Session 8). */
  finishedRoomMs: number;
  /** The most any room may live, played or not (Session 8). A match with its
   *  order clock lasts well under an hour; this catches rooms left in setup. */
  maxRoomMs: number;
}

export const DEFAULT_TIMING: Timing = {
  orderMs: 25_000,
  replayMs: 5_000,
  graceMs: 3_000,
  roomGraceMs: 120_000,
  finishedRoomMs: 5 * 60_000,
  maxRoomMs: 2 * 60 * 60_000,
};

interface Seat {
  /** This seat's secret — a returning browser presents it to get back in. */
  token: string;
  /** The connection in the seat, or null once it has gone. */
  peer: Peer | null;
}

interface Room {
  id: string;
  seed: number;
  map: MapData;
  seats: Partial<Record<PlayerId, Seat>>;
  authority: LocalAuthority;
  /** Whether each seat has handed in what is owed now: its setup, then each round's orders. */
  submitted: Record<PlayerId, boolean>;
  /** The latest filtered view each seat was sent, and its whole log so far —
   *  what a returning seat is rebuilt from. Only ever what was sent live. */
  latest: Partial<Record<PlayerId, MatchUpdate>>;
  log: Record<PlayerId, LogSlice[]>;
  /** When this round's orders are due (what browsers count down to), or null. */
  deadline: number | null;
  /** Fires at the deadline plus grace: submits empty orders for absent seats. */
  clock: ReturnType<typeof setTimeout> | null;
  /** Fires when the room has stood empty for the grace period. */
  reaper: ReturnType<typeof setTimeout> | null;
  /** Fires when the room reaches its age limit, or its match has been over a while. */
  ending: ReturnType<typeof setTimeout> | null;
  /** Set once the room is gone: a connection still holding it must not act on it. */
  closed: boolean;
}

/**
 * The difficulty handed to a room's authority. Never used — both seats are
 * human, so the authority plays no CPU — but its config requires one.
 */
const NO_CPU = 'medium';

export function createLobby(options: LobbyOptions = {}): Lobby {
  const seedOf = options.seed ?? (() => randomInt(1, 100000));
  const log = options.log ?? (() => {});
  const timing: Timing = { ...DEFAULT_TIMING, ...options.timing };
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const rooms = new Map<string, Room>();
  const creations = createIpLedger(limits);
  const refusals = { rateLimited: 0, serverFull: 0, cut: 0 };

  function newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      }
      if (!rooms.has(code)) return code;
    }
  }

  function isEmpty(room: Room): boolean {
    return PLAYERS.every((player) => !room.seats[player]?.peer);
  }

  /** Stop the order clock. */
  function stopClock(room: Room): void {
    if (room.clock) clearTimeout(room.clock);
    room.clock = null;
    room.deadline = null;
  }

  /**
   * The room is gone. Every timer stops and it leaves the list, so no one can
   * join it. `kick` also cuts the connections still in it — for a room closed
   * mid-match (its age limit); their browsers retry, are told `NO_SUCH_ROOM`,
   * and say the room has closed. A finished match is let go *without* a kick,
   * so its players keep their end screen.
   */
  function closeRoom(room: Room, why: string, kick: boolean): void {
    if (room.closed) return;
    room.closed = true;
    stopClock(room);
    if (room.reaper) clearTimeout(room.reaper);
    if (room.ending) clearTimeout(room.ending);
    room.reaper = null;
    room.ending = null;
    if (rooms.get(room.id) === room) rooms.delete(room.id);
    log(`room ${room.id} closed (${why}); ${rooms.size} open`);
    if (kick) for (const player of PLAYERS) room.seats[player]?.peer?.close?.();
  }

  /** Tell each present seat how long is left, or that no clock is running. */
  function sendClock(room: Room): void {
    const msLeft = room.deadline === null ? null : Math.max(0, room.deadline - Date.now());
    for (const player of PLAYERS) room.seats[player]?.peer?.send({ type: 'timer', msLeft });
  }

  /**
   * Start the order clock for the round now awaiting orders. The browsers are
   * told the deadline; the server waits a little longer than that, so a browser
   * that sends its drafted orders the instant its clock hits zero is not beaten
   * to it by an empty turn.
   */
  function startClock(room: Room, replayAllowance: number): void {
    stopClock(room);
    room.deadline = Date.now() + replayAllowance + timing.orderMs;
    room.clock = setTimeout(() => expire(room), room.deadline - Date.now() + timing.graceMs);
  }

  /** Time is up: whoever still owes orders sends an empty turn (everything holds). */
  function expire(room: Room): void {
    room.clock = null;
    try {
      for (const player of PLAYERS) {
        if (room.submitted[player]) continue;
        room.submitted[player] = true;
        log(`room ${room.id}: ${player} timed out`);
        room.authority.submitOrders(player, []);
      }
    } catch (error) {
      log(`room ${room.id}: ${String(error)}`);
    }
  }

  /**
   * Hand each player their own update, and nobody else's. A seat whose browser
   * has gone misses it live; `latest` and `log` are what give it back on return.
   */
  function route(room: Room, updates: MatchUpdates): void {
    for (const player of PLAYERS) {
      const update = updates[player];
      if (!update) continue;
      room.latest[player] = update;
      if (update.events.length > 0) {
        room.log[player].push({ round: update.round, events: [...update.events] });
      }
      room.submitted[player] = false;
      room.seats[player]?.peer?.send({ type: 'update', update });
    }
    const over = PLAYERS.some((player) => updates[player]?.view.phase === 'GAME_OVER');
    if (over) {
      stopClock(room);
      // Kept a few minutes for a reload to find its end screen, then let go.
      if (room.ending) clearTimeout(room.ending);
      room.ending = setTimeout(() => closeRoom(room, 'match over', false), timing.finishedRoomMs);
    }
    else if (isEmpty(room)) stopClock(room);
    else startClock(room, PLAYERS.some((p) => (updates[p]?.events.length ?? 0) > 0) ? timing.replayMs : 0);
    sendClock(room);
  }

  function openRoom(): Room {
    const seed = seedOf();
    const map = generateMap(undefined, undefined, seed);
    // `room` is declared before the authority so the update callback can close
    // over it; the authority never calls back until someone submits.
    const room: Room = {
      id: newCode(),
      seed,
      map,
      seats: {},
      authority: null!,
      submitted: { p1: false, p2: false },
      latest: {},
      log: { p1: [], p2: [] },
      deadline: null,
      clock: null,
      reaper: null,
      ending: null,
      closed: false,
    };
    room.authority = createLocalAuthority(
      { map, seed, seats: HOTSEAT_SEATS, difficulty: NO_CPU },
      (updates) => route(room, updates),
    );
    room.ending = setTimeout(() => closeRoom(room, 'age limit', true), timing.maxRoomMs);
    rooms.set(room.id, room);
    log(`room ${room.id} opened (seed ${seed}); ${rooms.size} open`);
    return room;
  }

  function connect(peer: Peer, info: PeerInfo = {}): Connection {
    let room: Room | null = null;
    let seat: PlayerId | null = null;
    const ip = info.ip ?? 'unknown';
    const bucket = createBucket(limits.messageBurst, limits.messagesPerSecond, Date.now());
    /** Messages refused for coming too fast, all told; past `messageStrikes` we hang up. */
    let strikes = 0;
    /** Whether the player has been told they are going too fast, since their last accepted message. */
    let warned = false;

    function fail(code: ErrorCode): void {
      peer.send({ type: 'error', code });
    }

    /** Sit this connection in `player`'s seat and tell both sides. */
    function sit(target: Room, player: PlayerId, resumed: boolean): void {
      const existing = target.seats[player];
      const token = existing?.token ?? randomUUID();
      target.seats[player] = { token, peer };
      room = target;
      seat = player;
      // Someone is here again: the room is no longer waiting to be reaped.
      if (target.reaper) clearTimeout(target.reaper);
      target.reaper = null;
      peer.send({
        type: 'joined',
        room: target.id,
        seat: player,
        token,
        seed: target.seed,
        map: target.map,
        resumed,
        submitted: target.submitted[player],
      });
      const latest = target.latest[player];
      if (resumed && latest) {
        peer.send({
          type: 'snapshot',
          view: latest.view,
          log: target.log[player].map((slice) => ({ ...slice, events: [...slice.events] })),
          finalReveal: latest.finalReveal ? [...latest.finalReveal] : null,
        });
      }
      const other = target.seats[opponentOf(player)];
      peer.send({ type: 'opponent', present: Boolean(other?.peer) });
      other?.peer?.send({ type: 'opponent', present: true });
      // A match whose clock stopped because the room emptied starts a fresh one
      // for whoever came back; otherwise the running clock is simply reported.
      if (latest && latest.view.phase !== 'GAME_OVER' && target.deadline === null) {
        startClock(target, 0);
        sendClock(target);
      } else {
        peer.send({
          type: 'timer',
          msLeft: target.deadline === null ? null : Math.max(0, target.deadline - Date.now()),
        });
      }
    }

    function enter(message: Extract<ClientMessage, { type: 'create' | 'join' }>): void {
      if (room) return fail('ALREADY_IN_ROOM');
      if (message.version !== PROTOCOL_VERSION) return fail('VERSION_MISMATCH');

      if (message.type === 'create') {
        if (rooms.size >= limits.maxRooms) {
          refusals.serverFull += 1;
          return fail('SERVER_FULL');
        }
        if (!creations.createRoom(ip, Date.now())) {
          refusals.rateLimited += 1;
          return fail('RATE_LIMITED');
        }
        sit(openRoom(), 'p1', false);
        return;
      }
      const target = rooms.get(normaliseRoomCode(message.room));
      if (!target) return fail('NO_SUCH_ROOM');
      // A seat belongs to whoever holds its token. A browser coming back takes
      // it over even if the server has not yet noticed the old connection die
      // (a refresh, a wifi change): the old one is simply replaced.
      if (message.token) {
        const mine = PLAYERS.find((player) => target.seats[player]?.token === message.token);
        if (mine) return sit(target, mine, true);
      }
      // A seat stays reserved after its browser leaves: it belongs to whoever
      // holds the token, not to the next person with the link.
      const free = PLAYERS.find((player) => !target.seats[player]);
      if (!free) return fail('ROOM_FULL');
      sit(target, free, false);
    }

    function play(message: Exclude<ClientMessage, { type: 'create' | 'join' }>): void {
      if (!room || !seat) return fail('NOT_IN_ROOM');
      if (room.closed) return fail('NO_SUCH_ROOM');
      const { authority, map } = room;

      switch (message.type) {
        case 'setup':
          // Checked here, against this seat alone, rather than left to
          // `startMatch`: that runs when the *last* setup arrives and would
          // blame whichever player happened to submit second.
          if (!validateSetup(map, seat, message.setup).legal) return fail('ILLEGAL_SETUP');
          room.submitted[seat] = true;
          authority.submitSetup(seat, message.setup);
          return;
        case 'orders':
          // Illegal orders need no check here: `resolve()` validates every one
          // against the true board and silently drops what fails, exactly as
          // it does for a local game (gotcha 13).
          room.submitted[seat] = true;
          authority.submitOrders(seat, message.orders);
          return;
        case 'resign':
          authority.resign(seat);
          return;
      }
    }

    return {
      receive(raw) {
        // Counted before parsing, so a flood of junk costs its sender too.
        if (!bucket.take(Date.now())) {
          strikes += 1;
          refusals.rateLimited += 1;
          if (!warned) fail('RATE_LIMITED');
          warned = true;
          if (strikes > limits.messageStrikes) {
            refusals.cut += 1;
            log(`connection from ${ip} cut: too many messages`);
            peer.close?.();
          }
          return;
        }
        warned = false;
        const message = parseClientMessage(raw);
        if (!message) return fail('BAD_MESSAGE');
        try {
          if (message.type === 'create' || message.type === 'join') enter(message);
          else play(message);
        } catch (error) {
          // One bad room must never take the server down with every other
          // match on it. The sim throws only on a broken invariant, so this is
          // a bug to log, not a player to blame.
          log(`room ${room?.id ?? '-'}: ${String(error)}`);
          fail('BAD_MESSAGE');
        }
      },

      close() {
        if (!room || !seat) return;
        const mine = room.seats[seat];
        // A seat already retaken by a newer connection is no longer ours to
        // empty, and its opponent has nothing to be told.
        if (mine && mine.peer === peer) {
          mine.peer = null;
          room.seats[opponentOf(seat)]?.peer?.send({ type: 'opponent', present: false });
        }
        const closing = room;
        room = null;
        seat = null;
        if (closing.closed) return;
        // With nobody left in it the clock stops (nobody is there to be timed)
        // and the room is kept for a grace period, so a player can come back.
        if (isEmpty(closing) && !closing.reaper) {
          stopClock(closing);
          closing.reaper = setTimeout(() => closeRoom(closing, 'empty', false), timing.roomGraceMs);
        }
      },
    };
  }

  return {
    connect,
    roomCount: () => rooms.size,
    refusals: () => ({ ...refusals }),
    shutdown() {
      for (const room of [...rooms.values()]) closeRoom(room, 'server shutting down', false);
    },
  };
}
