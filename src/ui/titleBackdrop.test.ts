import { describe, expect, it } from 'vitest';
import {
  DRIFT_PERIOD_S,
  DRIFT_PX_PER_S,
  GRID,
  TILE_H,
  TILE_W,
  titleTileCss,
  titleTileSvg,
} from './titleBackdrop';

describe('title screen map tile', () => {
  it('slides at the designer’s 20 px a second, one tile per period', () => {
    expect(DRIFT_PX_PER_S).toBe(20);
    expect(DRIFT_PERIOD_S * DRIFT_PX_PER_S).toBe(TILE_W);
  });

  // Otherwise the grid lines would jump at the seam every loop.
  it('is a whole number of grid squares each way', () => {
    expect(TILE_W % GRID).toBe(0);
    expect(TILE_H % GRID).toBe(0);
  });

  it('is the same picture on every load', () => {
    expect(titleTileSvg()).toBe(titleTileSvg());
  });

  it('wraps every layer onto all eight neighbouring tiles', () => {
    const svg = titleTileSvg();
    const layers = svg.match(/<g id="l\d+">/g) ?? [];
    expect(layers.length).toBeGreaterThan(0);
    const uses = svg.match(/<use href="#l\d+"/g) ?? [];
    expect(uses.length).toBe(layers.length * 8);
  });

  it('is a well-formed SVG with no stray numbers', () => {
    const svg = titleTileSvg();
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('is ready for a CSS background', () => {
    expect(titleTileCss()).toMatch(/^url\("data:image\/svg\+xml,%3Csvg%20/);
  });
});
