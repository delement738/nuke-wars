// CLIENT STATE — not simulation code, and deliberately not in `src/sim/`.
//
// The CPU's secret setup, by difficulty (spec §12). EASY and MEDIUM take the
// seeded-random fixture in `sandbox.ts` unchanged; HARD places its interceptor
// base deliberately, across the approach to its own two sites.
//
// **Why a separate file rather than a smarter `sandboxSetup`.** The fixture has
// three callers and only one of them is the CPU. It is also the human's
// Auto-place, which should stay a neutral "put my assets somewhere legal"
// button rather than a strategy the game plays on your behalf, and the soak's
// EASY/MEDIUM setup. Keeping the fixture dumb and layering the CPU's judgement
// on top means the one decision that changed — where HARD's base goes — is the
// only thing that changed.
//
// **The indistinguishability principle (§12) binds this file**, because a CPU
// that treated its bunker differently from its decoy would leak which is which
// through the base's position — and the base becomes public the first time it
// stops a missile (`BASE_EXPOSED`). Two things keep it honest, and both are
// load-bearing:
//
//   1. **The placer never knows which site is real until the very end.** It
//      draws two site hexes, scores bases against the pair *symmetrically*
//      (the worse-covered of the two), picks the base, and only then flips a
//      coin for which site is the bunker. Nothing upstream of the coin can
//      depend on the answer, so nothing about the base can reveal it.
//   2. **The score is symmetric in the two sites** — the worse-covered of the
//      pair (`min`). A sum is symmetric too and soaked about the same; `min` was
//      kept because a sum is content to park the base over one site and leave
//      the other bare, which defends the real bunker only half the time.
//
// Measured 2026-09-27, hard vs medium, before → after:
//   `SOAK_MATCHES=60`, seeds 3 / 7 / 11: 54–38 / 55–35 / 54–33 → 59–31 / 56–33 / 56–31
//   `SOAK_MATCHES=200`, seed 3:          173–138 → 199–112
// Hard mirror (seed 3, 60): interceptions per side 0.5 → 1.6, bases exposed
// 0.36 → 0.72, bases killed 0.08 → 0.38, Armistice 7 → 5. Hits on the real
// bunker did NOT fall in the mirror (0.75 → 0.80): HARD's attacker answers an
// exposed base with a volley and then walks through. See CLAUDE.md for the
// variants that lost.

import { RULES, TERRAIN_DEFS } from '../sim/defs';
import { axialToOffset, distance, hexLine, hexesInRange, type Hex } from '../sim/hex';
import { lineOfFireClear, tileAt, type MapData } from '../sim/map';
import { legalPlacementHexes, type Placement, type PlayerSetup } from '../sim/setup';
import type { PlayerId } from '../sim/types';
import type { CpuDifficulty } from './cpu';
import { sandboxSetup } from './sandbox';

/**
 * The farthest apart HARD will put its two sites.
 *
 * One radius-2 base, held ≥ 3 from each site, cannot sit across the approach to
 * two sites in opposite corners, so without a cap the symmetric score is ~0 for
 * every base and the placement collapses back to random. 8 only rules out the
 * far-corner pairs: the bunker's own position stays close to uniform over the
 * home zone (checked over 2000 boards), and the mean site gap drops from 6.0 to
 * 4.5. Spec §12's "far apart is usually stronger" note still points the right
 * way for a human; this is the price of one base covering both.
 *
 * The cap on its own is harmful — with a random base it took hard vs medium to
 * 43–48 on seed 3. It only pays with the scored base below.
 */
export const HARD_SITE_GAP_MAX = 8;

/**
 * How far below the best score a base may be and still be drawn.
 *
 * Randomness among near-equals, so a HARD board is not a fixed function of
 * where its sites ended up. Tighter (0.03) and looser (0.25) both measured
 * worse on seed 3, though within noise.
 */
const COVERAGE_TOLERANCE = 0.1;

/**
 * The shortest shot the lane model counts. HARD closes to the edge of its reach
 * before firing (`pickAdvanceDestination`), so the lanes that matter are the
 * long ones; counting only 5–6 or only 6 measured no better.
 */
