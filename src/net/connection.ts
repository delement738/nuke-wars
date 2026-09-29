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
} from './protocol';

/** What the server told us when we got a seat. */
export interface Joined {
  room: string;
  seat: PlayerId;
  token: string;
  seed: number;
  map: MapData;
}

/** Everything the server can say, as callbacks. */
export interface OnlineHandlers {
  joined(joined: Joined): void;
  opponent(present: boolean): void;
  update(update: MatchUpdate): void;
  error(code: ErrorCode): void;
  /** The connection has gone — the server closed, or the network dropped. */
  closed(): void;
}

/** A `MatchAuthority` whose match lives on the server. */
export interface OnlineAuthority extends MatchAuthority {
  /** Leave: close the socket. No handler fires after this. */
  close(): void;
}

/**
 * Connect to `url` and create a room (`room` null) or join one.
 *
 * The `player` argument of each authority call is checked against the seat the
 * server gave us and otherwise ignored: the server knows which seat this
 * connection is, and nothing we send can name another (see `ClientMessage`).
 */
export function connectOnline(
  url: string,
  room: string | null,
  handlers: OnlineHandlers,
): OnlineAuthority {
  const socket = new WebSocket(url);
  let seat: PlayerId | null = null;
  let closed = false;

  // Anything sent before the socket opens waits here, in order.
  const outbox: ClientMessage[] = [
    room === null
      ? { type: 'create', version: PROTOCOL_VERSION }
      : { type: 'join', version: PROTOCOL_VERSION, room },
  ];

  function send(message: ClientMessage): void {
    if (closed) return;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else outbox.push(message);
  }

  socket.addEventListener('open', () => {
    for (const message of outbox.splice(0)) socket.send(JSON.stringify(message));
  });

  socket.addEventListener('message', (event) => {
    if (closed || typeof event.data !== 'string') return;
    const message = parseServerMessage(event.data);
    if (!message) return;
    switch (message.type) {
      case 'joined':
        seat = message.seat;
        handlers.joined({
          room: message.room,
          seat: message.seat,
          token: message.token,
          seed: message.seed,
          map: message.map,
        });
        return;
      case 'opponent':
        handlers.opponent(message.present);
        return;
      case 'update':
        handlers.update(message.update);
        return;
      case 'error':
        handlers.error(message.code);
        return;
    }
  });

  socket.addEventListener('close', () => {
    if (closed) return;
    closed = true;
    handlers.closed();
  });

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
      closed = true;
      socket.close();
    },
  };
}
