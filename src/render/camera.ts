// RENDER LAYER — camera math for the wheel zoom. Pure: no Pixi, no DOM.
//
// `GameCanvas` owns the listeners; this file owns the arithmetic, so the one
// property that matters — the point under the cursor stays under the cursor —
// can be unit-tested without a browser.
//
// The camera is the `world` container's transform: a screen point `p` shows
// the world point `(p - pos) / scale`. Zooming about `p` means picking the new
// `pos` that maps that same world point back onto `p` at the new scale.

/** Zoom limits, shared by the wheel handler and the initial fit. */
export const ZOOM = { min: 0.5, max: 2.5 } as const;

/** The `world` container's transform (uniform scale). */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/**
 * How much of a doubling one unit of wheel delta is worth, per `deltaMode`.
 *
 * Browsers report the wheel in pixels (0), lines (1, Firefox's mouse wheel) or
 * pages (2), so each needs its own rate. These are d3-zoom's, which have had
 * years of every-device testing: a typical mouse notch (100 px, or 3 lines)
 * comes out at about 13–15% per click — close to the old fixed 10%.
 */
const WHEEL_RATE = [0.002, 0.05, 1] as const;

/**
 * Trackpad pinch arrives as a wheel event with `ctrlKey` set (Chrome and
 * Firefox; verified in Chrome only — Safari may use its own gesture events
 * instead) and with far smaller deltas than a scroll, so it gets a bigger
 * rate. 10x makes the board track the fingers roughly 1:1.
 */
const PINCH_BOOST = 10;

/**
 * Cap on one event's zoom, in doublings (0.5 ≈ 41%). Some mice and drivers send
 * one enormous delta per notch; without a cap a single click could slam from
 * one zoom limit to the other.
 */
const MAX_STEP = 0.5;

/**
 * The factor one wheel event multiplies the scale by.
 *
 * Proportional to `deltaY`, not a fixed step: a trackpad sends a stream of
 * tiny deltas and a mouse sends a few big ones, and a fixed step per *event*
 * made the trackpad lurch 10% per frame. Exponential, so zooming in by some
 * amount and back out by the same amount lands exactly where it started.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const rate = (WHEEL_RATE[deltaMode] ?? WHEEL_RATE[0]) * (ctrlKey ? PINCH_BOOST : 1);
  const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, -deltaY * rate));
  return 2 ** step;
}

/**
 * The camera after zooming by `factor` about the screen point (`px`, `py`).
 *
 * The world point under (`px`, `py`) is under it afterwards too. The scale is
 * clamped to `ZOOM`; at a limit the camera comes back unchanged — the same
 * numbers, not a recomputed near-copy — so nothing creeps while the wheel keeps
 * turning against the stop.
 */
export function zoomAt(cam: Camera, px: number, py: number, factor: number): Camera {
  const scale = Math.min(ZOOM.max, Math.max(ZOOM.min, cam.scale * factor));
  if (scale === cam.scale) return cam;

  const wx = (px - cam.x) / cam.scale;
  const wy = (py - cam.y) / cam.scale;
  return { x: px - wx * scale, y: py - wy * scale, scale };
}
