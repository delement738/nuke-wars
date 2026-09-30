import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateMap, makeRng } from '../src/sim/map';
import { PLAYERS, type PlayerId, type VisibleEvent } from '../src/sim/types';
import { createLocalAuthority, setupRng, type MatchUpdate } from '../src/state/authority';
import { cpuOrders } from '../src/state/cpu';
import { sandboxSetup } from '../src/state/sandbox';
import { HOTSEAT_SEATS } from '../src/state/seats';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/net/protocol';
import { createLobby, type Connection } from './lobby';

const SEED = 7;

/** No message allowance: these tests play whole matches in a millisecond, which
 *  no browser does. The limits themselves are tested at the bottom of the file. */
const UNLIMITED = { messageBurst: Infinity };

/** A browser, as the lobby sees it: a connection and everything sent to it. */
interface FakeClient {
  connection: Connection;
  inbox: ServerMessage[];
  /** Exactly what went over the wire, as strings — what the leak test reads. */
  wire: string[];
  send(message: unknown): void;
}

function client(lobby: ReturnType<typeof createLobby>): FakeClient {
  const inbox: ServerMessage[] = [];
  const wire: string[] = [];
  const connection = lobby.connect({
    send(message) {
      const raw = JSON.stringify(message);
      wire.push(raw);
      inbox.push(JSON.parse(raw));
    },
  });
  return { connection, inbox, wire, send: (m) => connection.receive(JSON.stringify(m)) };
}

function last<T extends ServerMessage['type']>(
  c: FakeClient,
  type: T,
): Extract<ServerMessage, { type: T }> | undefined {
  return c.inbox.filter((m) => m.type === type).at(-1) as Extract<ServerMessage, { type: T }>;
}

function updates(c: FakeClient): MatchUpdate[] {
  return c.inbox.flatMap((m) => (m.type === 'update' ? [m.update] : []));
}

/** Two clients in one room: A created it (p1), B joined by its code (p2). */
function room() {
  const lobby = createLobby({ seed: () => SEED, limits: UNLIMITED });
  const a = client(lobby);
  a.send({ type: 'create', version: PROTOCOL_VERSION });
  const code = last(a, 'joined')!.room;
  const b = client(lobby);
  b.send({ type: 'join', version: PROTOCOL_VERSION, room: code });
  return { lobby, a, b, code };
}

function autoSetup(player: PlayerId) {
  return sandboxSetup(generateMap(undefined, undefined, SEED), player, setupRng(SEED, player));
}

