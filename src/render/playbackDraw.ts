// RENDER LAYER — placeholder visuals for the replay (presentation phase,
// session 1). Session 2 replaces these with missile trails and explosions; the
// engine (`./timeline` + the ticker in `GameCanvas`) stays.
//
// Every visual is drawn from **the event's own fields and the viewer's own
// pre-resolution board** — nothing else is in reach. That is what keeps the
// hidden-information rules intact without this file having to know them: an
// `IMPACT` looks identical whatever it hit, because the event does not say
// (spec §6, gotcha 60), and a `BUNKER_HIT` can only ever be drawn on the
// viewer's own bunker, because only its owner receives one.
//
// Three layers with different redraw rates:
//   - **shapes** — tokens, lines, bursts — redrawn every frame;
//   - **labels** — the words next to each effect — redrawn only when a clip
//     starts or finishes (`labelKey`), because building Pixi `Text` sixty times
//     a second is the one expensive thing here;
//   - **caption** — screen-space, not board-space: the phase being played and
//     the skip hint, plus a big banner for a verdict.

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { Hex } from '../sim/hex';
import type { Unit, UnitId, VisibleEvent } from '../sim/types';
import { COLOR, GLYPH, GLYPH_STYLE, INTEL_STYLE, centerOf, glyphAt } from './draw';
import { HEX, hexCorners } from './geometry';
import type { ClipFrame } from './timeline';

/** What the drawing needs besides the frames: whose replay this is. */
export interface ReplayContext {
  /** The viewer's own units as they stood BEFORE the round — the backdrop. */
  own: readonly Unit[];
}

const FX = {
  burst: 0xfff1a8,
  impact: 0xffa54a,
  scorch: 0x2a1a10,
  label: 0xf5f7fa,
} as const;

const LABEL_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 11,
  fontWeight: 'bold',
  fill: FX.label,
  stroke: { color: 0x0b0f14, width: 3 },
});

const CAPTION_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 16,
  fontWeight: 'bold',
  fill: FX.label,
});

const BANNER_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 34,
  fontWeight: 'bold',
  fill: COLOR.enemy,
  stroke: { color: 0x0b0f14, width: 6 },
});

function clear(layer: Container): void {
  for (const child of layer.removeChildren()) child.destroy({ children: true });
}

function isOwn(ctx: ReplayContext, unitId: UnitId): boolean {
  return ctx.own.some((unit) => unit.id === unitId);
}

function ownUnit(ctx: ReplayContext, unitId: UnitId): Unit | undefined {
  return ctx.own.find((unit) => unit.id === unitId);
}

/** A launch whose origin is one of the viewer's launchers is theirs — the
 *  origin identifies the firer to its owner and to nobody else (spec §6). */
