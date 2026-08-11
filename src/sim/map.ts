// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.

import { ALL_SPAWN_HEXES, RULES, SPAWNS, TERRAIN_DEFS, TERRAIN_GEN } from './defs';
import {
  axialToOffset,
  hexKey,
  hexesInRange,
  neighbors,
  offsetToAxial,
  type Hex,
  type Offset,
} from './hex';

/**
 * V1 terrain (spec §2). Two types, and that is the whole system:
 *
 * - **plains** — passable, ~85% of the board, the only ground a launcher moves on
 * - **mountain** — impassable to launchers; drones and missiles cross it freely,
 *   and static structures (bunker, decoy, interceptor base) may be *built* on it
 *
 * The old `urban` type was cut on 2026-08-11: it was flagged "visual flavour
 * only in V1" and carried no rule, so it was a third case every terrain switch
 * had to carry for no gameplay. Its V2 role (regime score) is recorded in
 * `docs/v2-backlog.md` and would need reintroducing there.
 */
export type Terrain = 'plains' | 'mountain';

export interface TileData {
  col: number;
  row: number;
  terrain: Terrain;
}

export interface MapData {
  width: number;
  height: number;
  tiles: TileData[];
}

/** Seeded RNG (mulberry32) — same seed always produces the same map. */
export function makeRng(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The same hex seen from the other player's end of the board — a 180° rotation
 * about the map's centre. This is the map's symmetry operation (spec §7): P1
 * holds the south, P2 the north, and every hex of P1's ground corresponds to
 * exactly one hex of P2's.
 *
 * Why a rotation and not a top/bottom mirror, which is the obvious thing to
 * reach for: the map is flat-top hexes in odd-q offset coordinates, so odd
 * columns sit half a hex lower than even ones. That stagger makes a horizontal
 * mirror geometrically impossible — reflecting `row` lands odd columns half a
 * hex off the grid, so mirrored terrain would sit at subtly different distances
 * for the two players. A half-turn has no such problem *provided the width is
 * even* (see the guard in `generateMap`), and it is a true isometry: distances,
 * adjacency, and movement costs all survive it exactly. `map.test.ts` asserts
 * that over every pair of hexes on the board, so this is checked, not assumed.
 */
export function rotate180(
  dims: { width: number; height: number },
  offset: Offset,
): Offset {
  return {
    col: dims.width - 1 - offset.col,
    row: dims.height - 1 - offset.row,
  };
}

/** Map/Set key for an offset position. (`hexKey` is the axial equivalent.) */
function offsetKey(offset: Offset): string {
  return `${offset.col},${offset.row}`;
}

/**
 * Seed spacing between re-roll attempts. The golden-ratio constant is the usual
 * choice for walking a seed space: consecutive attempts land far apart in
 * mulberry32's stream, so attempt 2 is a genuinely different map rather than a
 * nudged version of the one that just failed.
 */
const RESEED_STRIDE = 0x9e3779b9;

/** Why a generated map was thrown away. Surfaced in `generateMap`'s error. */
type MapRejection =
  | 'MOUNTAIN_FRACTION' // outside TERRAIN_GEN.mountainFractionBand
  | 'SPAWNS_DISCONNECTED' // some launcher can never reach the rest of the board
  | 'APPROACH_TOO_LONG'; // detours break the §7 "first blood ~round 3" premise

/**
 * Cheapest ground-travel cost from `start` to every hex reachable from it,
 * keyed by `hexKey`. Terrain only — no units, no movement budget.
 *
 * This deliberately duplicates the shape of `reachableHexes` in movement.ts
 * rather than calling it. movement.ts imports `tileAt` from this file, so
 * importing it back would be a genuine circular import, and the two answer
 * different questions anyway: that one is unit-aware and capped by a unit's
 * movement budget, this one is unbounded and knows nothing about units. It
 * exists so `generateMap` can prove a map is crossable before shipping it.
 * `map.test.ts` cross-checks the two agree on a unit-free board, so the
 * duplication cannot silently drift.
 */
export function groundCostsFrom(
  map: MapData,
  start: Offset,
): Map<string, number> {
  const best = new Map<string, number>();

  const startTile = tileAt(map, start);
  if (!startTile || !TERRAIN_DEFS[startTile.terrain].groundPassable) return best;

  const startHex = offsetToAxial(start);
  best.set(hexKey(startHex), 0);

  // Cheapest-first frontier with a linear scan for the minimum, exactly as in
  // movement.ts — the map is ~300 tiles, so a real priority queue is overkill.
  const frontier: { hex: Hex; cost: number }[] = [{ hex: startHex, cost: 0 }];

  while (frontier.length > 0) {
    let cheapest = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].cost < frontier[cheapest].cost) cheapest = i;
    }
    const [current] = frontier.splice(cheapest, 1);

    for (const next of neighbors(current.hex)) {
      const tile = tileAt(map, axialToOffset(next));
      if (!tile) continue; // off the edge of the map

      const def = TERRAIN_DEFS[tile.terrain];
      if (!def.groundPassable) continue; // mountain

      const cost = current.cost + def.moveCost;
      const key = hexKey(next);
      const existing = best.get(key);
      if (existing !== undefined && existing <= cost) continue;

      best.set(key, cost);
      frontier.push({ hex: next, cost });
    }
  }

  return best;
}

