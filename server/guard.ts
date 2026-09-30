// SERVER — the rules for who may come in, and how fast (V1.5 Session 8).
//
// A public server is reachable by anyone, not only by our page. This file holds
// the small, pure pieces that keep one visitor from spoiling it for everyone:
// which websites may open a connection (the origin check), who a visitor is
// (their IP address, as the host's proxy reports it) and how fast they may go
// (token buckets and per-address counts).
//
// Deliberately free of sockets and timers, and every clock is passed in, so all
// of it is tested with plain numbers. `./server` applies the connection-level
// rules at the door; `./lobby` applies the message and room-creation ones.

import type { IncomingHttpHeaders } from 'node:http';

/** How much a visitor may do. Generous next to an honest browser; see `docs/protocol.md`. */
export interface Limits {
  /** Messages one connection may send in a burst… */
  messageBurst: number;
  /** …and how fast that allowance refills, per second. */
  messagesPerSecond: number;
  /** Messages dropped past the allowance before the connection is cut. */
  messageStrikes: number;
  /** Connections one IP address may hold open at once. */
  connectionsPerIp: number;
  /** Rooms one IP address may create per minute. */
  roomsPerMinutePerIp: number;
  /** Rooms the whole server may hold open at once. */
  maxRooms: number;
}

/** Designer's approval, 2026-09-30. An honest match sends a message every few seconds at most. */
export const DEFAULT_LIMITS: Limits = {
  messageBurst: 20,
  messagesPerSecond: 5,
  messageStrikes: 20,
  connectionsPerIp: 8,
  roomsPerMinutePerIp: 10,
  maxRooms: 500,
};

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

/**
 * The `ALLOWED_ORIGINS` setting as a list: comma-separated origins, each of
 * which may use `*` for "any run of characters" (for Vercel's preview links,
 * whose names change with every pull request). Empty or unset means no check,
 * which is what local development wants.
 */
export function parseOrigins(setting: string | undefined): string[] {
  return (setting ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0);
}

/**
 * Whether a page from `origin` may connect. A browser always sends the page's
 * origin with a WebSocket handshake and a page cannot forge it, so this stops
 * another website from quietly opening games on our server from its visitors'
 * browsers. (A script outside a browser can send any origin it likes; the rate
 * limits are what stand in its way.)
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (!origin) return false;
  return allowed.some((pattern) => {
    const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^${escaped.join('[^/]*')}$`, 'i').test(origin);
  });
}

// ---------------------------------------------------------------------------
// Who is this?
// ---------------------------------------------------------------------------

/**
 * The visitor's IP address. Behind a hosting proxy (Railway) every connection
 * arrives from the proxy itself, so the real address is the one the proxy
 * writes into `X-Forwarded-For`. We take the **last** entry: a proxy appends
 * what it saw, and anything earlier in the list was written by the visitor and
 * could be made up to dodge the per-address limits. `trustProxy` is only turned
 * on where a proxy is known to be in front (`TRUST_PROXY=1` on Railway); run
 * without one, the header is ignored because anyone could send it.
 */
export function clientIp(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const header = headers['x-forwarded-for'];
    const list = (Array.isArray(header) ? header.join(',') : (header ?? ''))
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const last = list.at(-1);
    if (last) return last;
  }
  return remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// How fast?
// ---------------------------------------------------------------------------

/**
 * A token bucket: holds up to `burst` tokens, refills at `perSecond`, and each
 * action spends one. A burst is fine, a steady flood is not.
 */
export interface Bucket {
  /** Spend a token if there is one; false means "too fast". */
  take(now: number): boolean;
}

export function createBucket(burst: number, perSecond: number, now: number): Bucket {
  let tokens = burst;
  let last = now;
  return {
    take(at) {
      tokens = Math.min(burst, tokens + ((at - last) / 1000) * perSecond);
      last = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/** Per-IP bookkeeping: open connections, and recent room creations. */
export interface IpLedger {
  /** A connection from `ip` wants in; false if it already holds its share. */
  openConnection(ip: string): boolean;
  closeConnection(ip: string): void;
  /** `ip` wants a new room; false if it has made its share this last minute. */
  createRoom(ip: string, now: number): boolean;
}

export function createIpLedger(limits: Pick<Limits, 'connectionsPerIp' | 'roomsPerMinutePerIp'>): IpLedger {
  const connections = new Map<string, number>();
  const creations = new Map<string, number[]>();
  return {
    openConnection(ip) {
      const open = connections.get(ip) ?? 0;
      if (open >= limits.connectionsPerIp) return false;
      connections.set(ip, open + 1);
      return true;
    },
    closeConnection(ip) {
      const open = (connections.get(ip) ?? 0) - 1;
      // Deleted at zero, so the map holds only addresses that are here now.
      if (open <= 0) connections.delete(ip);
      else connections.set(ip, open);
    },
    createRoom(ip, now) {
      const recent = (creations.get(ip) ?? []).filter((at) => now - at < 60_000);
      if (recent.length >= limits.roomsPerMinutePerIp) {
        creations.set(ip, recent);
        return false;
      }
      recent.push(now);
      creations.set(ip, recent);
      // Old entries are pruned on the next visit; an address that never comes
      // back leaves one short list behind, which the sweep below clears.
      if (creations.size > 10_000) {
        for (const [key, times] of creations) {
          if (times.every((at) => now - at >= 60_000)) creations.delete(key);
        }
      }
      return true;
    },
  };
}