function isOwnLaunch(ctx: ReplayContext, origin: Hex): boolean {
  return ctx.own.some(
    (unit) =>
      unit.kind === 'launcher' &&
      !unit.destroyed &&
      unit.position.q === origin.q &&
      unit.position.r === origin.r,
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** A point `t` of the way along a path of hexes. */
function alongPath(path: readonly Hex[], t: number): { x: number; y: number } {
  if (path.length === 1) return centerOf(path[0]);
  const scaled = t * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(scaled));
  const a = centerOf(path[i]);
  const b = centerOf(path[i + 1]);
  const local = scaled - i;
  return { x: lerp(a.x, b.x, local), y: lerp(a.y, b.y, local) };
}

function token(g: Graphics, x: number, y: number, color: number): void {
  g.poly(hexCorners(x, y, HEX * 0.62))
    .fill(color)
    .stroke({ width: 2, color: COLOR.outline });
}

function cross(g: Graphics, x: number, y: number, size: number, color: number): void {
  g.moveTo(x - size, y - size)
    .lineTo(x + size, y + size)
    .moveTo(x + size, y - size)
    .lineTo(x - size, y + size)
    .stroke({ width: 4, color });
}

/** Drones whose `DRONE_DOWNED` beat has started — their flying token stops. */
function downedDrones(frames: readonly ClipFrame[]): Set<UnitId> {
  const downed = new Set<UnitId>();
  for (const { clip } of frames) {
    if (clip.event.type === 'DRONE_DOWNED') downed.add(clip.event.unitId);
  }
  return downed;
}

// --- shapes (every frame) ---------------------------------------------------

/**
 * Everything that moves. Rebuilt from scratch each frame, like every other layer
 * in this directory — at this size that is cheap and cannot drift.
 *
 * Tokens that carry a letter (the sliding launcher, the flying drone) put the
 * letter here too, since it must move with them; `GLYPH_STYLE` text is small
 * and there are at most a handful in flight.
 */
export function drawReplayShapes(
  layer: Container,
  frames: readonly ClipFrame[],
  ctx: ReplayContext,
): void {
  clear(layer);
  const g = new Graphics();
  layer.addChild(g);
  const downed = downedDrones(frames);

  for (const { clip, progress: p } of frames) {
    const event = clip.event;
    switch (event.type) {
      case 'DRONE_MOVED': {
        // Trail over the ground covered so far, then the drone itself.
        const reached = alongPath(event.path, p);
        const trail = event.path.map(centerOf);
        const upTo = Math.floor(p * (trail.length - 1));
        if (trail.length > 1) {
          g.moveTo(trail[0].x, trail[0].y);
          for (let i = 1; i <= upTo; i++) g.lineTo(trail[i].x, trail[i].y);
          g.lineTo(reached.x, reached.y).stroke({ width: 3, color: COLOR.fly, alpha: 0.6 });
        }
        if (!downed.has(event.unitId)) {
          token(g, reached.x, reached.y, COLOR.own);
          layer.addChild(glyphAt(GLYPH.drone, reached.x, reached.y, GLYPH_STYLE));
        }
        break;
      }
      case 'ASSET_SPOTTED': {
        const { x, y } = centerOf(event.hex);
        g.circle(x, y, HEX * lerp(1.4, 0.55, p)).stroke({ width: 3, color: COLOR.enemy });
        break;
      }
      case 'DRONE_DOWNED': {
        const { x, y } = centerOf(event.hex);
        cross(g, x, y, HEX * 0.45 * Math.min(1, p * 2), COLOR.enemy);
        break;
      }
      case 'LAUNCH_DETECTED': {
        const a = centerOf(event.origin);
        const b = centerOf(event.target);
        const color = isOwnLaunch(ctx, event.origin) ? COLOR.launch : COLOR.enemy;
        const tip = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) };
        g.moveTo(a.x, a.y).lineTo(tip.x, tip.y).stroke({ width: 3, color, alpha: p < 1 ? 1 : 0.45 });
        g.circle(tip.x, tip.y, 5).fill(color);
        if (p === 1) g.circle(b.x, b.y, HEX * 0.5).stroke({ width: 2, color, alpha: 0.7 });
        break;
      }
      case 'MISSILE_INTERCEPTED': {
        const { x, y } = centerOf(event.hex);
        if (p < 1) {
          g.circle(x, y, HEX * lerp(0.2, 1.1, p)).fill({ color: FX.burst, alpha: 1 - p });
        } else {
          cross(g, x, y, HEX * 0.25, FX.burst);
        }
        break;
      }
      case 'BASE_EXPOSED': {
        const { x, y } = centerOf(event.hex);
        g.poly(hexCorners(x, y, HEX * lerp(1.2, 0.62, p))).stroke({ width: 3, color: COLOR.enemy });
        break;
      }
      case 'IMPACT': {
        // Identical whatever was on the hex — the event does not say (§6).
        const { x, y } = centerOf(event.hex);
        g.circle(x, y, HEX * 0.7).fill({ color: FX.scorch, alpha: 0.6 * p });
        if (p < 1) g.circle(x, y, HEX * lerp(0.3, 1.3, p)).fill({ color: FX.impact, alpha: 1 - p });
        break;
      }
      case 'BUNKER_HIT': {
        const { x, y } = centerOf(event.hex);
        g.poly(hexCorners(x, y, HEX * 0.8)).stroke({
          width: 4,
          color: COLOR.enemy,
          alpha: p < 1 ? 0.5 + 0.5 * Math.sin(p * Math.PI * 4) : 1,
        });
        break;
      }
      case 'UNIT_DESTROYED': {
        const { x, y } = centerOf(event.hex);
        cross(g, x, y, HEX * 0.55 * Math.min(1, p * 2), COLOR.enemy);
        break;
      }
      case 'UNIT_MOVED': {
        const a = centerOf(event.from);
        const b = centerOf(event.to);
        const x = lerp(a.x, b.x, p);
        const y = lerp(a.y, b.y, p);
        g.moveTo(a.x, a.y).lineTo(x, y).stroke({ width: 2, color: COLOR.move, alpha: 0.6 });
        token(g, x, y, COLOR.own);
        const kind = ownUnit(ctx, event.unitId)?.kind ?? 'launcher';
        layer.addChild(glyphAt(GLYPH[kind], x, y, GLYPH_STYLE));
        break;
      }
      case 'MOVE_FAILED': {
        const unit = ownUnit(ctx, event.unitId);
        if (!unit) break;
        const { x, y } = centerOf(unit.position);
        const shake = p < 1 ? Math.sin(p * Math.PI * 8) * 5 * (1 - p) : 0;
        g.poly(hexCorners(x + shake, y, HEX * 0.72)).stroke({ width: 3, color: COLOR.enemy });
        break;
      }
      case 'MARCH_DETECTED': {
        const { x, y } = centerOf(event.origin);
        g.circle(x, y, HEX * lerp(1.3, 0.55, p)).stroke({ width: 3, color: COLOR.march });
        break;
      }
      case 'DRONE_RESPAWNED': {
        const { x, y } = centerOf(event.hex);
        g.poly(hexCorners(x, y, HEX * 0.62))
          .fill({ color: COLOR.own, alpha: p })
          .stroke({ width: 2, color: COLOR.outline, alpha: p });
        const glyph = glyphAt(GLYPH.drone, x, y, GLYPH_STYLE);
        glyph.alpha = p;
        layer.addChild(glyph);
        break;
      }
      case 'DEAD_HAND_TRIGGERED':
      case 'GAME_OVER':
        break; // screen-space — see `verdictBanner`
    }
  }
}

