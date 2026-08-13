// RENDER LAYER — PixiJS drawing only (build-order step 9).
//
// Reads state and draws it. Never mutates game state, never decides a rule, and
// never computes what a player may see: everything below takes a
// `VisibleGameState` or a piece of one, which is already redacted (spec §6 layer
// 2). If a drawing function ever needs a fact that is not in its arguments, the
// answer is *not* to reach for the real state — it is that the filter should be
// handing that fact over.
//
// Each function owns one layer and rebuilds it from scratch. That is deliberate
// at this size (~300 tiles, 16 units): a redraw per state change costs nothing
// and cannot desynchronise from the state, whereas incremental patching of Pixi
// objects is the classic source of "the map says something the state doesn't".
// The one exception is terrain, which is redrawn only when the map itself
// changes — it is the largest layer and the map is fixed for a whole match.

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { RULES } from '../sim/defs';
import {
  axialToOffset,
  hexKey,
  hexLine,
  hexesInRange,
  offsetToAxial,
  type Hex,
} from '../sim/hex';
import { tileAt, type MapData, type Terrain } from '../sim/map';
import { reconSwath } from '../sim/recon';
import type {
  MaskedStaticKind,
  Unit,
  UnitKind,
  VisibleGameState,
  VisiblePlayerIntel,
} from '../sim/types';
// Types only. The order builder's shapes live in client state, and the render
// layer is handed them fully assembled — it draws the overlay, it never decides
// what is in one.
import type { DraftEntry, OrderDraft, OrderMode } from '../state/orders';
import type { PlacementSlot } from '../state/placement';
import { HEX, hexCenter, hexCorners } from './geometry';

// --- palette ----------------------------------------------------------------
//
// Two colours carry the entire hidden-information story: **blue is yours, red is
// what you have detected of theirs.** Nothing on this map is ever drawn in the
// enemy's own colours, because nothing on this map is ever the enemy's state —
// it is your intel about them (spec §11).

const COLOR = {
  own: 0x5aa9ff,
  ownDestroyed: 0x4a5563,
  enemy: 0xff5f4a,
  selected: 0xffd54a,
  outline: 0x101820,
  glyph: 0x0b0f14,

  // Order-builder colours. The three modes get three different *visual
  // languages*, not just three hues, because they mean genuinely different
  // things and colour alone would not survive a colour-blind player or a dim
  // screen: MOVE fills ground you may stand on, LAUNCH outlines reach over
  // ground you will never occupy, FLY dots airspace that ignores the ground
  // entirely.
  move: 0x4ad991,
  launch: 0xffa54a,
  fly: 0xb27dff,
  hold: 0x8496aa,

  // Setup-screen colours (build-order step 10b). Gold for ground you may build
  // on, and the enemy red for ground your own exclusion rule denies you —
  // deliberately the same red as detected enemies, because in both cases it
  // means "not yours to use".
  place: 0xf2c14e,
  excluded: 0xff5f4a,
} as const;

// Keyed by Terrain rather than by string, so removing or adding a terrain in the
// sim is a compile error here instead of an undefined fill at runtime.
const FILL: Record<Terrain, number> = {
  plains: 0x1f3d2b, // dark green
  mountain: 0x4a4f57, // slate gray
};

/**
 * One letter per unit kind. The viewer's own decoy is drawn as an X because they
 * know which of their two sites is the fake — the mask is for the enemy (§12),
 * and a player who cannot tell their own bunker from their own decoy cannot
 * play. `MaskedStaticKind` never contains 'decoy', so an enemy site can only
 * ever be drawn 'B'.
 */
const GLYPH: Record<UnitKind, string> = {
  launcher: 'L',
  interceptor: 'I',
  drone: 'D',
  bunker: 'B',
  decoy: 'X',
};

const GLYPH_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 15,
  fontWeight: 'bold',
  fill: COLOR.glyph,
});

const INTEL_STYLE = new TextStyle({
  fontFamily: 'monospace',
  fontSize: 15,
  fontWeight: 'bold',
  fill: COLOR.enemy,
});

/** Empty a layer, destroying what was in it. */
function clear(layer: Container): void {
  for (const child of layer.removeChildren()) child.destroy({ children: true });
}