describe('rooms and seats', () => {
  it('creating a room seats you as p1 on a board chosen by the server', () => {
    const lobby = createLobby({ seed: () => SEED });
    const a = client(lobby);
    a.send({ type: 'create', version: PROTOCOL_VERSION });

    const joined = last(a, 'joined')!;
    expect(joined.seat).toBe('p1');
    expect(joined.room).toMatch(/^[A-Z2-9]{6}$/);
    expect(joined.seed).toBe(SEED);
    expect(joined.map).toEqual(generateMap(undefined, undefined, SEED));
    expect(joined.token.length).toBeGreaterThan(16);
    expect(last(a, 'opponent')).toEqual({ type: 'opponent', present: false });
    expect(lobby.roomCount()).toBe(1);
  });

  it('joining by code seats you as p2 on the same board, and both sides are told', () => {
    const { a, b } = room();
    const joined = last(b, 'joined')!;
    expect(joined.seat).toBe('p2');
    expect(joined.map).toEqual(last(a, 'joined')!.map);
    expect(joined.token).not.toBe(last(a, 'joined')!.token);
    expect(last(a, 'opponent')!.present).toBe(true);
    expect(last(b, 'opponent')!.present).toBe(true);
  });

  it('accepts a code typed in lower case or with spaces', () => {
    const lobby = createLobby({ seed: () => SEED });
    const a = client(lobby);
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    const b = client(lobby);
    b.send({ type: 'join', version: PROTOCOL_VERSION, room: ` ${last(a, 'joined')!.room.toLowerCase()} ` });
    expect(last(b, 'joined')!.seat).toBe('p2');
  });

  it('refuses a third player, an unknown room and a mismatched version', () => {
    const { lobby, code } = room();
    const c = client(lobby);
    c.send({ type: 'join', version: PROTOCOL_VERSION, room: code });
    expect(last(c, 'error')!.code).toBe('ROOM_FULL');

    const d = client(lobby);
    d.send({ type: 'join', version: PROTOCOL_VERSION, room: 'ZZZZZZ' });
    expect(last(d, 'error')!.code).toBe('NO_SUCH_ROOM');

    const e = client(lobby);
    e.send({ type: 'create', version: PROTOCOL_VERSION + 1 });
    expect(last(e, 'error')!.code).toBe('VERSION_MISMATCH');
    expect(lobby.roomCount()).toBe(1);
  });

  it('refuses game messages before a room, a second room, and junk', () => {
    const lobby = createLobby();
    const a = client(lobby);
    a.send({ type: 'resign' });
    expect(last(a, 'error')!.code).toBe('NOT_IN_ROOM');
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    expect(last(a, 'error')!.code).toBe('ALREADY_IN_ROOM');
    a.connection.receive('not json');
    expect(last(a, 'error')!.code).toBe('BAD_MESSAGE');
    expect(lobby.roomCount()).toBe(1);
  });

  it('a seat stays reserved after its browser leaves, and the room closes when both have', () => {
    const { lobby, a, b, code } = room();
    a.connection.close();
    expect(last(b, 'opponent')!.present).toBe(false);

    const c = client(lobby);
    c.send({ type: 'join', version: PROTOCOL_VERSION, room: code });
    expect(last(c, 'error')!.code).toBe('ROOM_FULL');

    b.connection.close();
    // Not closed at once: someone may come back (Session 7). See 'reconnecting'.
    expect(lobby.roomCount()).toBe(1);
  });
});

describe('the match', () => {
  it('starts once both setups are in, and each seat gets only its own opening view', () => {
    const { a, b } = room();
    a.send({ type: 'setup', setup: autoSetup('p1') });
    expect(updates(a)).toHaveLength(0); // waiting for p2

    b.send({ type: 'setup', setup: autoSetup('p2') });
    const [opening1] = updates(a);
    const [opening2] = updates(b);
    expect(opening1.view.units.every((u) => u.owner === 'p1')).toBe(true);
    expect(opening2.view.units.every((u) => u.owner === 'p2')).toBe(true);
    expect(opening1.events).toEqual([]);
  });

  it('refuses an illegal setup from the seat that sent it, and lets it try again', () => {
    const { a, b } = room();
    const setup = autoSetup('p1');
    // Everything on one hex: HEX_TAKEN on the second placement.
    a.send({ type: 'setup', setup: setup.map((p) => ({ ...p, hex: setup[0].hex })) });
    expect(last(a, 'error')!.code).toBe('ILLEGAL_SETUP');

    // p2's own setup is not blamed for p1's, and the match still starts.
    b.send({ type: 'setup', setup: autoSetup('p2') });
    expect(b.inbox.some((m) => m.type === 'error')).toBe(false);
    a.send({ type: 'setup', setup });
    expect(updates(a)).toHaveLength(1);
    expect(updates(b)).toHaveLength(1);
  });

  it("refuses the other side's home zone — rules are checked for the connection's own seat", () => {
    const { a } = room();
    a.send({ type: 'setup', setup: autoSetup('p2') });
    expect(last(a, 'error')!.code).toBe('ILLEGAL_SETUP');
  });

  it('a round resolves only when both seats have sent orders', () => {
    const { a, b } = room();
    a.send({ type: 'setup', setup: autoSetup('p1') });
    b.send({ type: 'setup', setup: autoSetup('p2') });

    a.send({ type: 'orders', orders: [] });
    expect(updates(a)).toHaveLength(1);
    b.send({ type: 'orders', orders: [] });
    expect(updates(a)).toHaveLength(2);
    expect(updates(b)).toHaveLength(2);
    expect(updates(a)[1].round).toBe(1);
    expect(updates(a)[1].view.round).toBe(2);
  });

  it("an order naming the enemy's unit is dropped by the engine, not obeyed", () => {
    const { a, b } = room();
    a.send({ type: 'setup', setup: autoSetup('p1') });
    b.send({ type: 'setup', setup: autoSetup('p2') });
    const enemy = updates(b)[0].view.units.find((u) => u.kind === 'launcher')!;

    // p1 tries to walk p2's launcher one hex.
    const destination = { q: enemy.position.q, r: enemy.position.r - 1 };
    a.send({ type: 'orders', orders: [{ type: 'MOVE', unitId: enemy.id, destination }] });
    b.send({ type: 'orders', orders: [] });

    const moved = updates(b)[1].view.units.find((u) => u.id === enemy.id)!;
    expect(moved.position).toEqual(enemy.position);
  });

  it('resigning ends the match for both, with the reveal', () => {
    const { a, b } = room();
    a.send({ type: 'setup', setup: autoSetup('p1') });
    b.send({ type: 'setup', setup: autoSetup('p2') });
    b.send({ type: 'resign' });

    for (const c of [a, b]) {
      const end = updates(c).at(-1)!;
      expect(end.view.phase).toBe('GAME_OVER');
      expect(end.view.outcome).toEqual({ type: 'CAPITULATION', winner: 'p1' });
      expect(end.finalReveal).not.toBeNull();
    }
  });
});

