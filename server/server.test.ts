// End to end over real sockets: the server on a free port, and on the other side
// either raw WebSockets or the browser's own store (`src/state/match.ts`), which
// is exactly the code a player's tab runs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map';
import { opponentOf, type PlayerId } from '../src/sim/types';
import { setupRng } from '../src/state/authority';
import {
  autoPlace,
  endTurn,
  logFor,
  matchStore,
  newMatch,
  placeHex,
  playOnline,
  resign,
  viewFor,
} from '../src/state/match';
import { sandboxSetup } from '../src/state/sandbox';
import { LIMITS, PROTOCOL_VERSION, type ServerMessage } from '../src/net/protocol';
import { startServer, type RunningServer } from './server';

const SEED = 11;
let server: RunningServer;
let url: string;

beforeEach(async () => {
  server = await startServer(0, { seed: () => SEED });
  url = `ws://localhost:${server.port}`;
});

afterEach(async () => {
  newMatch(); // closes the store's connection, if a test opened one
  await server.close();
});

/** Poll until `check` passes or two seconds go by. */
async function until(check: () => boolean, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A raw browser: a socket and everything it has been sent. */
async function raw() {
  const socket = new WebSocket(url);
  const inbox: ServerMessage[] = [];
  socket.addEventListener('message', (e) => inbox.push(JSON.parse(String(e.data))));
  await new Promise((r) => socket.addEventListener('open', r));
  return {
    socket,
    inbox,
    send: (m: unknown) => socket.send(typeof m === 'string' ? m : JSON.stringify(m)),
    got: (type: ServerMessage['type']) => inbox.filter((m) => m.type === type),
  };
}

function setupFor(player: PlayerId) {
  return sandboxSetup(generateMap(undefined, undefined, SEED), player, setupRng(SEED, player));
}

describe('the server over real sockets', () => {
  it('answers /health for the host platform', async () => {
    const response = await fetch(`http://localhost:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('two browsers make a room, set up and resolve a round', async () => {
    const a = await raw();
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    await until(() => a.got('joined').length === 1, 'a joined');
    const code = (a.got('joined')[0] as Extract<ServerMessage, { type: 'joined' }>).room;

    const b = await raw();
    b.send({ type: 'join', version: PROTOCOL_VERSION, room: code });
    await until(() => b.got('joined').length === 1, 'b joined');

    a.send({ type: 'setup', setup: setupFor('p1') });
    b.send({ type: 'setup', setup: setupFor('p2') });
    await until(() => a.got('update').length === 1 && b.got('update').length === 1, 'opening');

    a.send({ type: 'orders', orders: [] });
    b.send({ type: 'orders', orders: [] });
    await until(() => a.got('update').length === 2 && b.got('update').length === 2, 'round 1');
    a.socket.close();
    b.socket.close();
  });

  it('answers junk with an error and drops an oversized message without crashing', async () => {
    const a = await raw();
    a.send('{"type":');
    await until(() => a.got('error').length === 1, 'error');
    expect(a.got('error')[0]).toEqual({ type: 'error', code: 'BAD_MESSAGE' });

    const closed = new Promise((r) => a.socket.addEventListener('close', r));
    a.send('x'.repeat(LIMITS.maxMessageBytes + 1));
    await closed; // `ws` hangs up on a message over maxPayload

    const b = await raw();
    b.send({ type: 'create', version: PROTOCOL_VERSION });
    await until(() => b.got('joined').length === 1, 'server still up');
    b.socket.close();
  });

  it('tells the other seat when a browser leaves', async () => {
    const a = await raw();
    a.send({ type: 'create', version: PROTOCOL_VERSION });
    await until(() => a.got('joined').length === 1);
    const code = (a.got('joined')[0] as Extract<ServerMessage, { type: 'joined' }>).room;
    const b = await raw();
    b.send({ type: 'join', version: PROTOCOL_VERSION, room: code });
    await until(() => a.got('opponent').length === 2);

    b.socket.close();
    await until(() => a.got('opponent').length === 3, 'left notice');
    expect(a.got('opponent').at(-1)).toEqual({ type: 'opponent', present: false });
    a.socket.close();
  });
});

describe('the store playing online', () => {
  /** The store creates a room; a raw socket joins it as the opponent. */
  async function storeVsRaw() {
    playOnline(url, null);
    await until(() => matchStore.getState().online?.status === 'open', 'store joined');
    const { online } = matchStore.getState();
    const b = await raw();
    b.send({ type: 'join', version: PROTOCOL_VERSION, room: online!.room });
    await until(() => matchStore.getState().online?.opponentPresent === true, 'opponent');
    return b;
  }

  it('takes the board and seat from the server', async () => {
    const b = await storeVsRaw();
    const state = matchStore.getState();
    expect(state.seed).toBe(SEED);
    expect(state.map).toEqual(generateMap(undefined, undefined, SEED));
    expect(state.online?.seat).toBe('p1');
    expect(state.seats).toEqual({ p1: 'human', p2: 'remote' });
    b.socket.close();
  });

  it('sends the setup, locks the board, and starts when the opponent is ready', async () => {
    const b = await storeVsRaw();
    autoPlace();
    expect(matchStore.getState().online?.submitted).toBe(true);

    // Locked while waiting: a click on the board places nothing.
    const before = matchStore.getState().placed;
    placeHex(setupFor('p1')[0].hex);
    expect(matchStore.getState().placed).toBe(before);
    expect(viewFor('p1')).toBeNull();

    b.send({ type: 'setup', setup: setupFor('p2') });
    await until(() => viewFor('p1') !== null, 'opening update');
    expect(matchStore.getState().online?.submitted).toBe(false);
    // This browser holds its own seat's view and nothing of the other's.
    expect(viewFor('p2')).toBeNull();
    expect(viewFor('p1')!.units.every((u) => u.owner === 'p1')).toBe(true);
    b.socket.close();
  });

  it('ending the turn sends orders and waits; the round resolves when the opponent sends theirs', async () => {
    const b = await storeVsRaw();
    autoPlace();
    b.send({ type: 'setup', setup: setupFor('p2') });
    await until(() => viewFor('p1') !== null);

    endTurn();
    expect(matchStore.getState().online?.submitted).toBe(true);
    expect(viewFor('p1')!.round).toBe(1);

    b.send({ type: 'orders', orders: [] });
    await until(() => viewFor('p1')!.round === 2, 'round resolved');
    expect(matchStore.getState().online?.submitted).toBe(false);
    b.socket.close();
  });

  it('resigning online ends the match, with the reveal of the other side only', async () => {
    const b = await storeVsRaw();
    autoPlace();
    b.send({ type: 'setup', setup: setupFor('p2') });
    await until(() => viewFor('p1') !== null);

    resign('p1');
    await until(() => viewFor('p1')!.phase === 'GAME_OVER', 'game over');
    expect(viewFor('p1')!.outcome).toEqual({ type: 'CAPITULATION', winner: opponentOf('p1') });
    expect(logFor('p1').at(-1)!.event.type).toBe('GAME_OVER');
    const reveal = matchStore.getState().finalReveal?.p1;
    expect(reveal?.every((u) => u.owner === 'p2')).toBe(true);
    b.socket.close();
  });

  it('shows the opponent leaving, and a closed connection', async () => {
    const b = await storeVsRaw();
    b.socket.close();
    await until(() => matchStore.getState().online?.opponentPresent === false, 'opponent left');

    // The link dropping is not the end any more (Session 7): the store keeps
    // trying to get its seat back, and says so.
    await server.close();
    await until(() => matchStore.getState().online?.status === 'reconnecting', 'reconnecting');
    server = await startServer(0); // for afterEach
  });

  it('reports a room that does not exist', async () => {
    playOnline(url, 'ZZZZZZ');
    await until(() => matchStore.getState().online?.error === 'NO_SUCH_ROOM', 'error');
  });

  it('leaving (a new local board) closes the room', async () => {
    const b = await storeVsRaw();
    newMatch();
    expect(matchStore.getState().online).toBeNull();
    expect(matchStore.getState().seats).toEqual({ p1: 'human', p2: 'cpu' });
    await until(() => b.got('opponent').at(-1)?.type === 'opponent' && !(b.got('opponent').at(-1) as { present: boolean }).present, 'left');
    b.socket.close();
  });
});