/**
 * Whether this map is playable, or the first reason it is not.
 *
 * Every check here exists because mountains cluster. Scattered singletons could
 * not wall anything off, so the pre-2026-08-11 generator needed no validation
 * at all; ridges can strand a launcher or seal the north/south approach, and
 * neither failure is visible in a screenshot until someone tries to play it.
 */
function validateMap(map: MapData): MapRejection | null {
  const mountains = map.tiles.filter((t) => t.terrain === 'mountain').length;
  const fraction = mountains / map.tiles.length;
  const { min, max } = TERRAIN_GEN.mountainFractionBand;
  if (fraction < min || fraction > max) return 'MOUNTAIN_FRACTION';

  // Every spawn must sit in ONE connected region of plains. This is the check
  // that catches both a wall across the board and a single launcher walled into
  // a pocket — from any one spawn, all the others must be reachable.
  const fromFirst = groundCostsFrom(map, ALL_SPAWN_HEXES[0]);
  for (const spawn of ALL_SPAWN_HEXES) {
    if (!fromFirst.has(hexKey(offsetToAxial(spawn)))) {
      return 'SPAWNS_DISCONNECTED';
    }
  }

  // The §7 tuning premise: a launcher can close to firing range on the enemy's
  // starting line in about three rounds. Detours around ridges lengthen that,
  // and a map that stretches it far enough turns matches into Armistice draws.
  // Both players are checked even though the map is rotationally symmetric —
  // it costs nothing and would catch a future asymmetric spawn table.
  for (const player of ['p1', 'p2'] as const) {
    const enemy = player === 'p1' ? 'p2' : 'p1';

    const firingPositions = new Set<string>();
    for (const enemySpawn of SPAWNS[enemy].launchers) {
      for (const hex of hexesInRange(
        offsetToAxial(enemySpawn),
        RULES.missileRange,
      )) {
        firingPositions.add(hexKey(hex));
      }
    }

    for (const spawn of SPAWNS[player].launchers) {
      const costs = groundCostsFrom(map, spawn);
      let closest = Infinity;
      for (const [key, cost] of costs) {
        if (firingPositions.has(key) && cost < closest) closest = cost;
      }
      if (closest > TERRAIN_GEN.maxApproachCost) return 'APPROACH_TOO_LONG';
    }
  }

  return null;
}

/**
 * One generation attempt: roll the northern half's terrain, then rotate it onto
 * the southern half — both players get terrain identical from their own end of
 * the board.
 *
 * The generated half is P2's (north). P1's ground is its half-turn image, so a
 * mountain 3 rows ahead of a P2 launcher is 3 rows ahead of the corresponding
 * P1 launcher too.
 *
 * Mountains are grown as **ranges** rather than rolled per hex (spec §7). A
 * ridge starts somewhere in the generated half, picks a heading, and walks,
 * veering by one of the six directions whenever `rangeStraightness` says so.
 * Growth is confined to the generated half — a ridge that walks off it restarts
 * elsewhere rather than spilling into hexes the copy pass would overwrite, which
 * is what keeps the final mountain count exact.
 */