describe('what goes over the wire (spec §6)', () => {
  /**
   * A whole match, both seats played by the MEDIUM CPU from what each seat was
   * sent — which is all a real browser has. Returns both clients plus the
   * updates an authority run directly (no server) produced for the same match.
   */
  function playMatch() {
    const { a, b } = room();
    const seats = { p1: a, p2: b };
    for (const player of PLAYERS) {
      seats[player].send({ type: 'setup', setup: autoSetup(player) });
    }

    // The reference: the same authority the server uses, driven in-process.
    const direct: Record<PlayerId, MatchUpdate[]> = { p1: [], p2: [] };
    const reference = createLocalAuthority(
      { map: generateMap(undefined, undefined, SEED), seed: SEED, seats: HOTSEAT_SEATS, difficulty: 'medium' },
      (u) => {
        for (const player of PLAYERS) if (u[player]) direct[player].push(u[player]!);
      },
    );
    for (const player of PLAYERS) reference.submitSetup(player, autoSetup(player));

    const history: Record<PlayerId, VisibleEvent[]> = { p1: [], p2: [] };
    for (let round = 0; round < 60; round++) {
      const latest = { p1: updates(a).at(-1)!, p2: updates(b).at(-1)! };
      if (latest.p1.view.phase === 'GAME_OVER') break;
      for (const player of PLAYERS) {
        history[player].push(...latest[player].events);
        const orders = cpuOrders(latest[player].view, 'medium', player, makeRng(round * 2 + PLAYERS.indexOf(player)), history[player]);
        reference.submitOrders(player, orders);
        seats[player].send({ type: 'orders', orders });
      }
    }
    return { a, b, direct };
  }

  it('plays a whole match to its end', () => {
    const { a } = playMatch();
    expect(updates(a).at(-1)!.view.phase).toBe('GAME_OVER');
  }, 30_000);

  it('each seat receives exactly its own updates from the authority, and never the other seat\'s', () => {
    const { a, b, direct } = playMatch();
    expect(updates(a)).toEqual(direct.p1);
    expect(updates(b)).toEqual(direct.p2);
    expect(updates(a)).not.toEqual(updates(b));
  }, 30_000);

  it("no enemy unit id reaches a browser except in a public event that names it, or the final reveal", () => {
    const { a, b } = playMatch();
    for (const [me, them, seat] of [[a, b, 'p1'], [b, a, 'p2']] as const) {
      const theirIds = updates(them)[0].view.units.map((u) => u.id);
      for (const raw of me.wire) {
        const message = JSON.parse(raw) as ServerMessage;
        if (message.type !== 'update') continue;
        // Remove the sanctioned places, then look at every remaining byte: the
        // reveal (gotcha 73), and the two PUBLIC events that name a unit (spec
        // §6) — a destroyed asset and a downed drone, both announced to both.
        const rest = { ...message.update, finalReveal: null };
        const events = rest.events.filter(
          (e) => e.type !== 'UNIT_DESTROYED' && e.type !== 'DRONE_DOWNED',
        );
        const scrubbed = JSON.stringify({ ...rest, events });
        for (const id of theirIds) expect(scrubbed).not.toContain(`"${id}"`);
        expect(rest.view.units.every((u) => u.owner === seat)).toBe(true);
      }
    }
  }, 30_000);

  it('the reveal is on the wire only once the match is over', () => {
    const { a } = playMatch();
    const all = updates(a);
    expect(all.slice(0, -1).every((u) => u.finalReveal === null)).toBe(true);
    expect(all.at(-1)!.finalReveal).not.toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// V1.5 Session 7 — the order clock, reconnecting and the empty-room grace
// ---------------------------------------------------------------------------

const TIMING = { orderMs: 25_000, replayMs: 5_000, graceMs: 3_000, roomGraceMs: 120_000 };

/** A started match in a room with fake timers running: both setups are in. */
function startedRoom() {
  const lobby = createLobby({ seed: () => SEED, timing: TIMING });
  const a = client(lobby);
  a.send({ type: 'create', version: PROTOCOL_VERSION });
  const joinedA = last(a, 'joined')!;
  const b = client(lobby);
  b.send({ type: 'join', version: PROTOCOL_VERSION, room: joinedA.room });
  const joinedB = last(b, 'joined')!;
  a.send({ type: 'setup', setup: autoSetup('p1') });
  b.send({ type: 'setup', setup: autoSetup('p2') });
  return { lobby, a, b, code: joinedA.room, tokenA: joinedA.token, tokenB: joinedB.token };
}

describe('the order clock', () => {
  afterEach(() => vi.useRealTimers());

  it('starts when the match does, and tells both seats how long they have', () => {
    vi.useFakeTimers();
    const { a, b } = startedRoom();
    expect(last(a, 'timer')).toEqual({ type: 'timer', msLeft: 25_000 });
    expect(last(b, 'timer')).toEqual({ type: 'timer', msLeft: 25_000 });
  });

  it('a round with events gets the replay allowance on top', () => {
    vi.useFakeTimers();
    const { a, b } = startedRoom();
    a.send({ type: 'orders', orders: [] });
    b.send({ type: 'orders', orders: [] });
    // An all-hold round can be silent; find whichever gave events.
    const busy = updates(a).at(-1)!.events.length > 0 || updates(b).at(-1)!.events.length > 0;
    expect(last(a, 'timer')!.msLeft).toBe(busy ? 30_000 : 25_000);
  });

  it('submits an empty turn for a seat that never sends, and resolves the round', () => {
    vi.useFakeTimers();
    const { a, b } = startedRoom();
    const before = updates(a).length;
    a.send({ type: 'orders', orders: [] });
    expect(updates(a)).toHaveLength(before); // still waiting on b

    vi.advanceTimersByTime(25_000 + 3_000 - 1);
    expect(updates(a)).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(updates(a)).toHaveLength(before + 1);
    expect(updates(b)).toHaveLength(before + 1);
    expect(updates(a).at(-1)!.round).toBe(1);
  });

  it('both seats silent: an empty round for both, and the clock runs again', () => {
    vi.useFakeTimers();
    const { a } = startedRoom();
    const before = updates(a).length;
    vi.advanceTimersByTime(28_000);
    expect(updates(a)).toHaveLength(before + 1);
    expect(last(a, 'timer')!.msLeft).toBeGreaterThanOrEqual(25_000);
  });

  it('does not run in the setup phase, and stops when the match ends', () => {
    vi.useFakeTimers();
    const lobby = createLobby({ seed: () => SEED, timing: TIMING });
    const a = client(lobby);
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    vi.advanceTimersByTime(600_000);
    expect(a.inbox.some((m) => m.type === 'update')).toBe(false);

    const { a: a2, b: b2 } = startedRoom();
    a2.send({ type: 'resign' });
    expect(last(a2, 'timer')).toEqual({ type: 'timer', msLeft: null });
    expect(last(b2, 'timer')).toEqual({ type: 'timer', msLeft: null });
    const n = updates(a2).length;
    vi.advanceTimersByTime(600_000);
    expect(updates(a2)).toHaveLength(n);
  });
});

describe('reconnecting', () => {
  afterEach(() => vi.useRealTimers());

  it('a browser that presents its token takes its seat back and is told it is resumed', () => {
    vi.useFakeTimers();
    const { lobby, a, b, code, tokenA } = startedRoom();
    a.connection.close();
    expect(last(b, 'opponent')!.present).toBe(false);

    const a2 = client(lobby);
    a2.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: tokenA });
    const joined = last(a2, 'joined')!;
    expect(joined.seat).toBe('p1');
    expect(joined.token).toBe(tokenA);
    expect(joined.resumed).toBe(true);
    expect(last(b, 'opponent')!.present).toBe(true);
  });

  it('gets its view and whole log back, equal to what it was sent live', () => {
    vi.useFakeTimers();
    const { lobby, a, b, code, tokenA } = startedRoom();
    for (let i = 0; i < 3; i++) {
      a.send({ type: 'orders', orders: [] });
      b.send({ type: 'orders', orders: [] });
    }
    const live = updates(a);
    a.connection.close();

    const a2 = client(lobby);
    a2.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: tokenA });
    const snap = last(a2, 'snapshot')!;
    expect(snap.view).toEqual(live.at(-1)!.view);
    const liveLog = live.filter((u) => u.events.length > 0).map((u) => ({ round: u.round, events: u.events }));
    expect(snap.log).toEqual(liveLog);
  });

  it('misses no round: what resolved while it was away is in the snapshot', () => {
    vi.useFakeTimers();
    const { lobby, a, b, code, tokenA } = startedRoom();
    a.connection.close();
    b.send({ type: 'orders', orders: [] });
    vi.advanceTimersByTime(28_000); // a's seat times out, the round resolves
    const a2 = client(lobby);
    a2.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: tokenA });
    expect(last(a2, 'snapshot')!.view.round).toBe(updates(b).at(-1)!.view.round);
    expect(last(a2, 'snapshot')!.view.round).toBeGreaterThan(1);
  });

  it('reports whether the seat had already sent this round\'s orders', () => {
    vi.useFakeTimers();
    const { lobby, a, code, tokenA } = startedRoom();
    a.send({ type: 'orders', orders: [] });
    a.connection.close();
    const a2 = client(lobby);
    a2.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: tokenA });
    expect(last(a2, 'joined')!.submitted).toBe(true);
  });

  it('replaces a connection the server has not noticed dying, and the old one cannot unseat it', () => {
    vi.useFakeTimers();
    const { lobby, a, b, code, tokenA } = startedRoom();
    const a2 = client(lobby);
    a2.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: tokenA });
    expect(last(a2, 'joined')!.seat).toBe('p1');
    const opponentMessages = b.inbox.filter((m) => m.type === 'opponent').length;
    a.connection.close(); // the stale one finally dies
    expect(b.inbox.filter((m) => m.type === 'opponent')).toHaveLength(opponentMessages);
    b.send({ type: 'orders', orders: [] });
    a2.send({ type: 'orders', orders: [] });
    expect(updates(a2)).toHaveLength(1); // the round, live — the opening came as the snapshot
  });

  it('a wrong token does not steal a seat, and gets no snapshot', () => {
    vi.useFakeTimers();
    const { lobby, code } = startedRoom();
    const c = client(lobby);
    c.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: 'nope' });
    expect(last(c, 'error')!.code).toBe('ROOM_FULL');
    expect(last(c, 'snapshot')).toBeUndefined();
  });

  it("a returning seat's reveal is the enemy's pieces, from its own snapshot", () => {
    vi.useFakeTimers();
    const { lobby, a, b, code, tokenB } = startedRoom();
    a.send({ type: 'resign' });
    const b2 = client(lobby);
    b2.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: tokenB });
    // b's snapshot is b's view: its reveal is the enemy's pieces, never its own.
    const snap = last(b2, 'snapshot')!;
    expect(snap.finalReveal!.every((u) => u.owner === 'p1')).toBe(true);
    expect(snap.view).toEqual(updates(b).at(-1)!.view);
  });

  it('the snapshot carries no enemy unit id that the live updates did not', () => {
    vi.useFakeTimers();
    const { lobby, a, b, code, tokenA } = startedRoom();
    for (let i = 0; i < 4; i++) {
      a.send({ type: 'orders', orders: [] });
      b.send({ type: 'orders', orders: [] });
    }
    const liveWire = a.wire.join('\n');
    a.connection.close();
    const a2 = client(lobby);
    a2.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: tokenA });
    const ids = new Set(liveWire.match(/p2-[a-z]+-\d+/g) ?? []);
    const snapIds = a2.wire.join('\n').match(/p2-[a-z]+-\d+/g) ?? [];
    for (const id of snapIds) expect(ids.has(id)).toBe(true);
  });

  it('an empty room is kept for the grace period, then closed; coming back saves it', () => {
    vi.useFakeTimers();
    const { lobby, a, b, code, tokenA } = startedRoom();
    a.connection.close();
    b.connection.close();
    expect(lobby.roomCount()).toBe(1);
    vi.advanceTimersByTime(119_000);
    expect(lobby.roomCount()).toBe(1);

    const a2 = client(lobby);
    a2.send({ type: 'join', version: PROTOCOL_VERSION, room: code, token: tokenA });
    expect(last(a2, 'joined')!.resumed).toBe(true);
    vi.advanceTimersByTime(600_000 - 1);
    expect(lobby.roomCount()).toBe(1);
    // ...and the clock restarted for the one who came back.
    expect(last(a2, 'timer')!.msLeft).not.toBeNull();
  });

  it('a room nobody returns to closes after the grace period', () => {
    vi.useFakeTimers();
    const { lobby, a, b } = startedRoom();
    a.connection.close();
    b.connection.close();
    vi.advanceTimersByTime(120_000);
    expect(lobby.roomCount()).toBe(0);
  });

  it('no clock runs in an empty room, so nobody plays a match out alone', () => {
    vi.useFakeTimers();
    const { lobby, a, b } = startedRoom();
    a.connection.close();
    b.connection.close();
    const n = updates(a).length;
    vi.advanceTimersByTime(100_000);
    expect(updates(a)).toHaveLength(n);
    expect(lobby.roomCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// V1.5 Session 8 — limits for a public server, and rooms that do not live forever
// ---------------------------------------------------------------------------

/** A browser that also records being hung up on, at address `ip`. */
function guarded(lobby: ReturnType<typeof createLobby>, ip = '1.2.3.4') {
  const inbox: ServerMessage[] = [];
  let cut = false;
  const connection = lobby.connect(
    {
      send: (message) => inbox.push(JSON.parse(JSON.stringify(message))),
      close: () => {
        cut = true;
      },
    },
    { ip },
  );
  return {
    inbox,
    connection,
    send: (m: unknown) => connection.receive(JSON.stringify(m)),
    errors: () => inbox.flatMap((m) => (m.type === 'error' ? [m.code] : [])),
    isCut: () => cut,
  };
}

describe('rate limits', () => {
  afterEach(() => vi.useRealTimers());

  it('a burst is fine; past it, messages are refused with one warning, and a flood is cut', () => {
    vi.useFakeTimers();
    const lobby = createLobby({ limits: { messageBurst: 5, messagesPerSecond: 1, messageStrikes: 3 } });
    const a = guarded(lobby);
    for (let i = 0; i < 5; i++) a.send({ type: 'resign' });
    expect(a.errors()).toEqual(Array(5).fill('NOT_IN_ROOM'));

    a.send({ type: 'resign' });
    a.send({ type: 'resign' });
    a.send({ type: 'resign' });
    // Refused, but told only once — not an error per message.
    expect(a.errors().filter((code) => code === 'RATE_LIMITED')).toHaveLength(1);
    expect(a.isCut()).toBe(false);
    a.send({ type: 'resign' });
    expect(a.isCut()).toBe(true);
    expect(lobby.refusals()).toMatchObject({ rateLimited: 4, cut: 1 });
  });

  it('the allowance refills with time, so a steady honest pace is never refused', () => {
    vi.useFakeTimers();
    const lobby = createLobby({ limits: { messageBurst: 2, messagesPerSecond: 1 } });
    const a = guarded(lobby);
    for (let i = 0; i < 30; i++) {
      a.send({ type: 'resign' });
      vi.advanceTimersByTime(1000);
    }
    expect(a.errors()).not.toContain('RATE_LIMITED');
  });

  it('counts junk against the allowance too, before reading it', () => {
    const lobby = createLobby({ limits: { messageBurst: 3 } });
    const a = guarded(lobby);
    for (let i = 0; i < 4; i++) a.connection.receive('not json');
    expect(a.errors()).toEqual(['BAD_MESSAGE', 'BAD_MESSAGE', 'BAD_MESSAGE', 'RATE_LIMITED']);
  });

  it('one address may create only so many rooms a minute; another address is unaffected', () => {
    vi.useFakeTimers();
    const lobby = createLobby({ limits: { roomsPerMinutePerIp: 2 } });
    const make = (ip: string) => {
      const c = guarded(lobby, ip);
      c.send({ type: 'create', version: PROTOCOL_VERSION });
      return c;
    };
    make('1.1.1.1');
    make('1.1.1.1');
    expect(make('1.1.1.1').errors()).toEqual(['RATE_LIMITED']);
    expect(make('2.2.2.2').errors()).toEqual([]);
    expect(lobby.roomCount()).toBe(3);

    vi.advanceTimersByTime(60_000);
    expect(make('1.1.1.1').errors()).toEqual([]);
  });

  it('joining is not creating: a full server still lets a player into an existing room', () => {
    const lobby = createLobby({ limits: { maxRooms: 1 } });
    const a = guarded(lobby, '1.1.1.1');
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    const code = (a.inbox.find((m) => m.type === 'joined') as Extract<ServerMessage, { type: 'joined' }>).room;

    const c = guarded(lobby, '3.3.3.3');
    c.send({ type: 'create', version: PROTOCOL_VERSION });
    expect(c.errors()).toEqual(['SERVER_FULL']);

    const b = guarded(lobby, '2.2.2.2');
    b.send({ type: 'join', version: PROTOCOL_VERSION, room: code });
    expect(b.errors()).toEqual([]);
    expect(lobby.refusals().serverFull).toBe(1);
  });
});

describe('room lifetimes', () => {
  afterEach(() => vi.useRealTimers());

  it('a finished match is let go a few minutes after the end, without hanging up on anyone', () => {
    vi.useFakeTimers();
    const lobby = createLobby({ seed: () => SEED, timing: { finishedRoomMs: 300_000 } });
    const a = guarded(lobby, '1.1.1.1');
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    const code = (a.inbox.find((m) => m.type === 'joined') as Extract<ServerMessage, { type: 'joined' }>).room;
    const b = guarded(lobby, '2.2.2.2');
    b.send({ type: 'join', version: PROTOCOL_VERSION, room: code });
    a.send({ type: 'setup', setup: autoSetup('p1') });
    b.send({ type: 'setup', setup: autoSetup('p2') });
    a.send({ type: 'resign' });

    vi.advanceTimersByTime(299_000);
    expect(lobby.roomCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(lobby.roomCount()).toBe(0);
    // The end screen stays up: nobody was cut, and nothing more is sent.
    expect(a.isCut() || b.isCut()).toBe(false);

    const late = guarded(lobby, '3.3.3.3');
    late.send({ type: 'join', version: PROTOCOL_VERSION, room: code });
    expect(late.errors()).toEqual(['NO_SUCH_ROOM']);
    // Leaving a room that has already gone is harmless.
    a.connection.close();
    b.connection.close();
    expect(lobby.roomCount()).toBe(0);
  });

  it('a room past its age limit is closed and its players cut, even mid-setup', () => {
    vi.useFakeTimers();
    const lobby = createLobby({ seed: () => SEED, timing: { maxRoomMs: 7_200_000 } });
    const a = guarded(lobby);
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    vi.advanceTimersByTime(7_199_000);
    expect(lobby.roomCount()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(lobby.roomCount()).toBe(0);
    expect(a.isCut()).toBe(true);
    // Anything the old connection still sends finds no room.
    a.send({ type: 'setup', setup: autoSetup('p1') });
    expect(a.errors().at(-1)).toBe('NO_SUCH_ROOM');
  });

  it('shutdown closes every room and leaves no timer running', () => {
    vi.useFakeTimers();
    const { lobby } = startedRoom();
    lobby.shutdown();
    expect(lobby.roomCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