/**
 * Empty a layer from outside this module (build-order step 10b).
 *
 * Every draw function below rebuilds its layer from scratch, so a layer is
 * normally cleared by drawing it again — but a layer whose *data has gone away*
 * has nothing to redraw it with. That happens twice now: the match layers when
 * a new match sends the client back to the setup screen, and the setup layer
 * when the match starts. Without this they would keep painting the last board
 * they were given, which is the exact "the map says something the state doesn't"
 * failure the rebuild-from-scratch policy exists to prevent.
 */
export function clearLayer(layer: Container): void {
  clear(layer);
}

function centerOf(hex: Hex): { x: number; y: number } {
  const { col, row } = axialToOffset(hex);
  return hexCenter(col, row);
}

function glyphAt(text: string, x: number, y: number, style: TextStyle): Text {
  const label = new Text({ text, style });
  label.anchor.set(0.5);
  label.position.set(x, y);
  return label;
}

// --- terrain ----------------------------------------------------------------

/**
 * The public board (spec §11 — terrain is never hidden, from anyone).
 *
 * Each tile is its own interactive Graphics, which is also the click target:
 * Pixi hit-tests the hex polygon itself, so there is no pixel-to-hex inverse to
 * write and get wrong.
 */
export function drawTerrain(
  layer: Container,
  map: MapData,
  onPick: (hex: Hex) => void,
  onHover: (hex: Hex | null) => void,
): void {
  clear(layer);

  for (const tile of map.tiles) {
    const { x, y } = hexCenter(tile.col, tile.row);
    const hex = offsetToAxial({ col: tile.col, row: tile.row });

    const g = new Graphics()
      .poly(hexCorners(x, y))
      .fill(FILL[tile.terrain])
      .stroke({ width: 1, color: COLOR.outline });

    g.eventMode = 'static';
    g.cursor = 'pointer';
    // Hover is reported as well as shaded, because a straight-line flight has no
    // preview until it has a destination — the cursor supplies it (spec §11:
    // the player steers by choosing sweep lines).
    g.on('pointerover', () => { g.alpha = 0.8; onHover(hex); });
    g.on('pointerout', () => { g.alpha = 1; onHover(null); });
    // `hex` above came from offsetToAxial, never a hand-rolled conversion: the
    // sim reasons in axial and the map stores offsets, and one of those two
    // conversions living in the render layer is how the two coordinate systems
    // start to disagree.
    g.on('pointertap', () => { onPick(hex); });

    layer.addChild(g);
  }
}

// --- highlights -------------------------------------------------------------

/**
 * The ground the viewer's own interceptor bases cover (spec §10).
 *
 * Drawn from the viewer's own units and `RULES.interceptorCoverageRadius`, so it
 * is knowledge they already have rather than a new detector. It is on the map
 * because the rule it illustrates is invisible otherwise: a missile aimed at a
 * base has to cross that base's own bubble, which is why killing one takes a
 * saturating volley (CLAUDE.md gotcha 23).
 */
export function drawCoverage(layer: Container, view: VisibleGameState): void {
  clear(layer);

  for (const unit of view.units) {
    if (unit.kind !== 'interceptor' || unit.destroyed) continue;

    for (const hex of hexesInRange(unit.position, RULES.interceptorCoverageRadius)) {
      // `hexesInRange` is pure geometry and happily returns hexes off the edge
      // of the board — the sim leaves them in because they can never match a
      // unit, but drawing one paints ground that does not exist and makes the
      // board's edge look ragged. `tileAt` is the only correct on-map test: the
      // map is a rectangle in col/row, which is a slanted parallelogram in axial.
      if (!tileAt(view.map, axialToOffset(hex))) continue;

      const { x, y } = centerOf(hex);
      layer.addChild(
        new Graphics()
          .poly(hexCorners(x, y))
          .fill({ color: COLOR.own, alpha: 0.09 }),
      );
    }
  }
}

/** The tile the player clicked. Presentation state — it means nothing to the sim. */
export function drawSelection(layer: Container, selected: Hex | null): void {
  clear(layer);
  if (!selected) return;

  const { x, y } = centerOf(selected);
  layer.addChild(
    new Graphics()
      .poly(hexCorners(x, y))
      .stroke({ width: 3, color: COLOR.selected }),
  );
}

