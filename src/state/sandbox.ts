// CLIENT STATE — not simulation code, and deliberately not in `src/sim/`.
//
// The sandbox opponent (build-order step 9). Step 9's goal is "single-player
// sandbox vs a static dummy opponent" (spec §8), and a match cannot start
// without two complete secret setups — so this file invents one for each side
// until step 10 collects them from real players.
//
// It is a *fixture*, not an AI and not a rule. Everything here is a placement
// choice a human will make in step 10's setup UI, which is exactly why it lives
// outside `src/sim/`: the engine must not learn to place assets for anybody.
//
// Two properties are worth stating because tests depend on them:
//
//   1. **It is deterministic.** The same map always produces the same setup, so
//      a sandbox match is as reproducible as the engine under it (spec §6). No
//      `Math.random()` — the client is not held to the sim's determinism rule,
//      but a sandbox you cannot re-run twice is a bad debugging tool.
//   2. **It only ever offers hexes the engine already called legal.** Every
//      placement comes out of `legalPlacementHexes`, the same §12 validator the
//      setup UI will highlight with, so this file cannot drift from the rules —
//      it has no rule knowledge of its own to drift with.

import { RULES, type PlaceableKind } from '../sim/defs';
import type { MapData } from '../sim/map';
import {
  PLACEMENT_ORDER,
  legalPlacementHexes,
  type Placement,
  type PlayerSetup,
} from '../sim/setup';
import type { PlayerId } from '../sim/types';

/**
 * Where in each kind's legal-hex list to take a placement, as a fraction of the
 * list (0 = first, 1 = last). One number per asset, in placement order.
 *
 * `legalPlacementHexes` returns the home zone in column-major order, so these
 * fractions spread the four assets across the width of the zone: the bunker
 * near the middle, the decoy off to one side, and the two bases out at either
 * end. That is a plausible-looking board rather than a good one — the dummy is
 * something to look at and shoot, not an opponent.
 *
 * `sandbox.test.ts` pins the length of each row to `RULES.placementCounts`, so
 * adding a placeable asset to the roster is a compile-clean but test-failing
 * change here rather than a silent index-out-of-bounds at runtime.
 */
export const SANDBOX_PICKS = {
  bunker: [0.5],
  decoy: [0.2],
  interceptor: [0.15, 0.85],
} as const satisfies Record<PlaceableKind, readonly number[]>;

/**
 * A complete, legal secret setup for `player` on `map` (spec §12).
 *
 * Walks `PLACEMENT_ORDER` and asks the engine for the legal hexes at each step,
 * passing everything placed so far — which is precisely the interactive loop the
 * setup UI will run in step 10. The exclusion radius between a base and the two
 * sites (§12) therefore needs no code here: by the time a base is picked, the
 * bunker and decoy are already in `placed`, so the illegal hexes are simply not
 * in the list to pick from.
 *
 * Throws if a step has no legal hex. That cannot happen on a generated 16-wide
 * home zone, so reaching it means either the map generator or `RULES` changed
 * under this file — and a sandbox that silently placed three assets instead of
 * four would fail later, inside `startMatch`, with a much worse error.
 */
export function sandboxSetup(map: MapData, player: PlayerId): PlayerSetup {
  const placed: Placement[] = [];

  for (const kind of PLACEMENT_ORDER) {
    for (let i = 0; i < RULES.placementCounts[kind]; i++) {
      const legal = legalPlacementHexes(map, player, kind, placed);
      if (legal.length === 0) {
        throw new Error(
          `sandboxSetup: no legal hex left for ${player}'s ${kind} (${i + 1} of ${RULES.placementCounts[kind]})`,
        );
      }

      const fraction = SANDBOX_PICKS[kind][i];
      placed.push({ kind, hex: legal[Math.round((legal.length - 1) * fraction)] });
    }
  }

  return placed;
}
