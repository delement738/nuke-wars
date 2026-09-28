// RENDER LAYER — the replay's visuals (presentation phase, sessions 1–2).
// Session 2 replaced the missile placeholders with trails along `hexLine`,
// intercept bursts and impact explosions; where each missile goes is planned in
// `./flights`, from public facts only.
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
import { RULES } from '../sim/defs';
import { axialToOffset, distance, hexKey, hexesInRange, type Hex } from '../sim/hex';
import { tileAt, type MapData } from '../sim/map';
import { reconSwath } from '../sim/recon';
import type { MissileId, Unit, UnitId, VisibleEvent } from '../sim/types';
import {
  COLOR,
  GLYPH,
  GLYPH_STYLE,
  INTEL_STYLE,
  centerOf,
  dashedLine,
  glyphAt,
  inboundWarning,
  missileColor,
  missileHead,
  warningLabel,
} from './draw';
import {
  inboundText,
  roundsLeftFrom,
  warningLine,
  type Flight,
  type FlightLeg,
} from './flights';
import { HEX, hexCorners } from './geometry';
import type { ClipFrame } from './timeline';
import { downedOnFirstStep } from '../state/inference';

/** What the drawing needs besides the frames: whose replay this is. */
export interface ReplayContext {
  /** The viewer's own units as they stood BEFORE the round — the backdrop. */
  own: readonly Unit[];
  /** Where each missile goes, from `planFlights` (session 2). */
  flights: ReadonlyMap<MissileId, Flight>;
  /** The board, for keeping the intel washes on it (gotcha 37). Public. */
  map: MapData;
  /** Every event of the round being replayed — for the one label that depends
   *  on a later event of the same round (`downedOnFirstStep`). */
  events: readonly VisibleEvent[];
}

const FX = {
  burst: 0xfff1a8,
  flash: 0xffffff,
  fireball: 0xff7a2a,
  core: 0xffd54a,
  smoke: 0x9aa4b0,
  scorch: 0x2a1a10,
  label: 0xf5f7fa,
} as const;

/** The share of an intercept/impact clip spent on a carried missile's final
 *  dive before its burst. Zero-length when there is no dive to draw. */
const DIVE = 0.35;

const LABEL_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 11,
  fontWeight: 'bold',
  fill: FX.label,
  stroke: { color: 0x0b0f14, width: 3 },
});

/** The rule under a base disc (session 3), in the intel red. */
const DISC_STYLE = new TextStyle({ ...LABEL_STYLE, fill: COLOR.enemy });

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

/**
 * "Some enemy base is within range of here" (session 3): every on-board hex a
 * base could stand on to have covered `center`, washed in red and fading in with
 * `p`. The raw disc, deliberately — the replay states the rule, and the settled
 * board then shows what the player's whole history narrows it to
 * (`enemyBaseCandidates`).
 */
function baseDisc(g: Graphics, ctx: ReplayContext, center: Hex, p: number): void {
  const alpha = 0.24 * Math.min(1, p * 2);
  for (const hex of hexesInRange(center, RULES.interceptorCoverageRadius)) {
    if (!tileAt(ctx.map, axialToOffset(hex))) continue;
    const { x, y } = centerOf(hex);
    g.poly(hexCorners(x, y)).fill({ color: COLOR.enemy, alpha });
  }
  const { x, y } = centerOf(center);
  g.circle(x, y, DISC_REACH).stroke({ width: 2, color: COLOR.enemy, alpha: 0.8 * Math.min(1, p * 2) });
}

/** Radius of the ring drawn round a base disc: half a hex past its outer row. */
const DISC_REACH = HEX * Math.sqrt(3) * (RULES.interceptorCoverageRadius + 0.5);

/** The hex a base disc is centred on, or null if this clip draws none: our own
 *  drone going down, or our own missile stopped before any exposure explains it. */
function discCenter(
  event: VisibleEvent,
  frames: readonly ClipFrame[],
  ctx: ReplayContext,
): Hex | null {
  if (event.type === 'DRONE_DOWNED') return isOwn(ctx, event.unitId) ? event.hex : null;
  if (event.type === 'MISSILE_INTERCEPTED') {
    const mine = ctx.flights.get(event.missileId)?.mine ?? false;
    return mine && !answered(frames, event.hex) ? event.hex : null;
  }
  return null;
}

