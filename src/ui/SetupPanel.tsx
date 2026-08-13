// UI LAYER — secret placement (build-order step 10b).
//
// Reads state, sends player intents, never mutates game state and never decides
// a rule. Which asset is being placed and where it may go both come from
// `src/state/placement.ts`, which asks the real §12 validator in
// `src/sim/setup.ts` — the same function `startMatch` re-checks the finished
// setup with. This file's whole job is to put those answers on screen.
//
// The loop it implements: bunker -> decoy -> base -> base, each on a highlighted
// hex, and the match starts the moment the fourth is down. The placement order
// is the spec's and it is enforced rather than suggested (§12) — the bases are
// last because their exclusion rule is measured against both sites, so a base
// placed first could not be checked against anything.
//
// There is no click handler here. The board is the input device, and a click on
// it is routed by `pickHex` in the store, which is also what routes clicks
// during play — one place that decides what clicking a hex means.

import { RULES, type PlaceableKind } from '../sim/defs';
import {
  autoPlace,
  clearPlacements,
  newMatch,
  undoPlacement,
  SANDBOX_DUMMY,
  SANDBOX_PLAYER,
} from '../state/match';
import { ROSTER_SIZE, placementStep } from '../state/placement';
import { usePlaced, useSeed } from '../state/useMatch';
import { hexLabel } from './eventText';

/** What each asset is called on screen. */
const KIND_LABEL: Record<PlaceableKind, string> = {
  bunker: 'Command bunker',
  decoy: 'Decoy bunker',
  interceptor: 'Interceptor base',
};

/**
 * Why you are placing this, in one line.
 *
 * The decoy's line is the load-bearing one: a player who treats it as a
 * throwaway has not understood that it is the thing that makes finding a site
 * worth nothing on its own (§12). It costs the attacker a missile, a launcher's
 * round, and the exposure of having fired, to learn which of your two sites is
 * real.
 */
const KIND_BLURB: Record<PlaceableKind, string> = {
  bunker:
    'Two hits kill it and you lose. Hide it — you cannot defend it directly, and your interceptor bases are forbidden from sitting on top of it.',
  decoy:
    'Empty concrete, identical to your bunker in every way the enemy can observe. Put it somewhere they will believe, and far from the real one: a single drone pass photographs a 3-hex corridor, so two sites side by side are found together.',
  interceptor:
    'Shoots down one missile per round in the ring around it. It must sit at least 3 hexes from BOTH of your sites, so it can only defend an approach lane, never the bunker itself.',
};

export default function SetupPanel() {
  const placed = usePlaced();
  const seed = useSeed();

  const step = placementStep(placed);

  return (
    <div className="hud">
      <div className="column left">
        <section className="panel setup">
          <h2>
            Secret placement
            <span className="viewing">
              {placed.length} / {ROSTER_SIZE}
            </span>
          </h2>

          <p className="muted">
            You are {SANDBOX_PLAYER.toUpperCase()}, holding the south. Place your
            four assets anywhere in your home zone — rows{' '}
            {RULES.homeZoneRows[SANDBOX_PLAYER].min}–
            {RULES.homeZoneRows[SANDBOX_PLAYER].max}, highlighted in gold. Plains
            or mountain both work: nothing static is driven into position.
          </p>

          {step && (
            <>
              <p className="alert">
                Step {step.ordinal} of {ROSTER_SIZE}: place your{' '}
                {KIND_LABEL[step.kind].toLowerCase()}
                {step.ofKind > 1 ? ` (${step.index} of ${step.ofKind})` : ''}.
              </p>
              <p className="footnote">{KIND_BLURB[step.kind]}</p>
            </>
          )}

          <ol className="unit-list">
            {placed.map((placement, i) => (
              <li key={`${placement.kind}-${i}`} className="unit">
                <span className="unit-name">
                  <span>{KIND_LABEL[placement.kind]}</span>
                  <span className="decision">{hexLabel(placement.hex)}</span>
                </span>
              </li>
            ))}
          </ol>

          <div className="buttons">
            <button
              type="button"
              onClick={() => undoPlacement()}
              disabled={placed.length === 0}
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => clearPlacements()}
              disabled={placed.length === 0}
            >
              Start over
            </button>
          </div>

          <p className="footnote">
            The match begins the moment your fourth asset is down. Your placement
            is secret from then on — {SANDBOX_DUMMY.toUpperCase()} places theirs
            at the same time, and neither of you ever sees the other's.
          </p>
        </section>

        <section className="panel">
          <h2>Sandbox</h2>

          <div className="buttons">
            <button type="button" onClick={() => autoPlace()}>
              Auto-place and start
            </button>
          </div>
          <p className="footnote">
            Places your four assets for you, using the same function that builds
            the CPU's setup — handy when you are testing something that is not
            placement.
          </p>

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
          <p className="buildable">
            Gold — ground the current asset may be built on. Click one to place.
          </p>
          <p className="enemy">
            Red wash — too close to one of your own sites for an interceptor
            base (within {RULES.bunkerExclusionRadius} hexes). It appears once
            your bunker and decoy are down.
          </p>
          <p className="muted">
            Blue — what you have placed: B bunker, X decoy, I interceptor base.
            Your launchers and drone spawn on fixed, publicly-known hexes, so
            there is nothing to place for them.
          </p>
        </section>
      </div>
    </div>
  );
}
