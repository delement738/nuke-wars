// UI LAYER — how the order clock reads (V1.5 Session 7). Pure, so it is tested
// without a browser.

/** Under this many seconds the clock turns red (designer's call, 2026-09-30). */
export const CLOCK_URGENT_SECONDS = 10;

/** Whole seconds left before `endsAt`, never negative — rounded up, so it shows
 *  0:01 until the very end and reaches 0:00 only when time is actually up. */
export function secondsLeft(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

/** `m:ss`. */
export function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function clockUrgent(seconds: number): boolean {
  return seconds <= CLOCK_URGENT_SECONDS;
}