/** A base exposed near `hex` in this replay has answered the question the disc
 *  about it was asking, so the disc gives way to the exact mark. */
function answered(frames: readonly ClipFrame[], hex: Hex): boolean {
  return frames.some(
    ({ clip }) =>
      clip.event.type === 'BASE_EXPOSED' &&
      distance(clip.event.hex, hex) <= RULES.interceptorCoverageRadius,
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

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 2;
}

/** A point at a fractional index along a missile's line. */
function onLine(line: readonly Hex[], at: number): { x: number; y: number } {
  const i = Math.min(line.length - 1, Math.max(0, Math.floor(at)));
  if (i >= line.length - 1) return centerOf(line[line.length - 1]);
  const a = centerOf(line[i]);
  const b = centerOf(line[i + 1]);
  return { x: lerp(a.x, b.x, at - i), y: lerp(a.y, b.y, at - i) };
}

/**
 * One missile part-way along a leg: a faint contrail over everything it has
 * flown this leg, a hot tapering trail just behind it, and the missile itself.
 * Every point is on `hexLine`, so the picture is the path the sim flew.
 */
function drawFlight(g: Graphics, flight: Flight, leg: FlightLeg, t: number, color: number): void {
  const at = lerp(leg.from, leg.to, t);
  const start = onLine(flight.line, leg.from);
  const head = onLine(flight.line, at);
  g.moveTo(start.x, start.y).lineTo(head.x, head.y).stroke({ width: 2, color, alpha: 0.3 });

  const SEGMENTS = 8;
  const tail = Math.max(leg.from, at - 1.5);
  for (let i = 0; i < SEGMENTS; i++) {
    const a = onLine(flight.line, lerp(tail, at, i / SEGMENTS));
    const b = onLine(flight.line, lerp(tail, at, (i + 1) / SEGMENTS));
    const k = (i + 1) / SEGMENTS;
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1 + 4 * k, color, alpha: 0.15 + 0.75 * k });
  }
  missileHead(g, head.x, head.y, color);
}

/** Smoke thrown up at the launcher as the missile leaves. */
function launchPuff(g: Graphics, origin: Hex, p: number): void {
  if (p >= 0.45) return;
  const k = p / 0.45;
  const { x, y } = centerOf(origin);
  g.circle(x, y, HEX * lerp(0.3, 0.85, easeOut(k))).fill({ color: FX.smoke, alpha: 0.45 * (1 - k) });
}

/**
 * An impact at (x, y), `q` of the way through: white flash, orange fireball,
 * shockwave ring, and a scorch mark that stays.
 *
 * **Takes a point and a clock and nothing else** (spec §6, gotcha 60): it has
 * no way to know what, if anything, was on the hex, so an impact on a bunker,
 * a decoy, a launcher or bare ground is the same picture. What was hit is told
 * afterwards, only by the damage events the viewer is allowed to receive.
 */
function impactBlast(g: Graphics, x: number, y: number, q: number): void {
  g.circle(x, y, HEX * 0.7).fill({ color: FX.scorch, alpha: 0.6 * Math.min(1, q * 2) });
  if (q < 1) {
    const ring = easeOut(q);
    g.circle(x, y, HEX * lerp(0.4, 1.6, ring)).stroke({
      width: 4 * (1 - q) + 1,
      color: FX.core,
      alpha: 0.9 * (1 - q),
    });
  }
  if (q < 0.7) {
    const k = q / 0.7;
    const r = HEX * lerp(0.35, 0.95, easeOut(k));
    g.circle(x, y, r).fill({ color: FX.fireball, alpha: 1 - k });
    g.circle(x, y, r * 0.55).fill({ color: FX.core, alpha: 1 - k });
  }
  if (q < 0.15) {
    g.circle(x, y, HEX * lerp(0.9, 0.5, q / 0.15)).fill({ color: FX.flash, alpha: 1 - q / 0.15 });
  }
}

