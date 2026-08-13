// CLIENT STATE — not simulation code, and deliberately not in `src/sim/`.
//
// The sandbox opponent's secret setup (build-order step 9). A match cannot start
// without two complete setups (§12), so this file invents one — for the CPU
// always, and for the human when they press Auto-place instead of placing their
// four assets by hand (step 10b).
//
// It is a *fixture*, not an AI and not a rule. Everything here is a placement
// choice a human makes on the setup screen, which is exactly why it lives
// outside `src/sim/`: the engine must not learn to place assets for anybody.
//
// Two properties are worth stating because tests depend on them:
//
//   1. **It is reproducible.** The randomness comes from a caller-supplied
//      seeded `rng`, never `Math.random()`, so a sandbox match at a given seed
//      plays out identically every time — the client is not held to the sim's
//      determinism rule (§6), but a sandbox you cannot re-run twice is a bad
//      debugging tool.
//   2. **It only ever offers hexes the engine already called legal.** Every
//      placement comes out of `legalPlacementHexes`, the same §12 validator the
//      setup UI highlights with, so this file cannot drift from the rules — it
//      has no rule knowledge of its own to drift with.
//
// **Why the placement is random rather than a fixed spot (changed in step 10b).**
// It used to take each asset at a fixed fraction of its legal-hex list, which is
// reproducible but puts the CPU's bunker in the same relative place on every
// board. That was harmless while the human had no way to hunt it and corrosive
// the moment they did: you learn where to point the drone once and the bunker
// hunt — half the game (§12) — stops being a hunt. Seeded randomness keeps the
// reproducibility and drops the tell. `scripts/soak.ts` had already made this
// exact argument and carried its own copy of the walk to avoid the fixture; that
// copy is now this function, imported.

import { RULES } from '../sim/defs';
import type { MapData } from '../sim/map';
import {
  PLACEMENT_ORDER,
  legalPlacementHexes,
  type Placement,
  type PlayerSetup,
} from '../sim/setup';
import type { PlayerId } from '../sim/types';

/**
 * A complete, legal secret setup for `player` on `map`, drawn from `rng`
 * (spec §12).
 *
 * Walks `PLACEMENT_ORDER` and asks the engine for the legal hexes at each step,
 * passing everything placed so far — precisely the interactive loop the setup UI
 * runs. The exclusion radius between a base and the two sites (§12) therefore
 * needs no code here: by the time a base is picked, the bunker and decoy are
 * already in `placed`, so the illegal hexes are simply not in the list.
 *
 * **Never draw the two players' setups from two identically-seeded streams.**
 * Feeding both sides `makeRng(seed)` hands them the same sequence, and each side's
 * setup then becomes a deterministic function of the other's: both take the same
 * fractions of their own legal lists, and because the two home zones are 180°
 * rotations of each other (§7) those lists run in opposite orders, so one
 * player's index `k` pins the other to their index `n-1-k`. In a
 * hidden-information game that is a player who can derive the enemy's board from
 * their own. Same trap as CLAUDE.md gotcha 41. Either seed the two streams
 * differently (what `match.ts` does, so the CPU's board does not depend on
 * whether the human auto-placed) or consume one stream sequentially (what
 * `scripts/soak.ts` does) — what must not happen is two streams from one seed.
 *
 * Throws if a step has no legal hex. That cannot happen on a generated 16-wide
 * home zone, so reaching it means either the map generator or `RULES` changed
 * under this file — and a sandbox that silently placed three assets instead of
 * four would fail later, inside `startMatch`, with a much worse error.
 */
export function sandboxSetup(
  map: MapData,
  player: PlayerId,
  rng: () => number,
): PlayerSetup {
  const placed: Placement[] = [];

  for (const kind of PLACEMENT_ORDER) {
    for (let i = 0; i < RULES.placementCounts[kind]; i++) {
      const legal = legalPlacementHexes(map, player, kind, placed);
      if (legal.length === 0) {
        throw new Error(
          `sandboxSetup: no legal hex left for ${player}'s ${kind} (${i + 1} of ${RULES.placementCounts[kind]})`,
        );
      }

      placed.push({ kind, hex: legal[Math.floor(rng() * legal.length)] });
    }
  }

  return placed;
}
