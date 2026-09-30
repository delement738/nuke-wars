// UI LAYER — the order clock (V1.5 Session 7).
//
// A panel of its own at the top of the HUD, shown for as long as the server's
// clock runs: while the replay plays (the clock is already counting then), while
// ordering, and after sending (dimmed, because it is then the opponent's time
// that is running out). Red at 10 seconds and below, with a tick each second
// while this player still owes orders. `useOrderClock`, in its own
// file, is what sends the draft at zero. Reads `online` only, never the board.

import { useEffect, useRef, useState } from 'react';
import { playSound } from '../audio/synth';
import { useOnline } from '../state/useMatch';
import { clockText, clockUrgent, secondsLeft, shouldTick } from './clockText';

/** The current time, refreshed four times a second while a deadline is set. */
function useNow(endsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    // First tick at once, not a quarter-second later: `now` has been standing
    // still since the last clock stopped, and a new deadline read against it
    // would flash a time that was never true.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [endsAt]);
  return now;
}

export default function OrderClock() {
  const online = useOnline();
  const endsAt = online?.timerEndsAt ?? null;
  const now = useNow(endsAt);
  const seconds = endsAt === null ? null : secondsLeft(endsAt, now);
  const sent = online?.submitted === true;

  // The last ten seconds tick, once per second shown.
  const lastTicked = useRef<number | null>(null);
  useEffect(() => {
    if (seconds === null) {
      lastTicked.current = null;
      return;
    }
    if (shouldTick(seconds, sent, lastTicked.current)) playSound('tick');
    lastTicked.current = seconds;
  }, [seconds, sent]);

  if (!online || seconds === null) return null;

  const urgent = !sent && clockUrgent(seconds);
  const className = ['panel', 'order-clock', urgent && 'urgent', sent && 'sent']
    .filter(Boolean)
    .join(' ');

  return (
    <section className={className} role="timer" aria-live="off">
      <span className="order-clock-label">
        {sent ? 'Opponent has' : 'Orders due in'}
      </span>
      <span className="order-clock-time">{clockText(seconds)}</span>
    </section>
  );
}
