// NETWORK — the wire protocol between a browser and the match server
// (V1.5 Session 6). Written up for humans in `docs/protocol.md`.
//
// Shared by both ends: the server (`server/`) imports it to read what browsers
// send, and the client (`./connection`) imports it to read what the server
// sends. So it may import only *types* from the game and nothing from React,
// Pixi, the DOM or Node — the same discipline as `src/sim/`.
//
// **It is `MatchAuthority` on a wire** (gotcha 77). The three calls a store makes
// on an authority — setup, orders, resign — become three client messages, and
// the one thing an authority sends back — a `MatchUpdate` — becomes the `update`
// message. Everything else here is rooms: getting two browsers into one match.
//
// **Every message a browser sends is untrusted.** `parseClientMessage` is the
// only door into the server, and it checks the *shape* of everything: field
// types, sizes, integer hex coordinates. It deliberately does not check the
// *rules* — whether a hex is in your home zone, whether that launcher is yours.
// The sim's own validators do that, on the server, exactly as they do for a
// local game, so a hand-crafted message is held to the same rules as a click.

import type { MatchUpdate } from '../state/authority';
import type { MapData } from '../sim/map';
import type { Hex } from '../sim/hex';
import type { Placement, PlayerSetup } from '../sim/setup';
import type { Order, PlayerId, Unit, VisibleEvent, VisibleGameState } from '../sim/types';

/**
 * Bumped whenever a message changes shape. The client (Vercel) and the server
 * (Railway) are deployed separately, so for a few minutes after a release one
 * can be newer than the other; a mismatch is refused up front with a clear
 * error instead of failing somewhere strange mid-match.
 */
export const PROTOCOL_VERSION = 3;

/** A room code: short enough to read aloud, no 0/O or 1/I to confuse. */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

// ---------------------------------------------------------------------------
// Browser -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** Open a new room and take its first seat. */
  | { type: 'create'; version: number }
  /**
   * Take the free seat in an existing room (the link someone shared) — or, with
   * the `token` a `joined` message once gave this browser, take back the seat it
   * held (V1.5 Session 7's reconnect). A token that matches no seat is ignored
   * and the join is an ordinary one.
   */
  | { type: 'join'; version: number; room: string; token?: string }
  /** `MatchAuthority.submitSetup` for this connection's seat. */
  | { type: 'setup'; setup: PlayerSetup }
  /** `MatchAuthority.submitOrders` for this connection's seat. */
  | { type: 'orders'; orders: Order[] }
  /** `MatchAuthority.resign` for this connection's seat. */
  | { type: 'resign' };

// Notice what is NOT in any of these: a player id. A connection speaks for the
// seat the server gave it on `create`/`join`, and nothing it sends can name a
// different one. That is the network form of "each client speaks only for its
// own seat" — made impossible to get wrong rather than checked.

// ---------------------------------------------------------------------------
// Server -> browser
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'BAD_MESSAGE' // not JSON, or not a shape this protocol has
  | 'VERSION_MISMATCH' // client and server were built from different protocols
  | 'NO_SUCH_ROOM' // the link's room does not exist (or has closed)
  | 'ROOM_FULL' // both seats are taken
  | 'NOT_IN_ROOM' // a game message before `create`/`join`
  | 'ALREADY_IN_ROOM' // a second `create`/`join` on one connection
  | 'ILLEGAL_SETUP' // the setup broke a placement rule (spec §12)
  | 'RATE_LIMITED' // too many messages, or too many new rooms, too fast (Session 8)
  | 'SERVER_FULL'; // the server holds as many rooms as it will take (Session 8)

/** One resolved round's worth of a seat's filtered events, as its log keeps them. */
export interface LogSlice {
  round: number;
  events: VisibleEvent[];
}

export type ServerMessage =
  /**
   * You are in. `seat` is who you play; `seed` and `map` are the board — public
   * from the first frame (spec §11), and the same for both seats. `token` is
   * this seat's secret, kept by the browser so it can take the seat back.
   * `resumed` is true when the token brought a returning browser back into its
   * seat; `submitted` is whether the seat has already handed in what it owes
   * right now (its setup, or this round's orders).
   */
  | {
      type: 'joined';
      room: string;
      seat: PlayerId;
      token: string;
      seed: number;
      map: MapData;
      resumed: boolean;
      submitted: boolean;
    }
  /**
   * A returning seat's whole picture, sent right after `joined` once a match is
   * running: the board as this seat may see it now and this seat's whole event
   * log. Built from the same filtered updates the seat was sent live, and
   * nothing else, so a reconnect can never show more than playing on would have.
   */
  | {
      type: 'snapshot';
      view: VisibleGameState;
      log: LogSlice[];
      finalReveal: Unit[] | null;
    }
  /**
   * The order clock: how long this round's orders may still be sent, in
   * milliseconds, or null when no clock is running (setup, or the match is
   * over). Durations rather than a wall-clock time, so a browser whose clock is
   * wrong still counts down correctly.
   */
  | { type: 'timer'; msLeft: number | null }
  /** Whether the other seat currently has someone in it. */
  | { type: 'opponent'; present: boolean }
  /** What the authority told this seat — filtered, and for this seat only. */
  | { type: 'update'; update: MatchUpdate }
  | { type: 'error'; code: ErrorCode };

