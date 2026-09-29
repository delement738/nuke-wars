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
// Deliberately free of sockets: a connection is anything with a `send`, so the
// room logic is tested with plain arrays, and `./server` glues it to `ws`.

import { randomInt, randomUUID } from 'node:crypto';
import { generateMap, type MapData } from '../src/sim/map';
import { validateSetup } from '../src/sim/setup';
import { PLAYERS, opponentOf, type PlayerId } from '../src/sim/types';
import {
  createLocalAuthority,
  type LocalAuthority,
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
  type ServerMessage,
} from '../src/net/protocol';

/** Anything the lobby can talk to: a WebSocket in production, an array in tests. */
export interface Peer {
  send(message: ServerMessage): void;
}

/** One browser's session with the lobby, from connecting to closing. */
export interface Connection {
  /** A raw message from the browser — untrusted, parsed before anything reads it. */
  receive(raw: string): void;
  /** The browser has gone. */
  close(): void;
}

export interface Lobby {
  connect(peer: Peer): Connection;
  /** Rooms currently open — for logging and tests. */
  roomCount(): number;
}

/** Where a lobby gets its randomness. Injectable so tests can pin a board. */
export interface LobbyOptions {
  /** A room's map seed. Same range the client's "New map" uses. */
  seed?: () => number;
  log?: (line: string) => void;
}

interface Seat {
  /** This seat's secret — Session 7's reconnect presents it to get back in. */
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
}

/**
 * The difficulty handed to a room's authority. Never used — both seats are
 * human, so the authority plays no CPU — but its config requires one.
 */
const NO_CPU = 'medium';

export function createLobby(options: LobbyOptions = {}): Lobby {
  const seedOf = options.seed ?? (() => randomInt(1, 100000));
  const log = options.log ?? (() => {});
  const rooms = new Map<string, Room>();

  function newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      }
      if (!rooms.has(code)) return code;
    }
  }

  /**
   * Hand each player their own update, and nobody else's. A seat whose browser
   * has gone misses it; Session 7's reconnect is what gives it back.
   */
  function route(room: Room, updates: MatchUpdates): void {
    for (const player of PLAYERS) {
      const update = updates[player];
      if (update) room.seats[player]?.peer?.send({ type: 'update', update });
    }
  }

  function openRoom(): Room {
    const seed = seedOf();
    const map = generateMap(undefined, undefined, seed);
    // `room` is declared before the authority so the update callback can close
    // over it; the authority never calls back until someone submits.
    const room: Room = { id: newCode(), seed, map, seats: {}, authority: null! };
    room.authority = createLocalAuthority(
      { map, seed, seats: HOTSEAT_SEATS, difficulty: NO_CPU },
      (updates) => route(room, updates),
    );
    rooms.set(room.id, room);
    log(`room ${room.id} opened (seed ${seed}); ${rooms.size} open`);
    return room;
  }

  function connect(peer: Peer): Connection {
    let room: Room | null = null;
    let seat: PlayerId | null = null;

    function fail(code: ErrorCode): void {
      peer.send({ type: 'error', code });
    }

    /** Sit this connection in `player`'s seat and tell both sides. */
    function sit(target: Room, player: PlayerId): void {
      const token = randomUUID();
      target.seats[player] = { token, peer };
      room = target;
      seat = player;
      peer.send({
        type: 'joined',
        room: target.id,
        seat: player,
        token,
        seed: target.seed,
        map: target.map,
      });
      const other = target.seats[opponentOf(player)];
      peer.send({ type: 'opponent', present: Boolean(other?.peer) });
      other?.peer?.send({ type: 'opponent', present: true });
    }

    function enter(message: Extract<ClientMessage, { type: 'create' | 'join' }>): void {
      if (room) return fail('ALREADY_IN_ROOM');
      if (message.version !== PROTOCOL_VERSION) return fail('VERSION_MISMATCH');

      if (message.type === 'create') {
        sit(openRoom(), 'p1');
        return;
      }
      const target = rooms.get(normaliseRoomCode(message.room));
      if (!target) return fail('NO_SUCH_ROOM');
      // A seat stays reserved after its browser leaves: it belongs to whoever
      // holds the token, not to the next person with the link.
      const free = PLAYERS.find((player) => !target.seats[player]);
      if (!free) return fail('ROOM_FULL');
      sit(target, free);
    }

    function play(message: Exclude<ClientMessage, { type: 'create' | 'join' }>): void {
      if (!room || !seat) return fail('NOT_IN_ROOM');
      const { authority, map } = room;

      switch (message.type) {
        case 'setup':
          // Checked here, against this seat alone, rather than left to
          // `startMatch`: that runs when the *last* setup arrives and would
          // blame whichever player happened to submit second.
          if (!validateSetup(map, seat, message.setup).legal) return fail('ILLEGAL_SETUP');
          authority.submitSetup(seat, message.setup);
          return;
        case 'orders':
          // Illegal orders need no check here: `resolve()` validates every one
          // against the true board and silently drops what fails, exactly as
          // it does for a local game (gotcha 13).
          authority.submitOrders(seat, message.orders);
          return;
        case 'resign':
          authority.resign(seat);
          return;
      }
    }

    return {
      receive(raw) {
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
        if (mine) mine.peer = null;
        room.seats[opponentOf(seat)]?.peer?.send({ type: 'opponent', present: false });
        // With nobody left in it, nobody can finish it (reconnect is Session 7,
        // which will keep an empty room alive for a grace period instead).
        if (PLAYERS.every((player) => !room!.seats[player]?.peer)) {
          rooms.delete(room.id);
          log(`room ${room.id} closed; ${rooms.size} open`);
        }
        room = null;
        seat = null;
      },
    };
  }

  return { connect, roomCount: () => rooms.size };
}
