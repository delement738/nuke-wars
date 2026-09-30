// V1.5 Session 7, end to end: the order clock and reconnecting, over real
// sockets, with the browser's own store on one side and a raw socket as the
// opponent.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map';
import { setupRng } from '../src/state/authority';
import {
  autoPlace,
  endTurn,
  logFor,
  matchStore,
  newMatch,
  orderTimeExpired,
  playOnline,
  viewFor,
} from '../src/state/match';
import { sandboxSetup } from '../src/state/sandbox';
import { loadSeat } from '../src/net/session';
import { PROTOCOL_VERSION, type ServerMessage } from '../src/net/protocol';
import { startServer, type RunningServer } from './server';

const SEED = 11;
let server: RunningServer;
let url: string;

/** `sessionStorage` for Node: one tab's worth. */
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  };
});

async function until(check: () => boolean, what = 'condition', ms = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function raw() {
  const socket = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  socket.addEventListener('message', (e) => inbox.push(JSON.parse(String(e.data))));
  await new Promise((r) => socket.addEventListener('open', r));
  return {
    socket,
    inbox,
    send: (m: unknown) => socket.send(JSON.stringify(m)),
  };
}

function setupFor(player: 'p1' | 'p2') {
  return sandboxSetup(generateMap(undefined, undefined, SEED), player, setupRng(SEED, player));
}

/** The store as p1 against a raw p2, both set up, round 1 waiting for orders. */
async function startedMatch() {
  playOnline(url, null);
  await until(() => matchStore.getState().online?.status === 'open', 'joined');
  const room = matchStore.getState().online!.room!;
  const b = await raw();
  b.send({ type: 'join', version: PROTOCOL_VERSION, room });
  await until(() => matchStore.getState().online?.opponentPresent === true, 'opponent');
  autoPlace();
  b.send({ type: 'setup', setup: setupFor('p2') });
  await until(() => viewFor('p1') !== null, 'match started');
  return { b, room };
}

describe('the order clock, end to end', () => {
  beforeEach(async () => {
    server = await startServer(0, {
      seed: () => SEED,
      timing: { orderMs: 400, replayMs: 0, graceMs: 200, roomGraceMs: 5000 },
    });
    url = `ws://localhost:${server.port}`;
  });
  afterEach(async () => {
    newMatch();
    await server.close();
  });

  it('gives the store a deadline, and stops it once the orders are in', async () => {
    const { b } = await startedMatch();
    const ends = matchStore.getState().online!.timerEndsAt!;
    expect(ends).toBeGreaterThan(Date.now());
    expect(ends).toBeLessThanOrEqual(Date.now() + 400);
    b.socket.close();
  });

  it('the browser sends its draft when the clock hits zero', async () => {
    const { b } = await startedMatch();
    expect(matchStore.getState().online!.submitted).toBe(false);
    orderTimeExpired();
    expect(matchStore.getState().online!.submitted).toBe(true);
    orderTimeExpired(); // a second call does nothing
    b.socket.close();
  });

  it('the server sends an empty turn for a silent opponent, so the round resolves', async () => {
    const { b } = await startedMatch();
    endTurn(); // the store sends; the raw opponent never does
    await until(() => viewFor('p1')!.round === 2, 'timed-out round', 3000);
    expect(matchStore.getState().online!.submitted).toBe(false);
    expect(matchStore.getState().online!.timerEndsAt).not.toBeNull();
    b.socket.close();
  });
});

describe('coming back to a match that moved on', () => {
  beforeEach(async () => {
    server = await startServer(0, {
      seed: () => SEED,
      timing: { orderMs: 300, replayMs: 0, graceMs: 100, roomGraceMs: 5000 },
    });
    url = `ws://localhost:${server.port}`;
  });
  afterEach(async () => {
    newMatch();
    await server.close();
  });

  it('the round that timed out while away is in the snapshot', async () => {
    const { b } = await startedMatch();
    const saved = loadSeat()!;
    newMatch(); // the tab goes away (its seat is still held on the server)
    b.send({ type: 'orders', orders: [] });
    await new Promise((r) => setTimeout(r, 700)); // our seat times out; round 1 resolves
    playOnline(url, saved.room, saved.token);
    await until(() => (viewFor('p1')?.round ?? 0) >= 2, 'caught up');
    expect(matchStore.getState().online!.seat).toBe('p1');
    expect(logFor('p1').length).toBeGreaterThan(0);
    b.socket.close();
  });
});

describe('reconnecting, end to end', () => {
  beforeEach(async () => {
    server = await startServer(0, {
      seed: () => SEED,
      timing: { orderMs: 60_000, replayMs: 0, graceMs: 0, roomGraceMs: 60_000 },
    });
    url = `ws://localhost:${server.port}`;
  });
  afterEach(async () => {
    newMatch();
    await server.close();
  });

  it('remembers its seat, and forgets it on leaving', async () => {
    const { b, room } = await startedMatch();
    expect(loadSeat()?.room).toBe(room);
    b.socket.close();
    newMatch();
    expect(loadSeat()).toBeNull();
  });

  it('a dropped connection is retried and the seat comes back, drafts and all', async () => {
    const { b } = await startedMatch();
    const viewBefore = viewFor('p1');
    server.dropConnections();
    await until(() => matchStore.getState().online?.status === 'reconnecting', 'reconnecting');
    // Locked while cut off: nothing may be sent.
    endTurn();
    expect(matchStore.getState().online!.submitted).toBe(false);

    await until(() => matchStore.getState().online?.status === 'open', 'back');
    expect(viewFor('p1')).toBe(viewBefore); // a wobble that missed nothing changes nothing
    expect(matchStore.getState().online!.seat).toBe('p1');
    expect(matchStore.getState().online!.timerEndsAt).not.toBeNull();
    b.socket.close();
  });

  it('a reloaded tab takes its seat back from the saved token and rebuilds the match', async () => {
    const { b, room } = await startedMatch();
    // Play a round so there is a log and a round to catch up on.
    endTurn();
    b.send({ type: 'orders', orders: [] });
    await until(() => viewFor('p1')!.round === 2, 'round 2');
    const view = viewFor('p1')!;
    const log = logFor('p1');
    const saved = loadSeat()!;

    // "Reload": drop the store's state and connection, then come back by token.
    newMatch();
    expect(viewFor('p1')).toBeNull();
    playOnline(url, saved.room, saved.token);
    await until(() => viewFor('p1') !== null, 'snapshot');
    expect(saved.room).toBe(room);
    expect(viewFor('p1')).toEqual(view);
    expect(logFor('p1')).toEqual(log);
    expect(matchStore.getState().online!.seat).toBe('p1');
    b.socket.close();
  });

  it('a room that has closed is reported, and the saved seat is dropped', async () => {
    playOnline(url, 'ZZZZZZ', 'stale-token');
    await until(() => matchStore.getState().online?.error === 'NO_SUCH_ROOM', 'error');
    await until(() => matchStore.getState().online?.status === 'closed', 'closed');
    expect(loadSeat()).toBeNull();
  });
});