// --- labels (only when a clip starts or finishes) ---------------------------

/** Changes exactly when a label should appear or dim, so the caller can skip
 *  rebuilding `Text` objects on the frames in between. */
export function labelKey(frames: readonly ClipFrame[]): string {
  return frames.map((f) => (f.progress < 1 ? 'a' : 'h')).join('');
}

/** The words for one event, or null for one that speaks for itself. */
function labelFor(event: VisibleEvent, ctx: ReplayContext): { text: string; hex: Hex } | null {
  switch (event.type) {
    case 'DRONE_MOVED':
      return event.path.length === 1
        ? { text: 'DRONE HOVERS', hex: event.to }
        : { text: 'DRONE', hex: event.from };
    case 'ASSET_SPOTTED':
      return { text: 'SPOTTED', hex: event.hex };
    case 'DRONE_DOWNED':
      return {
        text: isOwn(ctx, event.unitId) ? 'YOUR DRONE DOWN' : 'ENEMY DRONE DOWN',
        hex: event.hex,
      };
    case 'LAUNCH_DETECTED':
      return {
        text: isOwnLaunch(ctx, event.origin) ? 'LAUNCH' : 'ENEMY LAUNCH',
        hex: event.origin,
      };
    case 'MISSILE_INTERCEPTED':
      return { text: 'INTERCEPTED', hex: event.hex };
    case 'BASE_EXPOSED':
      return { text: 'BASE EXPOSED', hex: event.hex };
    case 'IMPACT':
      return { text: 'IMPACT', hex: event.hex };
    case 'BUNKER_HIT':
      return { text: `BUNKER HIT — ${event.hpRemaining} HP`, hex: event.hex };
    case 'UNIT_DESTROYED':
      return {
        text: isOwn(ctx, event.unitId) ? 'LOST' : 'DESTROYED',
        hex: event.hex,
      };
    case 'UNIT_MOVED':
      return null;
    case 'MOVE_FAILED': {
      const unit = ownUnit(ctx, event.unitId);
      return unit ? { text: 'BLOCKED', hex: unit.position } : null;
    }
    case 'MARCH_DETECTED':
      return {
        text: ctx.own.some((u) => u.owner === event.owner) ? 'MARCH HEARD (YOURS)' : 'MARCH HEARD',
        hex: event.origin,
      };
    case 'DRONE_RESPAWNED':
      return { text: 'DRONE BACK', hex: event.hex };
    case 'DEAD_HAND_TRIGGERED':
    case 'GAME_OVER':
      return null;
  }
}

