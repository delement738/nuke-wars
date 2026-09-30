// UI LAYER — the order clock (V1.5 Session 7).
//
// Shows the seconds left on the server's deadline (`useOrderClock`, in its own
// file, is what acts on it). Reads `online.timerEndsAt` only.

import { useEffect, useState } from 'react';
import { useOnline } from '../state/useMatch';

/** Seconds left on the clock, refreshed four times a second; null if none runs. */
function useSecondsLeft(): number | null {
  const endsAt = useOnline()?.timerEndsAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [endsAt]);
  return endsAt === null ? null : Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export default function OrderClock() {
  const online = useOnline();
  const seconds = useSecondsLeft();
  if (!online || seconds === null || online.submitted) return null;
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <p className={seconds <= 5 ? 'alert order-clock' : 'muted order-clock'}>
      Orders due in {text}
    </p>
  );
}
