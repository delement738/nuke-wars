// UI LAYER — the HUD (build-order step 9).
//
// Reads state, sends player intents, never mutates game state. Every number on
// screen comes from the current viewer's `VisibleGameState`; every button calls
// an action in `src/state/match.ts`. There is no third path.
//
// What this is NOT yet: an order builder. Step 9's job is the wiring — store
// owns the state, canvas draws the filtered view, HUD keeps the log — and step
// 10 adds setup placement, orders, and the real hotseat handoff (spec §8). So
// "Resolve round" submits an empty order list, which is a legal round: a
// launcher with no order holds, a drone with no order hovers (§3).
//
// The viewer switch is a **sandbox control**, not the handoff. It exists to make
// the visibility filter visible: flip it and the board redraws as the other
// player's picture — different units, different intel, a different log out of
// one shared truth. Step 10 replaces it with a proper pass-the-screen sequence.

import { newMatch, resign, resolveRound, SANDBOX_DUMMY, SANDBOX_PLAYER } from '../state/match';
import { setViewer } from '../state/match';
import { useSeed, useView, useViewer } from '../state/useMatch';
import EventLog from './EventLog';
import SelectionPanel from './SelectionPanel';
import { describeOutcome } from './eventText';
import './hud.css';

export default function Hud() {
  const view = useView();
  const viewer = useViewer();
  const seed = useSeed();

  const over = view.outcome !== null;
  const deadHand = view.phase === 'DEAD_HAND_PHASE';

  return (
    <div className="hud">
      <div className="column left">
        <section className="panel">
          <h2>
            Round {view.round}
            <span className="viewing">viewing {viewer.toUpperCase()}</span>
          </h2>

          <p className={deadHand ? 'alert' : 'muted'}>
            {over
              ? 'Match over.'
              : deadHand
                ? view.deadHandFor === viewer
                  ? 'DEAD HAND — your final volley. Launches only.'
                  : 'DEAD HAND — the enemy fires a final volley.'
                : 'Order phase.'}
          </p>

          {view.outcome && (
            <p className="outcome">{describeOutcome(view.outcome, viewer)}</p>
          )}

          <p className="muted">
            {view.droneRespawnIn > 0
              ? `Drone down — returns in ${view.droneRespawnIn} round${view.droneRespawnIn === 1 ? '' : 's'}.`
              : 'Drone on station.'}
          </p>

          <div className="buttons">
            <button type="button" onClick={() => resolveRound()} disabled={over}>
              {deadHand ? 'Resolve final volley' : 'Resolve round'}
            </button>
            <button type="button" onClick={() => resign(viewer)} disabled={over}>
              Resign
            </button>
          </div>

          <p className="footnote">
            No orders are issued yet — the order builder is build-order step 10.
            Resolving now is a round in which every launcher holds and every drone
            hovers.
          </p>
        </section>

        <SelectionPanel />

        <section className="panel">
          <h2>Sandbox</h2>
          <p className="muted">
            You are {SANDBOX_PLAYER.toUpperCase()}; {SANDBOX_DUMMY.toUpperCase()} is
            a static dummy that never issues an order.
          </p>

          <div className="buttons">
            <button
              type="button"
              onClick={() => setViewer('p1')}
              disabled={viewer === 'p1'}
            >
              View as P1
            </button>
            <button
              type="button"
              onClick={() => setViewer('p2')}
              disabled={viewer === 'p2'}
            >
              View as P2
            </button>
          </div>

          <div className="buttons">
            <button type="button" onClick={() => newMatch(Date.now() % 100000)}>
              New map
            </button>
            <button type="button" onClick={() => newMatch()}>
              Reset (seed 42)
            </button>
          </div>

          <p className="footnote">Map seed {seed}. Same seed, same board.</p>
        </section>

        <section className="panel legend">
          <h2>Legend</h2>
          <p className="own">Blue — your units: L launcher, I interceptor base, D drone, B bunker, X decoy.</p>
          <p className="enemy">Red — what you have detected. Solid ring: a site or base, permanent. Circle: a launcher, this round only — bright if it fired, faint if recon saw it (it may have moved).</p>
          <p className="muted">Faint blue wash: ground your own interceptor bases cover.</p>
        </section>
      </div>

      <div className="column right">
        <EventLog />
      </div>
    </div>
  );
}
