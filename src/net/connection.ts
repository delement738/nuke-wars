// NETWORK — the browser's end of an online match (V1.5 Session 6).
//
// `connectOnline` opens a WebSocket to the match server and returns a
// `MatchAuthority` — the same three calls the store makes on the in-process one
// (gotcha 77). The store therefore plays an online match exactly as it plays a
// local one; the only differences are that the answer arrives *later*, and that
// it is only ever this seat's.
//
// This file holds no match state at all. It turns calls into messages and
// messages into handler calls, and that is the whole job.
//
// Layering: client networking. The browser's `WebSocket` and the protocol, no
// React and no store (the store imports this, never the reverse).

import type { MapData } from '../sim/map';
import type { PlayerId } from '../sim/types';
import type { MatchAuthority, MatchUpdate } from '../state/authority';
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from './protocol';

/** What the server told us when we got a seat. */
export interface Joined {
  room: string;
  seat: PlayerId;
  token: string;
  seed: number;
  map: MapData;
  /** This connection took back a seat it held before (a reconnect or a reload). */
  resumed: boolean;
  /** The seat has already handed in what is owed now (its setup, or this round's orders). */
  submitted: boolean;
}

/** What a returning seat is sent to rebuild its picture. */
export type Snapshot = Extract<ServerMessage, { type: 'snapshot' }>;

/** Everything the server can say, as callbacks. */
export interface OnlineHandlers {
  joined(joined: Joined): void;
  opponent(present: boolean): void;
  update(update: MatchUpdate): void;
  snapshot(snapshot: Snapshot): void;
  /** How long the round's orders may still be sent, or null when no clock runs. */
  timer(msLeft: number | null): void;
  error(code: ErrorCode): void;
  /** The link dropped after we had a seat; we are trying to get it back. */
  reconnecting(): void;
  /** The connection is gone for good: refused, out of retries, or the server closed. */
  closed(): void;
}

/** A `MatchAuthority` whose match lives on the server. */
export interface OnlineAuthority extends MatchAuthority {
  /** Leave: close the socket. No handler fires after this. */
  close(): void;
}

/** How a connection retries after the link drops. */
export interface RetryPlan {
  /** Wait before retry number `attempt` (1-based), in milliseconds. */
  delayMs(attempt: number): number;
  /** Stop trying this long after the link dropped — the server's grace period is 2 minutes. */
  giveUpAfterMs: number;
}

export const DEFAULT_RETRY: RetryPlan = {
  delayMs: (attempt) => Math.min(500 * 2 ** (attempt - 1), 5000),
  giveUpAfterMs: 100_000,
};

/** Which room to enter, and the token of the seat to take back if this browser held one. */
export interface Target {
  /** Null creates a room; a code joins one. */
  room: string | null;
  token?: string;
}

/**
 * Connect to `url` and create a room (`room` null) or join one — taking back
 * our old seat if `token` is one the room knows.
 *
 * Once we hold a seat, a dropped link is not the end: the connection keeps
 * trying to get the seat back (`RetryPlan`), presenting the token, and tells
 * the store only `reconnecting` until it succeeds (another `joined`, with
 * `resumed`) or gives up (`closed`).
 *
 * The `player` argument of each authority call is checked against the seat the
 * server gave us and otherwise ignored: the server knows which seat this
 * connection is, and nothing we send can name another (see `ClientMessage`).
 */
export function connectOnline(
  url: string,
  target: Target,
  handlers: OnlineHandlers,
  retry: RetryPlan = DEFAULT_RETRY,
): OnlineAuthority {
  let socket: WebSocket | null = null;
  let seat: PlayerId | null = null;
  let room = target.room;
  let token = target.token;
  /** Whether the server has answered the current socket's first message. */
  let joined = false;
  /** Set when the server refused a retry, or we chose to leave. */
  let done = false;
  let attempt = 0;
  let droppedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function first(): ClientMessage {
    if (room === null) return { type: 'create', version: PROTOCOL_VERSION };
    return token
      ? { type: 'join', version: PROTOCOL_VERSION, room, token }
      : { type: 'join', version: PROTOCOL_VERSION, room };
  }

  function send(message: ClientMessage): void {
    if (done || !joined || socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function finish(): void {
    if (done) return;
    done = true;
    handlers.closed();
  }

  function open(): void {
    const mine = new WebSocket(url);
    socket = mine;
    joined = false;

    mine.addEventListener('open', () => {
      if (socket === mine) mine.send(JSON.stringify(first()));
    });

    mine.addEventListener('message', (event) => {
      if (done || socket !== mine || typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      switch (message.type) {
        case 'joined':
          joined = true;
          attempt = 0;
          seat = message.seat;
          room = message.room;
          token = message.token;
          handlers.joined({
            room: message.room,
            seat: message.seat,
            token: message.token,
            seed: message.seed,
            map: message.map,
            resumed: message.resumed,
            submitted: message.submitted,
          });
          return;
        case 'opponent':
          handlers.opponent(message.present);
          return;
        case 'update':
          handlers.update(message.update);
          return;
        case 'snapshot':
          handlers.snapshot(message);
          return;
        case 'timer':
          handlers.timer(message.msLeft);
          return;
        case 'error':
          handlers.error(message.code);
          // A refusal before we hold a seat on this socket (the room is gone or
          // full, the server was updated) will not change on the next try.
          if (!joined) {
            mine.close();
            finish();
          }
          return;
      }
    });

    mine.addEventListener('close', () => {
      if (done || socket !== mine) return;
      // Never had a seat: nothing to get back, so this is the end.
      if (seat === null) return finish();
      if (joined || attempt === 0) {
        droppedAt = Date.now();
        handlers.reconnecting();
      }
      joined = false;
      attempt += 1;
      const wait = retry.delayMs(attempt);
      if (Date.now() - droppedAt + wait > retry.giveUpAfterMs) return finish();
      timer = setTimeout(open, wait);
    });
  }

  open();

  return {
    submitSetup(player, setup) {
      if (player === seat) send({ type: 'setup', setup: [...setup] });
    },
    submitOrders(player, orders) {
      if (player === seat) send({ type: 'orders', orders: [...orders] });
    },
    resign(player) {
      if (player === seat) send({ type: 'resign' });
    },
    close() {
      done = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
  };
}
