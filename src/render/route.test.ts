// The route a move is drawn through. Pure — no Pixi, no store.

import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { axialToOffset, distance, hexKey, neighbors, offsetToAxial, type Hex } from '../sim/hex';
import { generateMap, tileAt, type MapData } from '../sim/map';
import { reachableHexes } from '../sim/movement';
import type { GameState, Unit } from '../sim/types';
import { groundBlockers, moveRoute, routeForMove } from './route';

/** An all-plains board with mountains on the given offset tiles. */
function board(mountains: readonly [number, number][] = []): MapData {
  const peaks = new Set(mountains.map(([c, r]) => `${c},${r}`));
  const tiles = [];
  // Column-major, as `tileAt` indexes them.
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 12; row++) {
      tiles.push({ col, row, terrain: peaks.has(`${col},${row}`) ? 'mountain' as const : 'plains' as const });
    }
  }
  return { width: 12, height: 12, tiles };
}

const at = (col: number, row: number): Hex => offsetToAxial({ col, row });

/** Every step is to a neighbour, on the board, on plains, not blocked. */
function expectWalkable(map: MapData, route: readonly Hex[], blocked: ReadonlySet<string> = new Set()): void {
  for (let i = 0; i < route.length; i++) {
    const tile = tileAt(map, axialToOffset(route[i]));
    expect(tile?.terrain).toBe('plains');
    if (i > 0) {
      expect(blocked.has(hexKey(route[i]))).toBe(false);
      expect(neighbors(route[i - 1]).map(hexKey)).toContain(hexKey(route[i]));
    }
  }
}

describe('moveRoute', () => {
  it('runs straight across open ground, both ends included', () => {
    const map = board();
    const from = at(5, 8);
    const to = at(5, 5);
    const route = moveRoute(map, from, to)!;
    expect(route).toHaveLength(distance(from, to) + 1);
    expect(route[0]).toEqual(from);
    expect(route[route.length - 1]).toEqual(to);
    expectWalkable(map, route);
    // Straight up a column: every hex stays in column 5.
    expect(route.every((hex) => axialToOffset(hex).col === 5)).toBe(true);
  });

  it('goes round a ridge instead of over it', () => {
    // A wall across columns 2–8 at row 6, straight between the two ends.
    const map = board([[2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6]]);
    const from = at(5, 8);
    const to = at(5, 4);
    const route = moveRoute(map, from, to)!;
    expectWalkable(map, route);
    expect(route.length - 1).toBeGreaterThan(distance(from, to));
    expect(route.map(hexKey)).not.toContain(hexKey(at(5, 6)));
  });

  it('goes round a unit it can see, and never lands on one', () => {
    const map = board();
    const from = at(5, 8);
    const to = at(5, 6);
    const blocked = new Set([hexKey(at(5, 7))]);
    const route = moveRoute(map, from, to, blocked)!;
    expectWalkable(map, route, blocked);
    expect(route).toHaveLength(4);
    expect(moveRoute(map, from, at(5, 7), blocked)).toBeNull();
  });

  it('returns null when walled in, and routeForMove still draws something', () => {
    const map = board([[5, 5]]);
    const from = at(5, 8);
    const to = at(5, 5); // a mountain: no route ends there
    expect(moveRoute(map, from, to)).toBeNull();
    expect(routeForMove(map, from, to, new Set())).toEqual([from, to]);
  });

  it('falls back to mountains-only when visible units seal every way through', () => {
    const map = board();
    const from = at(5, 8);
    const to = at(5, 6);
    const ring = new Set(neighbors(to).map(hexKey));
    const route = routeForMove(map, from, to, ring);
    expect(route).toHaveLength(3);
    expectWalkable(map, route);
  });

  it('draws the same route every time', () => {
    const map = board([[2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6]]);
    const a = moveRoute(map, at(5, 8), at(5, 4));
    const b = moveRoute(map, at(5, 8), at(5, 4));
    expect(a).toEqual(b);
  });

  it('is exactly as long as the sim says the move costs, on real boards', () => {
    for (const seed of [3, 500, 1000]) {
      const map = generateMap(16, 19, seed);
      const blocker: Unit = {
        id: 'b', owner: 'p2', kind: 'launcher', position: at(7, 9), destroyed: false,
      } as Unit;
      for (const start of [at(3, 10), at(8, 11), at(12, 7)]) {
        if (tileAt(map, axialToOffset(start))?.terrain !== 'plains') continue;
        const mover = { id: 'm', owner: 'p1', kind: 'launcher', position: start, destroyed: false } as Unit;
        const state = { map, units: [mover, blocker] } as unknown as GameState;
        const blocked = groundBlockers(state.units, mover.id);
        for (const { hex, cost } of reachableHexes(state, mover, RULES.forcedMarchMovement).values()) {
          const route = moveRoute(map, start, hex, blocked)!;
          expect(route).not.toBeNull();
          expect(route.length - 1).toBe(cost);
          expectWalkable(map, route, blocked);
        }
      }
    }
  });
});

describe('groundBlockers', () => {
  it('skips the mover, the dead and drones', () => {
    const units = [
      { id: 'm', kind: 'launcher', position: at(1, 1), destroyed: false },
      { id: 'a', kind: 'launcher', position: at(2, 2), destroyed: false },
      { id: 'd', kind: 'launcher', position: at(3, 3), destroyed: true },
      { id: 'z', kind: 'drone', position: at(4, 4), destroyed: false },
      { id: 'b', kind: 'decoy', position: at(5, 5), destroyed: false },
    ] as Unit[];
    expect([...groundBlockers(units, 'm')]).toEqual([hexKey(at(2, 2)), hexKey(at(5, 5))]);
  });
});
