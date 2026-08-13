// UI LAYER — secret placement (build-order step 10b).
//
// Reads state, sends player intents, never mutates game state and never decides
// a rule. Which asset is selected and where it may go both come from
// `src/state/placement.ts`, which asks the real §12 validator in
// `src/sim/setup.ts` — the same function `startMatch` re-checks the finished
// setup with. This file's whole job is to put those answers on screen.
//
// The loop it implements: pick one of your four assets from the roster, click a
// gold hex to put it there, repeat, then Start. **Any asset, in any order**, and
// an asset already on the board moves to wherever you click next — placement
// order is free (§12, changed 2026-08-13), so the roster is a list of things you
// own rather than a sequence you march through. The panel pre-selects the next
// empty slot after each placement, so clicking four times in a row still works
// without ever touching this list.
//
// There is no click handler for the board here. The board is the input device,
// and a click on it is routed by `pickHex` in the store, which is also what
// routes clicks during play — one place that decides what clicking a hex means.

import { RULES, type PlaceableKind } from '../sim/defs';
import {
  autoPlace,
  clearPlacements,
  clearSlot,
  newMatch,
  selectSlot,
  startPlacedMatch,
  SANDBOX_DUMMY,
  SANDBOX_PLAYER,
} from '../state/match';
import {
  ROSTER_SIZE,
  placementComplete,
  placementSlots,
  type PlacementSlot,
} from '../state/placement';
import { usePlaced, useSeed, useSelectedSlot } from '../state/useMatch';
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
 * The decoy's is the load-bearing one: a player who treats it as a throwaway has
 * not understood that it is what makes finding a site worth nothing on its own
 * (§12). It costs the attacker a missile, a launcher's round, and the exposure
 * of having fired, to learn which of your two sites is real.
 */
const KIND_BLURB: Record<PlaceableKind, string> = {
  bunker:
    'Two hits kill it and you lose. Hide it — you cannot defend it directly, and your interceptor bases are forbidden from sitting on top of it.',
  decoy:
    'Empty concrete, identical to your bunker in every way the enemy can observe. Put it somewhere they will believe, and far from the real one: a single drone pass photographs a 3-hex corridor, so two sites side by side are found together.',
  interceptor:
    'Shoots down one missile per round in the ring around it. It must sit at least 3 hexes from BOTH of your sites, so it can only defend an approach lane, never the bunker itself.',
};

/** "Interceptor base 2" — the two bases are numbered, the single sites are not. */
function slotLabel(slot: PlacementSlot): string {
  const name = KIND_LABEL[slot.kind];
  return slot.ofKind > 1 ? `${name} ${slot.index}` : name;
}

export default function SetupPanel() {
  const placed = usePlaced();
  const selectedSlot = useSelectedSlot();
  const seed = useSeed();

  const slots = placementSlots(placed);
  const active = slots[selectedSlot];
  const ready = placementComplete(placed);
  // Filled slots, NOT `placed.length` — the draft is a fixed-length array with a
  // null per empty slot, so its length is always the roster size and a counter
  // built from it reads "4 / 4" from the first frame.
  const done = slots.filter((slot) => slot.hex !== null).length;

  return (
    <div className="hud">
      <div className="column left">
        <section className="panel setup">
          <h2>
            Secret placement
            <span className="viewing">
              {done} / {ROSTER_SIZE}
            </span>
          </h2>

          <p className="muted">
            You are {SANDBOX_PLAYER.toUpperCase()}, holding the south. Place your
            four assets anywhere in your home zone — rows{' '}
            {RULES.homeZoneRows[SANDBOX_PLAYER].min}–
            {RULES.homeZoneRows[SANDBOX_PLAYER].max}, highlighted in gold. Plains
            or mountain both work: nothing static is driven into position.
          </p>

          <ul className="unit-list">
            {slots.map((slot) => {
              const isActive = slot.id === selectedSlot;
              return (
                <li key={slot.id} className={isActive ? 'unit active' : 'unit'}>
                  <button
                    type="button"
                    className="unit-name"
                    onClick={() => selectSlot(slot.id)}
                  >
                    <span>{slotLabel(slot)}</span>
                    <span className="decision">
                      {slot.hex ? hexLabel(slot.hex) : 'not placed'}
                    </span>
                  </button>

                  {isActive && (
                    <div className="buttons">
                      {slot.hex && (
                        <button type="button" onClick={() => clearSlot(slot.id)}>
                          Pick back up
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {active && (
            <>
              <p className="alert">
                {active.hex
                  ? `Click a gold hex to move your ${slotLabel(active).toLowerCase()}.`
                  : `Click a gold hex to place your ${slotLabel(active).toLowerCase()}.`}
              </p>
              <p className="footnote">{KIND_BLURB[active.kind]}</p>
            </>
          )}

          <div className="buttons">
            <button type="button" onClick={() => startPlacedMatch()} disabled={!ready}>
              {ready ? 'Start match' : `Place all ${ROSTER_SIZE} to start`}
            </button>
            <button
              type="button"
              onClick={() => clearPlacements()}
              disabled={done === 0}
            >
              Start over
            </button>
          </div>

          <p className="footnote">
            Place them in any order, and move any of them as often as you like —
            nothing is committed until you press Start. From then on your setup is
            secret: {SANDBOX_DUMMY.toUpperCase()} places theirs at the same time,
            and neither of you ever sees the other's.
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
            Gold — ground the selected asset may stand on. Click one to place or
            move it. A gold ring marks the asset you have picked up.
          </p>
          <p className="enemy">
            Red wash — denied to the selected asset by the exclusion rule: a base
            and a site may never be within {RULES.bunkerExclusionRadius} hexes of
            each other, whichever of the two you are placing.
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