/** A missile shot down over (x, y): a flash, a ring of sparks, a puff of smoke,
 *  and a small mark where it died. Mid-air, so no scorch. */
function interceptBurst(g: Graphics, x: number, y: number, q: number): void {
  if (q < 1) {
    const k = easeOut(q);
    g.circle(x, y, HEX * lerp(0.2, 0.9, k)).fill({ color: FX.smoke, alpha: 0.35 * (1 - q) });
    g.circle(x, y, HEX * lerp(0.2, 1.0, k)).stroke({ width: 3, color: FX.burst, alpha: 1 - q });
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const r1 = HEX * lerp(0.15, 0.6, k);
      const r2 = HEX * lerp(0.35, 1.1, k);
      g.moveTo(x + Math.cos(angle) * r1, y + Math.sin(angle) * r1)
        .lineTo(x + Math.cos(angle) * r2, y + Math.sin(angle) * r2)
        .stroke({ width: 2, color: FX.burst, alpha: 1 - q });
    }
  }
  if (q < 0.2) g.circle(x, y, HEX * 0.45).fill({ color: FX.flash, alpha: 1 - q / 0.2 });
  if (q >= 0.5) cross(g, x, y, HEX * 0.22, FX.burst);
}

/** Missiles whose intercept or impact clip has started — their launch clip
 *  stops drawing them, and the end clip takes over. */
function endedMissiles(frames: readonly ClipFrame[]): Set<MissileId> {
  const ended = new Set<MissileId>();
  for (const { clip } of frames) {
    const e = clip.event;
    if (e.type === 'IMPACT' || e.type === 'MISSILE_INTERCEPTED') ended.add(e.missileId);
  }
  return ended;
}

/**
 * An intercept or impact clip: a carried missile's final dive first (if the
 * launch clip did not already bring it here), then the burst. Returns how far
 * through the burst we are, or null while the dive is still playing.
 */
