// UI LAYER — the order clock (V1.5 Session 7).
//
// A panel of its own at the top of the HUD, shown for as long as the server's
// clock runs: while the replay plays (the clock is already counting then), while
// ordering, and after sending (dimmed, because it is then the opponent's time
// that is running out). Red at 10 seconds and below. `useOrderClock`, in its own
// file, is what sends the draft at zero. Reads `online` only, never the board.

import { useEffect, useState } from 'react';
import { useOnline } from '../state/useMatch';
import { clockText, clockUrgent, secondsLeft } from './clockText';

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
  if (!online || endsAt === null) return null;

  const seconds = secondsLeft(endsAt, now);
  const sent = online.submitted;
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
