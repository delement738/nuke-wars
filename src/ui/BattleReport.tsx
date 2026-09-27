// UI LAYER — the battle-report banner (V1.1 step 1).
//
// The large notification that stops the player when something decisive happens:
// a launcher confirmed killed, or the match ending. `src/state/reports.ts` owns
// *what* is worth a banner and why the list is so short; this file only draws
// the head of the viewer's queue and lets them dismiss it.
//
// **Two rules govern where this may be mounted, and both are secrecy rules.**
//
//  1. **Never over the handoff screen.** In hotseat one machine holds both
//     players' news, and a full-screen "Launcher lost" appearing as the wrong
//     player sits down leaks the round to them before their opponent has left
//     the chair. `App` renders `HandoffScreen` *instead of* the board rather
//     than on top of it (gotcha 58), and this component is mounted inside the
//     board branch — so "no banner during a handoff" is a fact about the
//     component tree, not a z-index promise. Do not lift it into `App`'s common
//     path to "simplify".
//
//  2. **It reads `viewer`, never a `PlayerId` argument** (gotcha 36). `useReport`
//     keys off the viewer internally like every other selector, and
//     `dismissReport` pops that same player's queue — so whoever is at the
//     machine can only ever read and clear their own banners. The other seat's
//     queue waits for them.
//
// The dismissal is deliberately manual. An auto-dismiss timer would be a race
// with a player who looked away, and these are the four or five moments in a
// match that are worth interrupting for — if a banner is not worth a click, it
// should not be in `reports.ts` at all.

import { useEffect } from 'react';
import { dismissReport } from '../state/match';
import { useReport } from '../state/useMatch';
import './hud.css';

export default function BattleReport() {
  const report = useReport();

  // Space and Enter dismiss, so a player mid-order-entry does not have to reach
  // for the mouse. Bound while a banner is up and unbound the instant it is
  // gone, so the keys go back to doing nothing when there is nothing to clear.
  useEffect(() => {
    if (!report) return;

    function onKey(event: KeyboardEvent) {
      if (event.key === ' ' || event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        dismissReport();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [report]);

  if (!report) return null;

  return (
    <div className="report-scrim" onClick={dismissReport}>
      {/* role="alert" so a screen reader announces it without needing focus;
          the surrounding div stays click-to-dismiss for everyone else. */}
      <div className={`report report-${report.tone}`} role="alert">
        <h2 className="report-headline">{report.headline}</h2>
        <p className="report-detail">{report.detail}</p>
        <button type="button" className="report-dismiss" autoFocus>
          Dismiss
        </button>
      </div>
    </div>
  );
}
