// NETWORK — the seat this browser tab holds (V1.5 Session 7).
//
// The room and the seat's token, kept so a refreshed page, or a connection that
// dropped and came back, can take its seat again instead of being a stranger.
//
// `sessionStorage`, not `localStorage`: it belongs to one tab, survives a reload
// of that tab, and is gone when the tab closes. Two tabs on one computer (which
// is how a match is tried out alone) therefore hold two seats rather than
// fighting over one. Every access is guarded: private windows and blocked site
// data make storage throw, and the game must simply carry on without it.

const KEY = 'nukewars.seat';

export interface SavedSeat {
  room: string;
  token: string;
}

export function saveSeat(seat: SavedSeat): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(seat));
  } catch {
    // no storage: reconnecting after a reload is simply unavailable
  }
}

export function loadSeat(): SavedSeat | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return null;
    const { room, token } = data as Record<string, unknown>;
    return typeof room === 'string' && typeof token === 'string' ? { room, token } : null;
  } catch {
    return null;
  }
}

export function clearSeat(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
