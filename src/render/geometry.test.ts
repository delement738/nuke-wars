import { afterEach, describe, expect, it } from 'vitest';
import { RULES } from '../sim/defs';
import { generateMap } from '../sim/map';
import { hexCenter, setBoardTurned } from './geometry';

const map = generateMap();
const key = ({ x, y }: { x: number; y: number }) => `${x.toFixed(3)},${y.toFixed(3)}`;

/** Average screen y of a player's home-zone tiles. */
function homeY(seat: 'p1' | 'p2'): number {
  const { min, max } = RULES.homeZoneRows[seat];
  const ys = map.tiles
    .filter((t) => t.row >= min && t.row <= max)
    .map((t) => hexCenter(t.col, t.row).y);
  return ys.reduce((a, b) => a + b, 0) / ys.length;
}

describe('setBoardTurned — every player at the bottom of the screen', () => {
  afterEach(() => setBoardTurned(null));

  it('the right way up, P1 holds the bottom', () => {
    expect(homeY('p1')).toBeGreaterThan(homeY('p2'));
  });

  it('turned, P2 holds the bottom', () => {
    setBoardTurned(map);
    expect(homeY('p2')).toBeGreaterThan(homeY('p1'));
  });

  it('turned, the board covers exactly the same tile positions', () => {
    // A half-turn of an even-width odd-q grid lands every tile on another
    // tile's spot. If it did not, hexes would sit half a step off the grid and
    // the camera's fit would frame a different board for P2.
    const upright = new Set(map.tiles.map((t) => key(hexCenter(t.col, t.row))));
    setBoardTurned(map);
    const turned = new Set(map.tiles.map((t) => key(hexCenter(t.col, t.row))));
    expect(turned).toEqual(upright);
  });

  it('turned, P2 sees the same terrain P1 sees in the same screen spot', () => {
    // The map is generated half-turn symmetric, so the two players' screens
    // are identical boards: whatever terrain P1 sees at a pixel, P2 sees too.
    const upright = new Map(map.tiles.map((t) => [key(hexCenter(t.col, t.row)), t.terrain]));
    setBoardTurned(map);
    for (const t of map.tiles) {
      expect(upright.get(key(hexCenter(t.col, t.row)))).toBe(t.terrain);
    }
  });

  it('turned, neighbours stay neighbours on screen', () => {
    // Movement arrows and flight paths are drawn between hex centres, so a
    // tile's on-screen neighbours must still be one hex-width away.
    setBoardTurned(map);
    const a = hexCenter(4, 9);
    const b = hexCenter(4, 10); // straight south of (4, 9) on the real map
    const c = hexCenter(5, 9); // diagonal neighbour
    const step = Math.sqrt(3) * 26;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(step);
    expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeCloseTo(step);
    // ...and real-south is now screen-up for the turned player.
    expect(b.y).toBeLessThan(a.y);
  });

  it('setting null puts the board back the right way up', () => {
    const before = hexCenter(3, 7);
    setBoardTurned(map);
    expect(hexCenter(3, 7)).not.toEqual(before);
    setBoardTurned(null);
    expect(hexCenter(3, 7)).toEqual(before);
  });
});
