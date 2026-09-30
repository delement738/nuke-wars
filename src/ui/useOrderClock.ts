// UI LAYER — sends the draft when the order clock runs out (V1.5 Session 7).
//
// Reads `online.timerEndsAt` only, so it knows nothing about the board.

import { useEffect } from 'react';
import { orderTimeExpired } from '../state/match';
import { useOnline } from '../state/useMatch';

/**
 * Sends the draft when the clock reaches zero. Mounted once, by the HUD, so it
 * runs whichever panel is showing (a replay may still be playing at zero — the
 * server's clock does not wait for it).
 */
export function useOrderClock(): void {
  const endsAt = useOnline()?.timerEndsAt ?? null;
  useEffect(() => {
    if (endsAt === null) return;
    const wait = Math.max(0, endsAt - Date.now());
    const id = setTimeout(orderTimeExpired, wait);
    return () => clearTimeout(id);
  }, [endsAt]);
}