// --- orders (build-order step 10a) -------------------------------------------

/**
 * Everything the orders layer draws, assembled by the caller.
 *
 * The render layer decides nothing: it is handed the unit, the mode, the legal
 * targets and the draft, and draws exactly those. Working out *which* hexes are
 * legal is `src/state/orders.ts`'s job, because that question is answered by the
 * sim's validators and this file is not allowed to know a rule.
 */
export interface OrderOverlay {
  /** The unit whose order is being composed, or null. */
  unit: Unit | null;
  /** The mode it is being composed in, or null when simply inspecting. */
  mode: OrderMode | null;
  /** Legal targets for (unit, mode). Empty unless both are set. */
  targets: readonly Hex[];
  /** The hex under the cursor — previews the exact line before it is committed. */
  hovered: Hex | null;
  /** Decisions already queued this round, drawn as markers. */
  draft: OrderDraft;
}

/** The only correct on-map test (CLAUDE.md gotcha 37) — the map is a rectangle
 *  in col/row, which is a slanted parallelogram in axial, so a straight line
 *  between two on-map hexes can leave the board and a swath certainly does. */
function onBoard(map: MapData, hex: Hex): boolean {
  return tileAt(map, axialToOffset(hex)) !== undefined;
}

/**
 * The corridor a flight along `path` would photograph (spec §11).
 *
 * `reconSwath` is the authority and returns hex *keys*; the geometry below only
 * turns those back into hexes to draw. Filtering the enumeration against the set
 * rather than re-deriving the radius means a retune of `reconSwathRadius` moves
 * the preview with the rule instead of leaving the UI quietly lying.
 */
function swathHexes(path: readonly Hex[]): Hex[] {
  const inSwath = reconSwath(path);
  const seen = new Set<string>();
  const hexes: Hex[] = [];

  for (const step of path) {
    for (const hex of hexesInRange(step, RULES.reconSwathRadius)) {
      const key = hexKey(hex);
      if (seen.has(key) || !inSwath.has(key)) continue;
      seen.add(key);
      hexes.push(hex);
    }
  }
  return hexes;
}

/** A line with an arrowhead at `to`. Used for a committed move. */
function arrow(from: Hex, to: Hex, color: number): Graphics {
  const a = centerOf(from);
  const b = centerOf(to);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = HEX * 0.42;

  return new Graphics()
    .moveTo(a.x, a.y)
    .lineTo(b.x, b.y)
    .stroke({ width: 3, color })
    .poly([
      b.x,
      b.y,
      b.x - head * Math.cos(angle - 0.4),
      b.y - head * Math.sin(angle - 0.4),
      b.x - head * Math.cos(angle + 0.4),
      b.y - head * Math.sin(angle + 0.4),
    ])
    .fill(color);
}

/** A ringed cross. Used for a committed launch target. */
function crosshair(hex: Hex, color: number): Graphics {
  const { x, y } = centerOf(hex);
  const r = HEX * 0.5;
  return new Graphics()
    .circle(x, y, r)
    .stroke({ width: 2.5, color })
    .moveTo(x - r * 1.3, y)
    .lineTo(x + r * 1.3, y)
    .moveTo(x, y - r * 1.3)
    .lineTo(x, y + r * 1.3)
    .stroke({ width: 2, color });
}

/** One candidate hex, styled by what picking it would mean. */
function targetMark(mode: OrderMode, hex: Hex): Graphics {
  const { x, y } = centerOf(hex);

  switch (mode) {
    // Ground you may end the round standing on — so it is filled, like ground.
    case 'MOVE':
      return new Graphics()
        .poly(hexCorners(x, y))
        .fill({ color: COLOR.move, alpha: 0.18 })
        .stroke({ width: 1, color: COLOR.move, alpha: 0.35 });

    // Reach, not ground: the missile passes over these and lands on one. An
    // outline says "within range" without implying the launcher goes there.
    case 'LAUNCH':
      return new Graphics()
        .poly(hexCorners(x, y, HEX * 0.9))
        .stroke({ width: 1.5, color: COLOR.launch, alpha: 0.45 });

    // Airspace. A dot floating over the tile, because the drone's range has
    // nothing to do with the ground under it — it crosses mountains and units
    // alike (spec §11).
    case 'FLY':
      return new Graphics()
        .circle(x, y, HEX * 0.16)
        .fill({ color: COLOR.fly, alpha: 0.5 });
  }
}