function afterDive(
  g: Graphics,
  flight: Flight | undefined,
  p: number,
): number | null {
  const leg = flight?.finalLeg;
  if (!flight || !leg) return p;
  const color = missileColor(flight.mine);
  if (p < DIVE) {
    // The warning stays up until the missile arrives.
    inboundWarning(g, flight.line[flight.line.length - 1], color);
    drawFlight(g, flight, leg, easeInOut(p / DIVE), color);
    return null;
  }
  const start = onLine(flight.line, leg.from);
  const end = onLine(flight.line, leg.to);
  const q = (p - DIVE) / (1 - DIVE);
  g.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ width: 2, color, alpha: 0.3 * (1 - q) + 0.1 });
  return q;
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
  const ended = endedMissiles(frames);

  for (const { clip, progress: p } of frames) {
    const event = clip.event;
    switch (event.type) {
      case 'DRONE_MOVED': {
        // Trail over the ground covered so far, then the drone itself.
        const reached = alongPath(event.path, p);
        const trail = event.path.map(centerOf);
        const upTo = Math.floor(p * (trail.length - 1));
        // The ground photographed so far (session 3): the corridor of every hex
        // transmitted from up to here, from the sim's own `reconSwath`. Brighter
        // than the settled wash on purpose — this round's pictures.
        const swath = reconSwath(event.path.slice(0, upTo + 1));
        const washed = new Set<string>();
        for (const step of event.path.slice(0, upTo + 1)) {
          for (const hex of hexesInRange(step, RULES.reconSwathRadius)) {
            const key = hexKey(hex);
            if (washed.has(key) || !swath.has(key) || !tileAt(ctx.map, axialToOffset(hex))) continue;
            washed.add(key);
            const c = centerOf(hex);
            g.poly(hexCorners(c.x, c.y)).fill({ color: COLOR.seen, alpha: 0.1 });
          }
        }
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
        // Only our own drone is a clue. Theirs dying says their drone met OUR
        // base, which we already know about.
        const disc = discCenter(event, frames, ctx);
        if (disc) baseDisc(g, ctx, disc, p);
        const { x, y } = centerOf(event.hex);
        cross(g, x, y, HEX * 0.45 * Math.min(1, p * 2), COLOR.enemy);
        break;
      }
      case 'LAUNCH_DETECTED': {
        const flight = ctx.flights.get(event.missileId);
        const leg = flight?.launchLeg;
        if (!flight || !leg) break;
        const color = missileColor(flight.mine);
        launchPuff(g, event.origin, p);

        if (p < 1) {
          drawFlight(g, flight, leg, easeInOut(p), color);
          break;
        }
        const start = onLine(flight.line, leg.from);
        const end = onLine(flight.line, leg.to);
        if (ended.has(flight.id)) {
          // Its end clip is drawing it now; leave the contrail.
          g.moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ width: 2, color, alpha: 0.2 });
          break;
        }
        drawFlight(g, flight, leg, 1, color);
        if (leg.to < flight.line.length - 1 && flight.end !== 'intercepted') {
          // Parked short of its target: it lands in a later pass (spec §10).
          dashedLine(g, end, centerOf(event.target), { width: 2, color, alpha: 0.9 });
          inboundWarning(g, event.target, color);
        }
        break;
      }
      case 'MISSILE_INTERCEPTED': {
        const q = afterDive(g, ctx.flights.get(event.missileId), p);
        if (q === null) break;
        const { x, y } = centerOf(event.hex);
        // Our missile stopped means an enemy base covers this hex. On a base's
        // first intercept the exposure follows at once and takes over.
        const disc = discCenter(event, frames, ctx);
        if (disc) baseDisc(g, ctx, disc, q);
        interceptBurst(g, x, y, q);
        break;
      }
      case 'BASE_EXPOSED': {
        const { x, y } = centerOf(event.hex);
        g.poly(hexCorners(x, y, HEX * lerp(1.2, 0.62, p))).stroke({ width: 3, color: COLOR.enemy });
        break;
      }
      case 'IMPACT': {
        // Identical whatever was on the hex — `impactBlast` is given a point
        // and a clock, nothing else (spec §6, gotcha 60).
        const q = afterDive(g, ctx.flights.get(event.missileId), p);
        if (q === null) break;
        const { x, y } = centerOf(event.hex);
        impactBlast(g, x, y, q);
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
      // A flight downed on its first step looks exactly like a hover; the
      // round's own DRONE_DOWNED tells them apart (it names our own drone, and
      // the words only drop "HOVERS", so nothing is given away early).
      return event.path.length === 1 && !downedOnFirstStep(event, ctx.events)
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
        text: ctx.flights.get(event.missileId)?.mine ? 'LAUNCH' : 'ENEMY LAUNCH',
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
  const warned = new Map<string, string[]>();

  for (const { clip, progress } of frames) {
    const label = labelFor(clip.event, ctx);
    if (!label) continue;

    // A long shot parked short of its target gets the same warning the board
    // shows between rounds, once its flight has finished.
    if (clip.event.type === 'LAUNCH_DETECTED' && progress === 1) {
      const flight = ctx.flights.get(clip.event.missileId);
      if (flight?.end === 'in-flight' && flight.launchLeg) {
        const color = missileColor(flight.mine);
        const words = inboundText(flight.mine, roundsLeftFrom(flight, flight.launchLeg.to));
        const line = warningLine(warned, clip.event.target, words);
        if (line !== null) layer.addChild(warningLabel(clip.event.target, words, color, line));
      }
    }

    const { x, y } = centerOf(label.hex);
    const text = new Text({ text: label.text, style: LABEL_STYLE });
    text.anchor.set(0.5, 1);
    text.position.set(x, y - HEX * 0.7);
    text.alpha = progress < 1 ? 1 : 0.6;
    layer.addChild(text);

    // The rule a base disc illustrates, on the ring's lower rim — kept off the
    // event's own label, which already shares its hex with others.
    const disc = discCenter(clip.event, frames, ctx);
    if (disc) {
      const c = centerOf(disc);
      const rule = new Text({
        text: `ENEMY BASE WITHIN ${RULES.interceptorCoverageRadius}`,
        style: DISC_STYLE,
      });
      rule.anchor.set(0.5, 0);
      rule.position.set(c.x, c.y + DISC_REACH + 4);
      layer.addChild(rule);
    }

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
