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
import { dismissReport, newMatch } from '../state/match';
import type { ReportTone } from '../state/reports';
import { useReplay, useReport, useView } from '../state/useMatch';
import './hud.css';

interface Props {
  /** Leaves the finished match for the title screen, which `App` owns. */
  onTitle: () => void;
}

/**
 * The three tones that end the match get the end-of-match screen (V1.5
 * Session 3) instead of the small banner. It IS the game-over report — same
 * queue, same hold-back until the final replay has played, same mount point —
 * so it inherits both secrecy rules above rather than needing its own.
 */
const VERDICT: Partial<Record<ReportTone, string>> = {
  victory: 'Victory',
  defeat: 'Defeat',
  draw: 'Draw',
};

export default function BattleReport({ onTitle }: Props) {
  // Held back until the viewer's replay has played (presentation phase,
  // session 1): "Launcher lost" popping up before the round has been watched
  // would spoil it. Still mounted inside `App`'s board branch — gotcha 62.
  const replaying = useReplay() !== null;
  const pending = useReport();
  const report = replaying ? null : pending;
  const round = useView()?.round;

  // Space and Enter dismiss, so a player mid-order-entry does not have to reach
  // for the mouse. Bound while a banner is up and unbound the instant it is
  // gone, so the keys go back to doing nothing when there is nothing to clear.
  // On the end screen "dismiss" is "View the board", the button with focus.
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

  const verdict = VERDICT[report.tone];
  if (verdict) {
    return (
      <div className="report-scrim endgame-scrim" onClick={dismissReport}>
        <div
          className={`endgame endgame-${report.tone}`}
          role="alert"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="endgame-kicker">Match over{round ? ` · round ${round}` : ''}</p>
          <h2 className="endgame-verdict">{verdict}</h2>
          <p className="endgame-headline">{report.headline}</p>
          <p className="endgame-detail">{report.detail}</p>
          <div className="endgame-buttons">
            {/* The final reveal (gotcha 73) is on the board underneath. */}
            <button type="button" className="endgame-btn primary" onClick={dismissReport} autoFocus>
              See enemy positions
            </button>
            <button type="button" className="endgame-btn" onClick={() => newMatch(Date.now() % 100000)}>
              Play again
            </button>
            <button type="button" className="endgame-btn" onClick={onTitle}>
              Title screen
            </button>
          </div>
        </div>
      </div>
    );
  }

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
