// UI LAYER — the HUD (build-order step 9).
//
// Reads state, sends player intents, never mutates game state. Every number on
// screen comes from the current viewer's `VisibleGameState`; every button calls
// an action in `src/state/match.ts`. There is no third path.
//
// The human side now gives real orders (build-order step 10a): `OrderPanel`
// drafts them and `resolveRound()` submits them. "Resolve round" stays as the
// way to go early — undecided units simply hold, which is a legal round on its
// own (§3) — but a draft that decides every orderable unit resolves itself
// without it. The CPU side (SANDBOX_DUMMY) is decided by `src/state/cpu.ts`
// from its own redacted view, same as any player.
//
// Both players' assets are now really placed before the match: the human's on
// `SetupPanel`'s screen (session 10b), the CPU's by the same fixture that backs
// Auto-place. `App` mounts this component only once that has happened, which is
// why the board it reads is never null in practice.
//
// Still to come: the real hotseat handoff (session 10c).
//
// The viewer switch is a **sandbox control**, not the handoff. It exists to make
// the visibility filter visible: flip it and the board redraws as the other
// player's picture — different units, different intel, a different log out of
// one shared truth. Step 10 replaces it with a proper pass-the-screen sequence.

import type { CpuDifficulty } from '../state/cpu';
import {
  newMatch,
  resign,
  resolveRound,
  setDifficulty,
  setViewer,
  SANDBOX_DUMMY,
  SANDBOX_PLAYER,
} from '../state/match';
import { useDifficulty, useSeed, useView, useViewer } from '../state/useMatch';
import EventLog from './EventLog';
import OrderPanel from './OrderPanel';
import SelectionPanel from './SelectionPanel';
import { describeOutcome } from './eventText';
import './hud.css';

const DIFFICULTIES: readonly CpuDifficulty[] = ['easy', 'medium', 'hard'];

export default function Hud() {
  const view = useView();
  const viewer = useViewer();
  const seed = useSeed();
  const difficulty = useDifficulty();

  // `App` only mounts this once a match exists, so a null view is unreachable —
  // but `useView()` is nullable because the setup screen legitimately has no
  // board (step 10b), and narrowing it here is cheaper than a second source of
  // truth about which screen we are on.
  if (!view) return null;

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
            Resolving early is legal: any unit you have not decided holds, and a
            drone with no order hovers and watches its own corridor (§3).
          </p>
        </section>

        <OrderPanel />

        <SelectionPanel />

        <section className="panel">
          <h2>Sandbox</h2>
          <p className="muted">
            You are {SANDBOX_PLAYER.toUpperCase()}; {SANDBOX_DUMMY.toUpperCase()} is
            a CPU opponent that plays from its own redacted view, same as a human
            in that seat would.
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
            {DIFFICULTIES.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setDifficulty(level)}
                disabled={difficulty === level}
              >
                {level[0].toUpperCase() + level.slice(1)}
              </button>
            ))}
          </div>

          <div className="buttons">
            <button type="button" onClick={() => newMatch(Date.now() % 100000)}>
              New map
            </button>
            <button type="button" onClick={() => newMatch()}>
              Reset (seed 42)
            </button>
          </div>

          <p className="footnote">
            Map seed {seed}. Same seed, same board. CPU difficulty: {difficulty}.
            Either button abandons this match and returns to secret placement.
          </p>
        </section>

        <section className="panel legend">
          <h2>Legend</h2>
          <p className="own">Blue — your units: L launcher, I interceptor base, D drone, B bunker, X decoy.</p>
          <p className="muted">Order overlay: green fill — ground a launcher can reach. Amber outline — hexes it can fire on. Violet dots — where the drone can fly, with the corridor it would photograph shown on hover.</p>
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
