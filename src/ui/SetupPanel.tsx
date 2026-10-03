// UI LAYER — secret placement (build-order step 10b).
//
// Reads state, sends player intents, never mutates game state and never decides
// a rule. Which asset is selected and where it may go both come from
// `src/state/placement.ts`, which asks the real §12 validator in
// `src/sim/setup.ts` — the same function `startMatch` re-checks the finished
// setup with. This file's whole job is to put those answers on screen.
//
// The loop it implements: pick one of your assets from the roster, click a
// gold hex to put it there, repeat, then Start. **Any asset, in any order**, and
// an asset already on the board moves to wherever you click next — placement
// order is free (§12, changed 2026-08-13), so the roster is a list of things you
// own rather than a sequence you march through. The panel pre-selects the next
// empty slot after each placement, so clicking in a row still works
// without ever touching this list.
//
// There is no click handler for the board here. The board is the input device,
// and a click on it is routed by `pickHex` in the store, which is also what
// routes clicks during play — one place that decides what clicking a hex means.

import { RULES, UNIT_DEFS, type PlaceableKind } from '../sim/defs';
import { opponentOf } from '../sim/types';
import type { CpuDifficulty } from '../state/cpu';
import {
  autoPlace,
  clearPlacements,
  clearSlot,
  newMatch,
  selectSlot,
  setDifficulty,
  startPlacedMatch,
} from '../state/match';
import {
  ROSTER_SIZE,
  placementComplete,
  placementSlots,
  type PlacementSlot,
} from '../state/placement';
import {
  useActiveSeat,
  useAwaitingSetup,
  useDifficulty,
  useIsHotseat,
  useOnline,
  usePlaced,
  useSeed,
  useSelectedSlot,
} from '../state/useMatch';
import { hexLabel } from './eventText';
import HelpButton from './HelpButton';
import OnlinePanel from './OnlinePanel';
import SoundButton from './SoundButton';

const DIFFICULTIES: readonly CpuDifficulty[] = ['easy', 'medium', 'hard'];

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
    `${UNIT_DEFS.bunker.hp} hits kill it and you lose. Hide it — you cannot defend it directly, and your interceptor base is forbidden from sitting near it (the red wash on the board).`,
  decoy:
    `Empty concrete, identical to your bunker in every way the enemy can observe, but it dies to ${UNIT_DEFS.decoy.hp} hit. Put it somewhere they will believe, and far from the real one: a single drone pass photographs a strip ${2 * RULES.reconSwathRadius + 1} hexes wide, so two sites side by side are found together.`,
  interceptor:
    `Shoots down at most ${RULES.interceptsPerRound} enemy missile per round anywhere within ${RULES.interceptorCoverageRadius} hexes of it, and kills enemy drones that fly in. Stopping a missile gives its position away to the enemy for good. It must sit at least ${RULES.bunkerExclusionRadius} hexes from BOTH of your sites, so it can only defend an approach, never the bunker itself. Red-washed ground is ruled out for that reason.`,
};

/** "Interceptor base 2" — a kind with several slots is numbered, a single one is not. */
function slotLabel(slot: PlacementSlot): string {
  const name = KIND_LABEL[slot.kind];
  return slot.ofKind > 1 ? `${name} ${slot.index}` : name;
}

interface Props {
  /** Opens the how-to-play window, which `App` owns, optionally at a section. */
  onHelp: (section?: string) => void;
}

export default function SetupPanel({ onHelp }: Props) {
  const placed = usePlaced();
  const selectedSlot = useSelectedSlot();
  const seed = useSeed();
  // Who is placing right now. In hotseat this screen is visited twice, once per
  // player, and everything on it — the roster, the highlight, the home-zone rows
  // — belongs to whoever is currently at the keyboard (build-order step 10c).
  const seat = useActiveSeat();
  const hotseat = useIsHotseat();
  const awaiting = useAwaitingSetup();
  // Online (V1.5 Session 6): the seating and the board are the server's, so the
  // panel that chooses them gives way to the room's, and the setup is *sent*.
  const online = useOnline();
  const sent = online?.submitted === true;
  const canPlace = !online || (online.status === 'open' && !sent);
  const difficulty = useDifficulty();

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
        {online && <OnlinePanel />}
        {!online && (
        <>
        {/* Everything that decides WHAT GAME this is lives here, before a
            match exists — the in-game HUD offers none of it (designer's call,
            2026-09-28). Difficulty in particular is locked once the match
            starts: the CPU's hidden setup is built from it. */}
        <section className="panel">
          <h2>
            Nuke Wars
            <span className="head-right">
              <SoundButton />
              <HelpButton onClick={() => onHelp('setup')} />
            </span>
          </h2>

          {!hotseat && (
            <>
              <h3>CPU difficulty</h3>
              <div className="buttons tight">
                {DIFFICULTIES.map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setDifficulty(level)}
                    aria-pressed={difficulty === level}
                    className={difficulty === level ? 'chosen' : undefined}
                  >
                    {level[0].toUpperCase() + level.slice(1)}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="buttons">
            <button type="button" onClick={() => newMatch(Date.now() % 100000)}>
              New map
            </button>
            <button type="button" onClick={() => newMatch()}>
              Reset (seed 42)
            </button>
          </div>

          <p className="footnote">
            Map seed {seed}. Changing players or the map clears your placements.
          </p>
        </section>
        </>
        )}

        <section className="panel setup">
          <h2>
            Secret placement
            <span className="viewing">
              {done} / {ROSTER_SIZE}
            </span>
          </h2>

          <p className="muted">
            You are {seat.toUpperCase()}. Your home is the bottom of the
            board: place your assets on the gold rows, plains or mountain.
            The bunker and decoy may not use the back{' '}
            {RULES.siteBackRowsBarred === 1 ? 'row' : `${RULES.siteBackRowsBarred} rows`}{' '}
            at the map edge.
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

                  {isActive && slot.hex && (
                    <div className="buttons">
                      <button type="button" onClick={() => clearSlot(slot.id)}>
                        Pick back up
                      </button>
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
            <button type="button" onClick={() => startPlacedMatch()} disabled={!ready || !canPlace}>
              {sent
                ? 'Sent — waiting for your opponent'
                : !ready
                ? `Place all ${ROSTER_SIZE} to continue`
                : online
                  ? 'Send setup'
                  : awaiting
                  ? `Done — pass to ${opponentOf(seat).toUpperCase()}`
                  : 'Start match'}
            </button>
            <button
              type="button"
              onClick={() => clearPlacements()}
              disabled={done === 0 || !canPlace}
            >
              Start over
            </button>
          </div>

          <div className="buttons">
            <button type="button" onClick={() => autoPlace()} disabled={!canPlace}>
              {online ? 'Auto-place and send' : 'Auto-place and start'}
            </button>
          </div>

          <p className="footnote">
            Move anything as often as you like — nothing is committed until you
            start. {opponentOf(seat).toUpperCase()} never sees your setup, and
            you never see theirs.
          </p>
        </section>
      </div>
    </div>
  );
}
