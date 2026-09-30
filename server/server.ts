// SERVER — the network front door (V1.5 Session 6).
//
// An HTTP server with a WebSocket endpoint on it. HTTP answers exactly one path,
// `/health` (hosting platforms like Railway ping it to see the server is up);
// everything else is WebSocket traffic, handed straight to the lobby. All the
// game logic is in `./lobby` and below; this file only moves bytes.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { LIMITS } from '../src/net/protocol';
import { createLobby, type Lobby, type LobbyOptions } from './lobby';

export interface RunningServer {
  /** The port it actually listens on — useful when started on port 0. */
  port: number;
  lobby: Lobby;
  /** Cut every connection without stopping the server — a network drop, for tests. */
  dropConnections(): void;
  close(): Promise<void>;
}

export function startServer(port: number, options: LobbyOptions = {}): Promise<RunningServer> {
  const lobby = createLobby(options);

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
  const sockets = new WebSocketServer({ server: http, maxPayload: LIMITS.maxMessageBytes });

  sockets.on('connection', (socket) => {
    const connection = lobby.connect({
      send(message) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      connection.receive(data.toString());
    });
    socket.on('close', () => connection.close());
    // Load-bearing: `ws` reports a bad frame (an oversized message, say) as an
    // 'error' event, and Node treats an 'error' with no listener as a crash —
    // one hostile browser would take down every match on the server. `ws`
    // closes the socket itself afterwards, which runs the 'close' above.
    socket.on('error', (error) => options.log?.(`socket error: ${error.message}`));
  });

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
            for (const client of sockets.clients) client.terminate();
            sockets.close();
            http.close(() => done());
          }),
      });
    });
  });
}
