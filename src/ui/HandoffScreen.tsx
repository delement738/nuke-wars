// UI LAYER — the pass-the-screen handoff (build-order step 10c).
//
// **This component is a blindfold, and that is its whole job.** In hotseat one
// machine holds both players' redacted views, both secret setups and both order
// drafts (spec §6, gotcha 36). Until 10c the client's secrecy was structural —
// while you placed, no enemy setup existed anywhere in it to leak (gotcha 43) —
// and with a second human that is simply no longer true. What replaces it is two
// rules, and this screen is the second of them:
//
//   1. No hook takes a `PlayerId` from a caller. `usePlaced`, `useDraft`,
//      `useView` and `useLog` all key off `viewer` internally, so the only
//      board a component *can* obtain is the current viewer's (`./useMatch`).
//   2. `viewer` cannot change without passing through this screen, and while it
//      is up `App` renders nothing else — not the canvas, not the panels.
//
// Rule 2 is why this returns a full-screen element rather than an overlay, and
// why `App` swaps on it rather than stacking it on top. An overlay would leave a
// board mounted underneath, one CSS mistake away from being visible; there is
// nothing to see through here because there is nothing behind it.
//
// It deliberately names the incoming player and says nothing whatever about the
// state of the match — not the round, not the outcome, not whose turn it was.
// The outgoing player is standing right there.

import type { PlayerId } from '../sim/types';
import { takeScreen } from '../state/match';
import { useHandoff, useMatchStarted } from '../state/useMatch';
// Imported here as well as in `Hud`, because `App` renders this screen *instead*
// of the HUD — with the canvas and every panel unmounted, nothing else would
// have pulled the stylesheet in. Bundlers dedupe it.
import './hud.css';

/** Which end of the board a player holds (spec §7) — the one orienting fact it
 *  is always safe to print, because the map is public (§11 rule 1). */
const SIDE: Record<PlayerId, string> = {
  p1: 'south',
  p2: 'north',
};

export default function HandoffScreen() {
  const handoff = useHandoff();
  const started = useMatchStarted();

  // `App` only mounts this when a handoff is pending, so null is unreachable —
  // the guard exists so the type never has to lie, the same reasoning as
  // `Hud`'s null-view check (gotcha 42).
  if (!handoff) return null;

  const name = handoff.toUpperCase();

  return (
    <div className="handoff">
      <section className="panel handoff-card">
        <h2>Pass the screen</h2>

        <p className="handoff-to">{name}</p>

        <p className="muted">
          {started
            ? `Hand the machine to ${name}, who holds the ${SIDE[handoff]}. Press below only when they are the one looking.`
            : `Hand the machine to ${name}, who holds the ${SIDE[handoff]}, and look away while they hide their assets.`}
        </p>

        <div className="buttons">
          <button type="button" onClick={() => takeScreen()}>
            I am {name} — show my board
          </button>
        </div>

        <p className="footnote">
          Nothing is drawn until you press it. Your opponent's board, their
          orders and their hidden assets are never on this screen at the same
          time as yours.
        </p>
      </section>
    </div>
  );
}