function generateAttempt(width: number, height: number, seed: number): MapData {
  const rand = makeRng(seed);
  const dims = { width, height };

  /**
   * Whether this hex is in the half we actually roll terrain for. The other
   * half is copied from its rotation, so exactly one hex of each rotated pair
   * is a source. With an odd height the centre row pairs with itself — the
   * col tiebreak splits it down the middle, and the even-width guard in
   * `generateMap` guarantees no hex is ever its own pair.
   */
  const isSource = ({ col, row }: Offset): boolean => {
    const opposite = rotate180(dims, { col, row });
    return row < opposite.row || (row === opposite.row && col < opposite.col);
  };

  const onMap = ({ col, row }: Offset): boolean =>
    col >= 0 && col < width && row >= 0 && row < height;

  /**
   * Hexes kept mountain-free: every spawn plus everything within
   * `spawnClearanceRadius` of one.
   *
   * Forcing the spawn hex itself to plains — which is all the pre-cluster
   * generator did — stops being enough once mountains form ridges: a plains hex
   * ringed by one is a launcher that cannot move for the entire match, which
   * `validateMap` would reject and re-roll over and over. Keeping the ring clear
   * up front is cheaper than retrying, and it also stops the after-the-fact
   * spawn conversion from punching plains holes through a finished ridge.
   *
   * The set is automatically symmetric: `rotate180` is an isometry, so the ring
   * around a P1 spawn rotates onto the ring around its paired P2 spawn, and
   * `map.test.ts` pins that spawn pairing down.
   */
  const clearHexes = new Set<string>();
  for (const spawn of ALL_SPAWN_HEXES) {
    for (const hex of hexesInRange(
      offsetToAxial(spawn),
      TERRAIN_GEN.spawnClearanceRadius,
    )) {
      const offset = axialToOffset(hex);
      if (onMap(offset)) clearHexes.add(offsetKey(offset));
    }
  }

  // terrain[col][row]. Pre-filled so every cell is a real Terrain at all times:
  // ranges overwrite source cells, the copy pass overwrites the rest.
  const terrain: Terrain[][] = Array.from({ length: width }, () =>
    new Array<Terrain>(height).fill('plains'),
  );

  /** Source-half hexes a mountain is allowed to occupy, in a stable order. */
  const candidates: Offset[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      const offset = { col, row };
      if (!isSource(offset)) continue;
      if (clearHexes.has(offsetKey(offset))) continue;
      candidates.push(offset);
    }
  }

  const eligible = (offset: Offset): boolean =>
    onMap(offset) &&
    isSource(offset) &&
    !clearHexes.has(offsetKey(offset)) &&
    terrain[offset.col][offset.row] === 'plains';

  // Half the board's mountain budget — the copy pass doubles it, so the final
  // count is exactly twice this and the fraction is hit on the nose.
  const halfTarget = Math.round(
    (width * height * TERRAIN_GEN.mountainFraction) / 2,
  );

  const mountains: Offset[] = [];
  const place = (offset: Offset): void => {
    terrain[offset.col][offset.row] = 'mountain';
    mountains.push(offset);
  };

  /** A random plains candidate, or null if the half is saturated. */
  const pickStart = (): Offset | null => {
    if (candidates.length === 0) return null;
    const from = Math.floor(rand() * candidates.length);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[(from + i) % candidates.length];
      if (eligible(candidate)) return candidate;
    }
    return null;
  };

  // --- Grow the ranges ---
  // Budget is split as evenly as the count allows: 23 across 4 ranges is
  // 6/6/6/5, not 5/5/5/8, so no single ridge dominates the half.
  const rangeCount = Math.max(1, TERRAIN_GEN.rangesPerHalf);
  // A ridge that keeps walking into rock or off the half gives up rather than
  // spinning; whatever budget it had left is picked up by the thickening pass.
  const STALL_LIMIT = 24;

  for (let range = 0; range < rangeCount && mountains.length < halfTarget; range++) {
    const remainingRanges = rangeCount - range;
    let budget = Math.ceil((halfTarget - mountains.length) / remainingRanges);

    let cursor = pickStart();
    if (!cursor) break;
    let heading = Math.floor(rand() * 6);
    let stalls = 0;

    while (budget > 0 && stalls < STALL_LIMIT) {
      if (eligible(cursor)) {
        place(cursor);
        budget--;
        stalls = 0;
      } else {
        stalls++;
      }

      // Veer one step clockwise or anticlockwise. Turning by a single direction
      // is what makes these read as ridges rather than random walks: a 60°
      // course change bends the line, a larger one would fold it back on itself.
      if (rand() >= TERRAIN_GEN.rangeStraightness) {
        heading = (heading + (rand() < 0.5 ? 5 : 1)) % 6;
      }

      const next = axialToOffset(neighbors(offsetToAxial(cursor))[heading]);
      if (onMap(next) && isSource(next)) {
        cursor = next;
      } else {
        // Walked off the generated half. Anything placed beyond it would be
        // overwritten by the copy pass, so restart the ridge instead.
        const restart = pickStart();
        if (!restart) break;
        cursor = restart;
        heading = Math.floor(rand() * 6);
        stalls++;
      }
    }
  }

  // --- Thicken to the exact target ---
  // Ranges can stall out short of budget (boxed in by earlier ridges or by the
  // spawn clearance). Topping up by widening what already exists keeps the
  // clustering; seeding a fresh blob is the fallback when nothing can widen.
  let guard = candidates.length * 4;
  while (mountains.length < halfTarget && guard-- > 0) {
    let extended = false;

    for (let attempt = 0; attempt < 8 && !extended && mountains.length > 0; attempt++) {
      const from = mountains[Math.floor(rand() * mountains.length)];
      const ring = neighbors(offsetToAxial(from));
      const start = Math.floor(rand() * 6);
      for (let i = 0; i < 6; i++) {
        const candidate = axialToOffset(ring[(start + i) % 6]);
        if (eligible(candidate)) {
          place(candidate);
          extended = true;
          break;
        }
      }
    }

    if (!extended) {
      const fresh = pickStart();
      if (!fresh) break;
      place(fresh);
    }
  }

  // Copy the generated half onto the other one.
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      if (isSource({ col, row })) continue;
      const src = rotate180(dims, { col, row });
      terrain[col][row] = terrain[src.col][src.row];
    }
  }

  // --- Fold lone mountains back into the ranges ---
  //
  // Two things strand a single mountain hex on its own: a ridge that places its
  // first hex and then immediately walks off the generated half (it restarts
  // elsewhere and never comes back), and the thickening pass's last-resort
  // fresh seed. A lone mountain is noise rather than terrain — it costs a
  // launcher one sidestep and reads as a rendering glitch — so it gets picked
  // up and set down against an existing range instead. The count is unchanged:
  // a hex is only lifted once somewhere to put it has been found.
  //
  // This runs AFTER the copy pass so that adjacency across the centre seam
  // counts — a hex can be a lone mountain in the generated half and still touch
  // its own half-turn twin. That means every write here must be applied to a
  // hex and its twin together; the map's symmetry is not negotiable (§7).

  const isMountainAt = (offset: Offset): boolean =>
    onMap(offset) && terrain[offset.col][offset.row] === 'mountain';

  const touchesMountain = (offset: Offset): boolean =>
    neighbors(offsetToAxial(offset)).some((n) => isMountainAt(axialToOffset(n)));

  const setPaired = (offset: Offset, value: Terrain): void => {
    terrain[offset.col][offset.row] = value;
    const twin = rotate180(dims, offset);
    terrain[twin.col][twin.row] = value;
  };

  /** An eligible hex touching some range other than the one being lifted. */
  const adoptionSite = (exclude: Offset): Offset | null => {
    if (mountains.length === 0) return null;
    const from = Math.floor(rand() * mountains.length);
    for (let i = 0; i < mountains.length; i++) {
      const host = mountains[(from + i) % mountains.length];
      if (host.col === exclude.col && host.row === exclude.row) continue;
      for (const n of neighbors(offsetToAxial(host))) {
        const candidate = axialToOffset(n);
        if (eligible(candidate)) return candidate;
      }
    }
    return null;
  };

  // Relocating never creates a new orphan (the new hex touches its host by
  // construction, and a lifted hex had no mountain neighbours to strand), so a
  // single pass converges. The guard is belt and braces.
  let orphanGuard = mountains.length * 2;
  for (let i = 0; i < mountains.length && orphanGuard-- > 0; ) {
    const orphan = mountains[i];
    if (touchesMountain(orphan)) {
      i++;
      continue;
    }

    const home = adoptionSite(orphan);
    if (!home) {
      i++; // half is saturated — keep the hex rather than lose the count
      continue;
    }

    setPaired(orphan, 'plains');
    mountains.splice(i, 1);
    setPaired(home, 'mountain');
    mountains.push(home);
  }

  // Column-major, which is what tileAt's O(1) index math depends on.
  const tiles: TileData[] = [];
  for (let col = 0; col < width; col++) {
    for (let row = 0; row < height; row++) {
      tiles.push({ col, row, terrain: terrain[col][row] });
    }
  }

  return { width, height, tiles };
}

