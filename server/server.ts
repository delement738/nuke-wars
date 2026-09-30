// SERVER — the network front door (V1.5 Session 6).
//
// An HTTP server with a WebSocket endpoint on it. HTTP answers exactly one path,
// `/health` (hosting platforms like Railway ping it to see the server is up);
// everything else is WebSocket traffic, handed straight to the lobby. All the
// game logic is in `./lobby` and below; this file only moves bytes.
//
// **Session 8 puts a doorman on it** (the rules are in `./guard`). A handshake
// is refused before it becomes a WebSocket when it comes from a page on another
// website, or from an address that already holds its share of connections.
// Every open connection is pinged on a timer and one that stops answering is cut,
// so a laptop that went to sleep mid-match does not hold its seat forever — and
// the traffic keeps the host's proxy from closing a quiet connection. A stats
// line goes to the log on a timer.

import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIMITS } from '../src/net/protocol';
import { DEFAULT_LIMITS, clientIp, createIpLedger, originAllowed } from './guard';
import { createLobby, type Lobby, type LobbyOptions } from './lobby';

export interface ServerOptions extends LobbyOptions {
  /** Origins whose pages may connect (`parseOrigins` in `./guard`). Empty: anyone — local development. */
  allowedOrigins?: string[];
  /** Read the visitor's address from `X-Forwarded-For` — only behind a known proxy (Railway). */
  trustProxy?: boolean;
  /** How often every connection is pinged; one that has not answered since the last ping is cut. */
  pingMs?: number;
  /** How often a stats line is logged; 0 turns it off. */
  statsMs?: number;
}

export interface RunningServer {
  /** The port it actually listens on — useful when started on port 0. */
  port: number;
  lobby: Lobby;
  /** Cut every connection without stopping the server — a network drop, for tests. */
  dropConnections(): void;
  close(): Promise<void>;
}

/** Refuse a handshake with a plain HTTP status, before any WebSocket exists. */
function refuse(socket: Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function startServer(port: number, options: ServerOptions = {}): Promise<RunningServer> {
  const lobby = createLobby(options);
  const log = options.log ?? (() => {});
  const allowed = options.allowedOrigins ?? [];
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const ledger = createIpLedger(limits);
  const refused = { origin: 0, busyAddress: 0 };
  /** Whether each socket has answered since the last ping. */
  const alive = new WeakMap<WebSocket, boolean>();

  const http = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }
    response.writeHead(404);
    response.end();
  });

  // `maxPayload` makes `ws` drop an oversized message before we ever parse it.
  // `noServer`: the handshake comes through the 'upgrade' handler below first.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });

  http.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    // Counted, not logged one by one: a flood of refusals must not become a flood of log lines.
    if (!originAllowed(request.headers.origin, allowed)) {
      refused.origin += 1;
      return refuse(socket, '403 Forbidden');
    }
    const ip = clientIp(request.headers, request.socket.remoteAddress, options.trustProxy ?? false);
    if (!ledger.openConnection(ip)) {
      refused.busyAddress += 1;
      return refuse(socket, '429 Too Many Requests');
    }
    sockets.handleUpgrade(request, socket, head, (ws) => welcome(ws, ip));
  });

  function welcome(socket: WebSocket, ip: string): void {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));

    const connection = lobby.connect(
      {
        send(message) {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
        },
        close: () => socket.terminate(),
      },
      { ip },
    );
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      connection.receive(data.toString());
    });
    socket.on('close', () => {
      ledger.closeConnection(ip);
      connection.close();
    });
    // Load-bearing: `ws` reports a bad frame (an oversized message, say) as an
    // 'error' event, and Node treats an 'error' with no listener as a crash —
    // one hostile browser would take down every match on the server. `ws`
    // closes the socket itself afterwards, which runs the 'close' above.
    socket.on('error', (error) => log(`socket error: ${error.message}`));
  }

  // A browser answers a ping by itself (the WebSocket standard requires it), so
  // a socket that has not answered one whole interval later is not coming back.
  const pinger = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!alive.get(socket)) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, options.pingMs ?? 30_000);

  const statsMs = options.statsMs ?? 5 * 60_000;
  const stats =
    statsMs > 0
      ? setInterval(() => {
          const r = lobby.refusals();
          log(
            `stats: ${lobby.roomCount()} rooms, ${sockets.clients.size} connections; ` +
              `refused since start: ${refused.origin} wrong origin, ${refused.busyAddress} busy address, ` +
              `${r.rateLimited} rate-limited, ${r.serverFull} server full, ${r.cut} cut`,
          );
        }, statsMs)
      : null;

  return new Promise((resolve) => {
    http.listen(port, () => {
      resolve({
        port: (http.address() as AddressInfo).port,
        lobby,
        dropConnections() {
          for (const client of sockets.clients) client.terminate();
        },
        close: () =>
          new Promise<void>((done) => {
            clearInterval(pinger);
            if (stats) clearInterval(stats);
            for (const client of sockets.clients) client.terminate();
            lobby.shutdown();
            sockets.close();
            http.close(() => done());
          }),
      });
    });
  });
}
