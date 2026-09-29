import { describe, expect, it } from 'vitest';
import { generateMap, makeRng } from '../src/sim/map';
import { PLAYERS, type PlayerId, type VisibleEvent } from '../src/sim/types';
import { createLocalAuthority, setupRng, type MatchUpdate } from '../src/state/authority';
import { cpuOrders } from '../src/state/cpu';
import { sandboxSetup } from '../src/state/sandbox';
import { HOTSEAT_SEATS } from '../src/state/seats';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/net/protocol';
import { createLobby, type Connection } from './lobby';

const SEED = 7;

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
  const lobby = createLobby({ seed: () => SEED });
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
    expect(lobby.roomCount()).toBe(0);
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