/**
 * What the hovered target would actually do, drawn before it is committed.
 *
 * The flight preview is the one that earns its keep: the drone's value is the
 * corridor it photographs, not where it lands, and a player cannot choose a
 * sweep line without seeing that corridor. **Both previews call `hexLine`** and
 * never re-derive a path (CLAUDE.md gotcha 12) — the pinned epsilon nudge is
 * what guarantees the line drawn here is the line the sim flies.
 */
function drawPreview(
  layer: Container,
  view: VisibleGameState,
  unit: Unit,
  mode: OrderMode,
  target: Hex,
): void {
  const { x, y } = centerOf(target);

  if (mode === 'MOVE') {
    layer.addChild(
      new Graphics()
        .poly(hexCorners(x, y))
        .fill({ color: COLOR.move, alpha: 0.4 })
        .stroke({ width: 2.5, color: COLOR.move }),
    );
    return;
  }

  if (mode === 'LAUNCH') {
    const a = centerOf(unit.position);
    layer.addChild(
      new Graphics()
        .moveTo(a.x, a.y)
        .lineTo(x, y)
        .stroke({ width: 2, color: COLOR.launch, alpha: 0.7 }),
      crosshair(target, COLOR.launch),
    );
    return;
  }

  // FLY — the path, then the corridor it would photograph.
  const path = hexLine(unit.position, target);

  for (const hex of swathHexes(path)) {
    if (!onBoard(view.map, hex)) continue;
    const c = centerOf(hex);
    layer.addChild(
      new Graphics()
        .poly(hexCorners(c.x, c.y))
        .fill({ color: COLOR.fly, alpha: 0.13 }),
    );
  }

  for (const hex of path) {
    if (!onBoard(view.map, hex)) continue;
    const c = centerOf(hex);
    layer.addChild(
      new Graphics()
        .poly(hexCorners(c.x, c.y, HEX * 0.55))
        .stroke({ width: 2, color: COLOR.fly, alpha: 0.85 }),
    );
  }
}

/** One queued decision, drawn on the board so a full round can be read at a glance. */
function drawMarker(
  layer: Container,
  view: VisibleGameState,
  unit: Unit,
  entry: DraftEntry,
): void {
  switch (entry.type) {
    case 'MOVE':
      layer.addChild(arrow(unit.position, entry.destination, COLOR.move));
      return;

    case 'LAUNCH': {
      const a = centerOf(unit.position);
      const b = centerOf(entry.target);
      layer.addChild(
        new Graphics()
          .moveTo(a.x, a.y)
          .lineTo(b.x, b.y)
          .stroke({ width: 1.5, color: COLOR.launch, alpha: 0.5 }),
        crosshair(entry.target, COLOR.launch),
      );
      return;
    }

    case 'FLY': {
      const path = hexLine(unit.position, entry.destination);

      for (const hex of swathHexes(path)) {
        if (!onBoard(view.map, hex)) continue;
        const c = centerOf(hex);
        layer.addChild(
          new Graphics()
            .poly(hexCorners(c.x, c.y))
            .fill({ color: COLOR.fly, alpha: 0.1 }),
        );
      }

      const points: number[] = [];
      for (const hex of path) {
        const c = centerOf(hex);
        points.push(c.x, c.y);
      }
      const line = new Graphics();
      line.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) line.lineTo(points[i], points[i + 1]);
      line.stroke({ width: 2.5, color: COLOR.fly });

      const end = centerOf(entry.destination);
      layer.addChild(
        line,
        new Graphics().circle(end.x, end.y, HEX * 0.22).fill(COLOR.fly),
      );
      return;
    }

    // Deliberate inaction — a launcher holding, a drone hovering and watching
    // its own corridor (spec §3, §11). It submits nothing; the ring is there so
    // "decided to hold" and "not yet decided" look different on the board.
    case 'HOLD': {
      const { x, y } = centerOf(unit.position);
      layer.addChild(
        new Graphics()
          .circle(x, y, HEX * 0.78)
          .stroke({ width: 2, color: COLOR.hold, alpha: 0.8 }),
      );
      return;
    }
  }
}