const LANE_MIN_RANGE = 4;

/**
 * A complete, legal secret setup for `player`, as the CPU at `difficulty`
 * would place it (spec §12).
 *
 * EASY and MEDIUM are `sandboxSetup` exactly — same picks from the same stream —
 * so their boards did not change when this was added.
 */
export function cpuSetup(
  map: MapData,
  player: PlayerId,
  difficulty: CpuDifficulty,
  rng: () => number,
): PlayerSetup {
  if (difficulty !== 'hard') return sandboxSetup(map, player, rng);

  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)];

  // Two sites, unlabelled. Both come from the engine's own legal lists, and the
  // second is asked for with the first already down, so HEX_TAKEN is the
  // engine's call rather than ours. The bunker and decoy lists are the same
  // list (§12), so which kind is asked for here does not matter.
  const first = pick(legalPlacementHexes(map, player, 'bunker', []));
  const partners = legalPlacementHexes(map, player, 'decoy', [
    { kind: 'bunker', hex: first },
  ]).filter((hex) => distance(hex, first) <= HARD_SITE_GAP_MAX);
  // Unreachable on a generated board (a 96-hex zone always has a legal hex
  // within 8), but fail here rather than inside `startMatch`, as sandboxSetup does.
  if (partners.length === 0) throw new Error(`cpuSetup: no second site for ${player}`);
  const second = pick(partners);

  const lanesA = approachLanes(map, player, first);
  const lanesB = approachLanes(map, player, second);
  const pair: Placement[] = [
    { kind: 'bunker', hex: first },
    { kind: 'decoy', hex: second },
  ];
  // The ≥3 exclusion is symmetric in the two sites (§12), so asking with this
  // provisional labelling gives the same list as asking with the final one.
  const scored = legalPlacementHexes(map, player, 'interceptor', pair).map((hex) => ({
    hex,
    score: Math.min(laneCoverage(hex, lanesA), laneCoverage(hex, lanesB)),
  }));
  const best = Math.max(...scored.map((s) => s.score));
  const base = pick(scored.filter((s) => s.score >= best - COVERAGE_TOLERANCE)).hex;

  // The coin comes LAST — see the header.
  const [bunker, decoy] = rng() < 0.5 ? [first, second] : [second, first];
  return [
    { kind: 'bunker', hex: bunker },
    { kind: 'decoy', hex: decoy },
    { kind: 'interceptor', hex: base },
  ];
}

/**
 * The flight paths an enemy missile at `site` would plausibly fly: every hex a
 * launcher could stand on (plains, on the map) at range `LANE_MIN_RANGE` to
 * `missileRange`, on the enemy's side of the site's row, with a clear line of
 * fire (§10) — the approach. Each path drops its origin, as `createMissile`
 * does (§10), since the origin hex is never intercept-checked.
 */
export function approachLanes(map: MapData, player: PlayerId, site: Hex): Hex[][] {
  const siteRow = axialToOffset(site).row;
  const lanes: Hex[][] = [];

  for (const origin of hexesInRange(site, RULES.missileRange)) {
    if (distance(origin, site) < LANE_MIN_RANGE) continue;

    const tile = tileAt(map, axialToOffset(origin));
    if (!tile || !TERRAIN_DEFS[tile.terrain].groundPassable) continue;

    // P1's home zone is the south edge, so the enemy comes from lower rows.
    const row = axialToOffset(origin).row;
    if (player === 'p1' ? row > siteRow : row < siteRow) continue;

    // A lane a mountain blocks is not a lane (§10, 2026-09-28): no missile can
    // fly it, so covering it defends nothing.
    if (!lineOfFireClear(map, origin, site)) continue;

    lanes.push(hexLine(origin, site).slice(1));
  }

  return lanes;
}

/** The fraction of `lanes` that pass through the bubble of a base on `base`. */
export function laneCoverage(base: Hex, lanes: readonly Hex[][]): number {
  if (lanes.length === 0) return 0;
  const covered = lanes.filter((lane) =>
    lane.some((hex) => distance(hex, base) <= RULES.interceptorCoverageRadius),
  );
  return covered.length / lanes.length;
}
