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
import { axialToOffset, hexesInRange, offsetToAxial, type Hex } from '../sim/hex';
import { tileAt, type MapData, type Terrain } from '../sim/map';
import type {
  MaskedStaticKind,
  Unit,
  UnitKind,
  VisibleGameState,
  VisiblePlayerIntel,
} from '../sim/types';
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
): void {
  clear(layer);

  for (const tile of map.tiles) {
    const { x, y } = hexCenter(tile.col, tile.row);
    const g = new Graphics()
      .poly(hexCorners(x, y))
      .fill(FILL[tile.terrain])
      .stroke({ width: 1, color: COLOR.outline });

    g.eventMode = 'static';
    g.cursor = 'pointer';
    g.on('pointerover', () => { g.alpha = 0.8; });
    g.on('pointerout', () => { g.alpha = 1; });
    // offsetToAxial, never a hand-rolled conversion: the sim reasons in axial
    // and the map stores offsets, and one of those two conversions living in the
    // render layer is how the two coordinate systems start to disagree.
    g.on('pointertap', () => { onPick(offsetToAxial({ col: tile.col, row: tile.row })); });

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