/**
 * The order layer: what the selected unit could be told to do, and what every
 * unit has already been told.
 *
 * **The move highlight is a prediction, not a promise** (spec §9). It is
 * computed against the board as the player believes it to be, which has no
 * enemy units in it beyond what they have detected — so a launcher ordered into
 * unscouted ground can still find someone parked there, fail entirely, and hold.
 * That risk is exactly what makes flying the drone worth a round, and the panel
 * says so in words next to this.
 */
export function drawOrders(
  layer: Container,
  view: VisibleGameState,
  overlay: OrderOverlay,
): void {
  clear(layer);

  const { unit, mode, hovered, draft } = overlay;

  if (unit && mode) {
    for (const hex of overlay.targets) {
      if (!onBoard(view.map, hex)) continue;
      layer.addChild(targetMark(mode, hex));
    }

    // Only preview a hex the player could actually pick; hovering illegal ground
    // must not draw a line the engine would never fly.
    const legal =
      hovered !== null &&
      overlay.targets.some((hex) => hexKey(hex) === hexKey(hovered));
    if (hovered && legal) drawPreview(layer, view, unit, mode, hovered);
  }

  for (const entry of Object.values(draft)) {
    const owner = view.units.find((u) => u.id === entry.unitId);
    if (owner) drawMarker(layer, view, owner, entry);
  }
}

// --- setup placement (build-order step 10b) ----------------------------------

/**
 * Everything the setup layer draws, assembled by the caller.
 *
 * As with `OrderOverlay`, the render layer decides nothing: which hexes are
 * legal and which the exclusion rule denies are both answered by
 * `src/state/placement.ts` asking the real §12 validator, and this file is handed
 * the results. There is no `player` and no opponent setup in this type, because
 * there is nothing on this screen that could need one (CLAUDE.md gotcha 30).
 */
export interface PlacementOverlay {
  /** Hexes the selected roster slot may legally use. */
  targets: readonly Hex[];
  /** Hexes the ≥3 exclusion rule denies that slot (§12). */
  exclusion: readonly Hex[];
  /** The player's roster — the filled slots are what gets drawn. */
  slots: readonly PlacementSlot[];
  /** The hex holding the selected slot's asset, if it is on the board — drawn
   *  lifted, so "the one I am moving" is visible among four identical blue tiles. */
  selectedHex: Hex | null;
  /** The hex under the cursor — previews the asset before it is committed. */
  hovered: Hex | null;
}

/**
 * The setup screen's board layer (spec §12).
 *
 * Three things, bottom to top: the ground the exclusion rule denies, the ground
 * the selected asset may be built on, and the assets already placed. The player's
 * own decoy is drawn as an X exactly as it is during play — the mask is for the
 * enemy, and a player who cannot tell their own bunker from their own decoy
 * cannot play (§12).
 *
 * The exclusion wash goes underneath the legal-hex highlight rather than being
 * subtracted from it, because the two sets are disjoint anyway: a hex the rule
 * denies is not in `targets` to begin with. Drawing it is what turns "some hexes
 * are missing from the highlight" into a rule the player can see.
 *
 * The selected asset gets a gold ring, because placement order is free: four
 * identical blue tiles with no marker would leave "which one am I about to move"
 * answerable only from the panel.
 */