/**
 * A playable, rotationally symmetric map for `seed`.
 *
 * Generation is generate → validate → re-roll: an attempt that fails
 * `validateMap` is thrown away whole and a fresh one rolled from a derived
 * seed, rather than being patched. Patching is the tempting option and it is a
 * trap — carving a pass through a wall has to be done symmetrically or the two
 * players quietly get different maps, and "quietly different" is the one
 * failure mode this whole layout exists to prevent.
 *
 * Deterministic despite the retries: the retry seeds derive from `seed`, so the
 * same seed always yields the same final map.
 */
export function generateMap(width = 16, height = 19, seed = 42): MapData {
  if (width % 2 !== 0) {
    // Not a style preference — with an odd width the centre column maps onto
    // itself while its own stagger does not, and the two halves stop being
    // congruent. See `rotate180` above.
    throw new Error(
      `map width must be even for the half-turn symmetry to hold, got ${width}`,
    );
  }

  // The SPAWNS table is written for the default board. On a smaller one the
  // spawns fall off the edge and every attempt would fail SPAWNS_DISCONNECTED,
  // which is a confusing way to report "these dimensions have no spawn table".
  for (const spawn of ALL_SPAWN_HEXES) {
    if (
      spawn.col < 0 ||
      spawn.col >= width ||
      spawn.row < 0 ||
      spawn.row >= height
    ) {
      throw new Error(
        `spawn ${spawn.col},${spawn.row} is off a ${width}x${height} map — ` +
          `SPAWNS in defs.ts is defined for the 16x19 board`,
      );
    }
  }

  let lastRejection: MapRejection | null = null;

  for (let attempt = 0; attempt < TERRAIN_GEN.maxAttempts; attempt++) {
    const map = generateAttempt(
      width,
      height,
      (seed + attempt * RESEED_STRIDE) | 0,
    );

    lastRejection = validateMap(map);
    if (lastRejection === null) {
      // Spec §12: the 8 fixed spawn hexes are guaranteed plains. The clearance
      // ring in generateAttempt already ensures this — the loop is the explicit
      // statement of the guarantee, and it fails loudly if that ever changes,
      // rather than shipping an immobile launcher.
      for (const spawn of ALL_SPAWN_HEXES) {
        const tile = tileAt(map, spawn);
        if (tile && tile.terrain !== 'plains') {
          throw new Error(
            `spawn ${spawn.col},${spawn.row} generated as ${tile.terrain}`,
          );
        }
      }
      return map;
    }
  }

  throw new Error(
    `no playable map after ${TERRAIN_GEN.maxAttempts} attempts from seed ${seed} ` +
      `(last rejection: ${lastRejection}). The TERRAIN_GEN constants have drifted ` +
      `past what this board can accommodate.`,
  );
}

/**
 * The tile at a col/row, or `undefined` if the position is off the map.
 *
 * O(1): `generateMap` fills `tiles` in column-major order (every row of col 0,
 * then every row of col 1...), so a tile's index is `col * height + row`.
 * That shortcut depends on the fill order above, so `tileAt` is unit-tested
 * against a linear search across the whole map — if the two ever disagree,
 * the test fails rather than movement silently reading the wrong terrain.
 *
 * Note this is the *only* correct way to bounds-check a position: the map is a
 * rectangle in col/row, which is a slanted parallelogram in axial space, so
 * there's no clean "is this hex on the map" test in axial coordinates.
 */
export function tileAt(map: MapData, offset: Offset): TileData | undefined {
  const { col, row } = offset;
  if (col < 0 || col >= map.width || row < 0 || row >= map.height) {
    return undefined;
  }
  return map.tiles[col * map.height + row];
}