// ---------------------------------------------------------------------------
// Reading untrusted input
// ---------------------------------------------------------------------------

/**
 * Size limits on anything a browser sends. Generous next to what an honest
 * client produces (three placements; one order per unit, and a side has five
 * units), and small enough that a hostile message cannot make the server do
 * real work. The rate limits on top of these (how *often*, not how *big*) are
 * `DEFAULT_LIMITS` in `server/guard.ts`.
 */
export const LIMITS = {
  maxMessageBytes: 8 * 1024,
  maxPlacements: 8,
  maxOrders: 16,
  maxIdLength: 32,
  maxCoordinate: 1000,
} as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex(value: unknown): value is Hex {
  if (!isObject(value)) return false;
  const { q, r } = value;
  return (
    Number.isInteger(q) &&
    Number.isInteger(r) &&
    Math.abs(q as number) <= LIMITS.maxCoordinate &&
    Math.abs(r as number) <= LIMITS.maxCoordinate
  );
}

/** A hex rebuilt from its two fields, so nothing extra rides along into the sim. */
function hexOf(value: Hex): Hex {
  return { q: value.q, r: value.r };
}

const PLACEABLE = new Set<string>(['bunker', 'decoy', 'interceptor']);

function parsePlacement(value: unknown): Placement | null {
  if (!isObject(value) || typeof value.kind !== 'string') return null;
  if (!PLACEABLE.has(value.kind) || !isHex(value.hex)) return null;
  return { kind: value.kind as Placement['kind'], hex: hexOf(value.hex) };
}

function parseOrder(value: unknown): Order | null {
  if (!isObject(value)) return null;
  const { type, unitId } = value;
  if (typeof unitId !== 'string' || unitId.length > LIMITS.maxIdLength) return null;
  switch (type) {
    case 'MOVE':
    case 'MARCH':
    case 'FLY':
      return isHex(value.destination)
        ? { type, unitId, destination: hexOf(value.destination) }
        : null;
    case 'LAUNCH':
      return isHex(value.target) ? { type, unitId, target: hexOf(value.target) } : null;
    default:
      return null;
  }
}

/** Every element parsed, or null if any one fails or there are too many. */
function parseList<T>(value: unknown, max: number, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/**
 * A browser's raw message as a `ClientMessage`, or null if it is anything else.
 *
 * Returns a **freshly built** object rather than the parsed JSON, so an extra
 * field a hostile client adds (a `player`, say) is simply not there afterwards —
 * nothing downstream can be tricked into reading it.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > LIMITS.maxMessageBytes) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;

  switch (data.type) {
    case 'create':
      return Number.isInteger(data.version)
        ? { type: 'create', version: data.version as number }
        : null;
    case 'join': {
      if (
        !Number.isInteger(data.version) ||
        typeof data.room !== 'string' ||
        data.room.length > LIMITS.maxIdLength
      ) {
        return null;
      }
      const base = { type: 'join' as const, version: data.version as number, room: data.room };
      if (data.token === undefined) return base;
      return typeof data.token === 'string' && data.token.length <= LIMITS.maxIdLength * 2
        ? { ...base, token: data.token }
        : null;
    }
    case 'setup': {
      const setup = parseList(data.setup, LIMITS.maxPlacements, parsePlacement);
      return setup ? { type: 'setup', setup } : null;
    }
    case 'orders': {
      const orders = parseList(data.orders, LIMITS.maxOrders, parseOrder);
      return orders ? { type: 'orders', orders } : null;
    }
    case 'resign':
      return { type: 'resign' };
    default:
      return null;
  }
}

/**
 * The server's message, or null if it is not one. The server is ours, so this is
 * a sanity check on the envelope — a wrong URL or a proxy's error page — not a
 * defence; the payloads are the authority's own output.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  switch (data.type) {
    case 'joined':
    case 'opponent':
    case 'update':
    case 'snapshot':
    case 'timer':
    case 'error':
      return data as ServerMessage;
    default:
      return null;
  }
}

/** Normalise what a person typed or pasted as a room code. */
export function normaliseRoomCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The room code in whatever a player typed into the title screen's join box,
 * or null if there is none. Forgiving on purpose: lower case, spaces or dashes
 * ("u7e-k44"), and a whole pasted invite link ("https://…/?room=U7EK44") all
 * work. Strict about the code itself — exactly `ROOM_CODE_LENGTH` characters
 * from `ROOM_ALPHABET` — so a typo is caught here rather than as a server
 * refusal.
 */
export function readRoomCode(input: string): string | null {
  const fromLink = /[?&]room=([^&#\s]*)/i.exec(input);
  const code = normaliseRoomCode(fromLink ? fromLink[1] : input).replace(/[\s-]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const char of code) if (!ROOM_ALPHABET.includes(char)) return null;
  return code;
}
