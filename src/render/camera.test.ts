// Wheel-zoom camera math. Pure — no Pixi, no DOM.

import { describe, expect, it } from 'vitest';
import { type Camera, wheelZoomFactor, ZOOM, zoomAt } from './camera';

/** The world point shown at screen point (px, py). */
const worldAt = (c: Camera, px: number, py: number) => ({
  x: (px - c.x) / c.scale,
  y: (py - c.y) / c.scale,
});

describe('zoomAt', () => {
  const cam: Camera = { x: 40, y: -120, scale: 1 };

  it('keeps the world point under the cursor fixed, zooming in and out', () => {
    for (const factor of [1.3, 0.7, 2, 0.55]) {
      for (const [px, py] of [[0, 0], [300, 450], [812.5, 37.25]]) {
        const next = zoomAt(cam, px, py, factor);
        const before = worldAt(cam, px, py);
        const after = worldAt(next, px, py);
        expect(after.x).toBeCloseTo(before.x, 9);
        expect(after.y).toBeCloseTo(before.y, 9);
      }
    }
  });

  it('holds the cursor point across a long run of small steps', () => {
    // A trackpad pinch is dozens of tiny events; error must not accumulate.
    let c = cam;
    const before = worldAt(cam, 500, 300);
    for (let i = 0; i < 200; i++) c = zoomAt(c, 500, 300, i < 100 ? 1.01 : 0.995);
    const after = worldAt(c, 500, 300);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('clamps the scale and anchors at the clamped scale', () => {
    const next = zoomAt({ x: 0, y: 0, scale: 2 }, 200, 100, 2);
    expect(next.scale).toBe(ZOOM.max);
    expect(worldAt(next, 200, 100).x).toBeCloseTo(100, 9);
    expect(worldAt(next, 200, 100).y).toBeCloseTo(50, 9);
  });

  it('moves nothing at a zoom limit', () => {
    const atMax: Camera = { x: 13, y: 7, scale: ZOOM.max };
    const atMin: Camera = { x: -5, y: 22, scale: ZOOM.min };
    expect(zoomAt(atMax, 400, 300, 1.5)).toBe(atMax);
    expect(zoomAt(atMin, 400, 300, 0.5)).toBe(atMin);
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in on negative deltaY and out on positive', () => {
    expect(wheelZoomFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelZoomFactor(0, 0, false)).toBe(1);
  });

  it('is symmetric: in then out by the same delta returns to the start', () => {
    expect(wheelZoomFactor(-40, 0, false) * wheelZoomFactor(40, 0, false)).toBeCloseTo(1, 12);
  });

  it('gives a mouse notch roughly the old 10% step', () => {
    const notch = wheelZoomFactor(-100, 0, false); // Chrome/Safari pixel mode
    const firefox = wheelZoomFactor(-3, 1, false); // Firefox line mode
    for (const f of [notch, firefox]) {
      expect(f).toBeGreaterThan(1.08);
      expect(f).toBeLessThan(1.2);
    }
  });

  it('scales with deltaY, so small trackpad deltas make small steps', () => {
    const small = wheelZoomFactor(-4, 0, false);
    expect(small).toBeGreaterThan(1);
    expect(small).toBeLessThan(1.01);
  });

  it('boosts pinch (ctrlKey) so it tracks the fingers', () => {
    expect(wheelZoomFactor(-5, 0, true)).toBeCloseTo(wheelZoomFactor(-50, 0, false), 12);
  });

  it('caps one event at 0.5 doublings', () => {
    expect(wheelZoomFactor(-10_000, 0, false)).toBeCloseTo(Math.SQRT2, 12);
    expect(wheelZoomFactor(10_000, 2, true)).toBeCloseTo(Math.SQRT1_2, 12);
  });
});