export function drawPlacement(layer: Container, overlay: PlacementOverlay): void {
  clear(layer);

  for (const hex of overlay.exclusion) {
    const { x, y } = centerOf(hex);
    layer.addChild(
      new Graphics()
        .poly(hexCorners(x, y))
        .fill({ color: COLOR.excluded, alpha: 0.14 }),
    );
  }

  const hoveredKey = overlay.hovered ? hexKey(overlay.hovered) : null;

  for (const hex of overlay.targets) {
    const { x, y } = centerOf(hex);
    const isHovered = hexKey(hex) === hoveredKey;

    layer.addChild(
      new Graphics()
        .poly(hexCorners(x, y))
        .fill({ color: COLOR.place, alpha: isHovered ? 0.42 : 0.16 })
        .stroke({ width: isHovered ? 2.5 : 1, color: COLOR.place, alpha: isHovered ? 1 : 0.4 }),
    );
  }

  const selectedKey = overlay.selectedHex ? hexKey(overlay.selectedHex) : null;

  for (const { kind, hex } of overlay.slots) {
    if (!hex) continue; // an empty roster slot has nothing on the board yet
    const { x, y } = centerOf(hex);

    if (hexKey(hex) === selectedKey) {
      layer.addChild(
        new Graphics()
          .poly(hexCorners(x, y, HEX * 0.82))
          .stroke({ width: 3, color: COLOR.selected }),
      );
    }

    layer.addChild(
      new Graphics()
        .poly(hexCorners(x, y, HEX * 0.62))
        .fill(COLOR.own)
        .stroke({ width: 2, color: COLOR.outline }),
      glyphAt(GLYPH[kind], x, y, GLYPH_STYLE),
    );
  }
}

// --- pieces -----------------------------------------------------------------

/**
 * The viewer's own units — the only units in a `VisibleGameState` at all (spec
 * §6). Destroyed ones stay on the board greyed out: your own losses are your own
 * knowledge, and a wreck is a useful reminder of where you were hit.
 */
export function drawUnits(layer: Container, units: readonly Unit[]): void {
  clear(layer);

  for (const unit of units) {
    const { x, y } = centerOf(unit.position);
    const color = unit.destroyed ? COLOR.ownDestroyed : COLOR.own;

    const body = new Graphics()
      .poly(hexCorners(x, y, HEX * 0.62))
      .fill(color)
      .stroke({ width: 2, color: COLOR.outline });
    body.alpha = unit.destroyed ? 0.55 : 1;

    layer.addChild(body, glyphAt(GLYPH[unit.kind], x, y, GLYPH_STYLE));
  }
}

/**
 * Everything the viewer knows about the enemy (spec §11) — and it is *all* of
 * it: enemy assets are absent from `units` entirely, so this layer and the event
 * log are the whole enemy picture.
 *
 * Two lifetimes, drawn differently on purpose:
 *
 *   - **Static reveals are permanent.** A bunker site or interceptor base cannot
 *     move, so the sighting stays true until the asset is publicly destroyed.
 *     Solid ring. A site is always labelled 'B' — nothing in the game can tell
 *     the real bunker from the decoy (§12).
 *   - **Launcher contacts last one order phase.** They are gone the moment the
 *     round resolves, because a launcher relocates. A launch origin is drawn
 *     boldly (it cannot be stale — a launcher that fired could not also move),
 *     a recon sighting faintly (recon flies in phase 1 and launchers move in
 *     phase 5 of the same round, so it may already be wrong).
 */
export function drawIntel(layer: Container, intel: VisiblePlayerIntel): void {
  clear(layer);

  const siteGlyph: Record<MaskedStaticKind, string> = {
    bunker: GLYPH.bunker,
    interceptor: GLYPH.interceptor,
  };

  for (const reveal of intel.staticReveals) {
    const { x, y } = centerOf(reveal.hex);
    layer.addChild(
      new Graphics()
        .poly(hexCorners(x, y, HEX * 0.62))
        .stroke({ width: 3, color: COLOR.enemy }),
      glyphAt(siteGlyph[reveal.kind], x, y, INTEL_STYLE),
    );
  }

  for (const contact of intel.contacts) {
    const { x, y } = centerOf(contact.hex);
    const fresh = contact.source === 'LAUNCH';

    const ring = new Graphics()
      .circle(x, y, HEX * 0.55)
      .stroke({ width: fresh ? 3 : 2, color: COLOR.enemy });
    ring.alpha = fresh ? 1 : 0.65;

    const label = glyphAt(GLYPH.launcher, x, y, INTEL_STYLE);
    label.alpha = ring.alpha;

    layer.addChild(ring, label);
  }
}