/**
 * The words beside each effect. A clip still playing is labelled at full
 * strength; a finished one stays, dimmed, so by the end of the replay the board
 * still says what happened where.
 */
export function drawReplayLabels(
  layer: Container,
  frames: readonly ClipFrame[],
  ctx: ReplayContext,
): void {
  clear(layer);

  for (const { clip, progress } of frames) {
    const label = labelFor(clip.event, ctx);
    if (!label) continue;

    const { x, y } = centerOf(label.hex);
    const text = new Text({ text: label.text, style: LABEL_STYLE });
    text.anchor.set(0.5, 1);
    text.position.set(x, y - HEX * 0.7);
    text.alpha = progress < 1 ? 1 : 0.6;
    layer.addChild(text);

    // A spotted or exposed asset gets its letter too, in the intel red.
    if (clip.event.type === 'ASSET_SPOTTED') {
      layer.addChild(glyphAt(GLYPH[clip.event.kind], x, y, INTEL_STYLE));
    } else if (clip.event.type === 'BASE_EXPOSED') {
      layer.addChild(glyphAt(GLYPH.interceptor, x, y, INTEL_STYLE));
    }
  }
}

// --- caption (screen space) -------------------------------------------------

/** The big banner for a verdict beat, or null. Worded only from the event. */
export function verdictBanner(frames: readonly ClipFrame[], viewer: string): string | null {
  let banner: string | null = null;
  for (const { clip } of frames) {
    const event = clip.event;
    if (event.type === 'DEAD_HAND_TRIGGERED') {
      banner = event.playerId === viewer ? 'DEAD HAND — YOUR FINAL VOLLEY' : 'DEAD HAND — ENEMY FINAL VOLLEY';
    } else if (event.type === 'GAME_OVER') {
      banner = 'MATCH OVER';
    }
  }
  return banner;
}

/**
 * The fixed caption at the top of the canvas — "Round 4 · Impacts" plus how to
 * skip — and, during a verdict, a banner across the middle. Lives outside the
 * panned/zoomed world so it stays readable wherever the camera is.
 */
export function drawCaption(
  layer: Container,
  screen: { width: number; height: number },
  round: number,
  caption: string | null,
  banner: string | null,
): void {
  clear(layer);

  const line = `Round ${round} replay${caption ? ` — ${caption}` : ''}   ·   Space / click to skip`;
  const text = new Text({ text: line, style: CAPTION_STYLE });
  text.anchor.set(0.5, 0);
  text.position.set(screen.width / 2, 14);

  const pad = 8;
  const box = new Graphics()
    .roundRect(
      text.x - text.width / 2 - pad,
      text.y - pad / 2,
      text.width + pad * 2,
      text.height + pad,
      6,
    )
    .fill({ color: 0x0b0f14, alpha: 0.85 });
  layer.addChild(box, text);

  if (banner) {
    const big = new Text({ text: banner, style: BANNER_STYLE });
    big.anchor.set(0.5);
    big.position.set(screen.width / 2, screen.height / 2);
    layer.addChild(big);
  }
}
