// RENDER LAYER — the Pixi application's lifecycle and camera (build-order step 9).
//
// **This component no longer generates its own map.** Until step 9 it called
// `generateMap()` in its own effect, which meant the render layer owned game
// state — the standing architecture-rule violation the store was always going to
// close. It now draws whatever `useView()` hands it, and what that hands it is a
// `VisibleGameState`: the redacted board for whoever is looking at the screen.
//
// That type is the whole point. `visibility.ts` can only protect callers that
// call it, so the guarantee "the renderer never sees the truth" is not something
// any test in `src/sim/` can enforce (CLAUDE.md gotcha 34). It is enforced here
// instead, by this file having no way to obtain anything else: the unfiltered
// state is a module-private variable in `src/state/match.ts`.
//
// The file is deliberately thin — create the app, hold the camera, hand the
// layers to `./draw`. Effects with different lifetimes:
//
//   1. **the application**, once per mount (StrictMode remounts it in dev);
//   2. **terrain**, once per board — the biggest layer, and the board outlives
//      any one match: it is drawn on the setup screen too;
//   3. **pieces**, on every state change — units, intel and the selection;
//   4. **the order overlay** and 5. **the setup overlay**, both hover-driven and
//      therefore redrawn far more often than the board is.
//
// Exactly one of (3, 4) and (5) has anything to draw at a time: `useView()` is
// null while the human is still placing their assets, because a `GameState`
// only exists on the far side of `startMatch` (build-order step 10b).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Application, Container } from 'pixi.js';
import { hoverHex, pickHex } from '../state/match';
import { targetsFor } from '../state/orders';
import {
  exclusionHexes,
  placementSlots,
  placementTargets,
} from '../state/placement';
import {
  useActiveSeat,
  useDraft,
  useHovered,
  useMap,
  useOrderMode,
  usePlaced,
  useSelected,
  useSelectedSlot,
  useSelectedUnitId,
  useView,
} from '../state/useMatch';
import {
  clearLayer,
  drawCoverage,
  drawIntel,
  drawOrders,
  drawPlacement,
  drawSelection,
  drawTerrain,
  drawUnits,
} from './draw';

/** Zoom limits, shared by the wheel handler and the initial fit. */
const ZOOM = { min: 0.5, max: 2.5 } as const;

/** Pointer travel (px) past which a drag is a pan, not a click on a tile. */
const DRAG_SLOP = 4;

/** Breathing room (px) left around the board by the opening fit. */
const FIT_MARGIN = 16;

/** Camera drag bookkeeping, shared between the camera and the tile handlers. */
interface DragState {
  down: boolean;
  /** Total travel since pointerdown — compared against DRAG_SLOP on click. */
  moved: number;
  x: number;
  y: number;
}

/**
 * The Pixi objects a mounted canvas owns. Held in React state rather than a ref
 * so the drawing effects below re-run once `init()` has resolved — Pixi v8's
 * initialisation is async, and everything here is null until it finishes.
 */
interface Scene {
  app: Application;
  world: Container;
  terrain: Container;
  coverage: Container;
  placement: Container;
  selection: Container;
  orders: Container;
  intel: Container;
  units: Container;
}

export default function GameCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<Scene | null>(null);

  // How far the pointer has travelled since it went down. Lives in a ref because
  // the tile click handlers read it during an event, not during a render.
  const dragRef = useRef<DragState>({ down: false, moved: 0, x: 0, y: 0 });

  // --- 1. the application ---------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    let cancelled = false;

    (async () => {
      await app.init({ background: 0x0b0f14, resizeTo: host, antialias: true });
      if (cancelled) {
        // The effect was cleaned up (e.g. React StrictMode's mount/unmount/
        // remount in dev) while init() was still pending. `app` wasn't fully
        // initialized at cleanup time, so destroying it there would throw inside
        // Pixi's ResizePlugin — safe to destroy now that init has finished.
        app.destroy(true, { children: true });
        return;
      }
      host.appendChild(app.canvas);

      const world = new Container();
      // Draw order, bottom to top: the board, what my bases cover, where I may
      // build during setup, the tile I clicked, the orders I am giving, what I
      // know of the enemy, then my own units on top. Orders sit *under* intel
      // and units deliberately — a range wash must never obscure a detected
      // enemy or a piece of mine. The setup and match layers never hold content
      // at the same time; they are separate so neither has to know about the
      // other's lifetime.
      const terrain = new Container();
      const coverage = new Container();
      const placement = new Container();
      const selection = new Container();
      const orders = new Container();
      const intel = new Container();
      const units = new Container();
      world.addChild(terrain, coverage, placement, selection, orders, intel, units);
      app.stage.addChild(world);

      attachCamera(app, world, dragRef);
      setScene({
        app,
        world,
        terrain,
        coverage,
        placement,
        selection,
        orders,
        intel,
        units,
      });
    })();

    return () => {
      cancelled = true;
      // Only destroy here if init() already resolved (app.renderer exists).
      // Otherwise the async block above destroys it once init() finishes.
      if (app.renderer) app.destroy(true, { children: true });
      setScene(null);
    };
  }, []);

  // `map` comes from the store directly rather than out of `view`, because the
  // setup screen has to draw a board before there is a match to have a view of.
  // That is not a gap in the visibility filter: terrain is public (spec §11) and
  // `VisibleGameState.map` is this same object by reference.
  const map = useMap();
  const view = useView();
  const activeSeat = useActiveSeat();
  const placed = usePlaced();
  const selectedSlot = useSelectedSlot();
  const selected = useSelected();
  const selectedUnitId = useSelectedUnitId();
  const orderMode = useOrderMode();
  const hovered = useHovered();
  const draft = useDraft();

  // The unit being ordered, and the hexes it may legally be sent to. Computed
  // here rather than in `draw.ts` because deciding what is legal is state's job
  // and drawing's job is to draw it (CLAUDE.md's render rule). Memoised because
  // `moveTargets` runs a flood fill and this re-renders on every hover.
  const orderUnit = useMemo(
    () => view?.units.find((unit) => unit.id === selectedUnitId) ?? null,
    [view, selectedUnitId],
  );
  const targets = useMemo(
    () => (view && orderUnit && orderMode ? targetsFor(view, orderUnit, orderMode) : []),
    [view, orderUnit, orderMode],
  );

  // The setup screen's two hex sets, from the same §12 validator the engine
  // re-checks the finished setup with. Both are keyed on the selected roster
  // slot, because placement order is free: the highlight is "where may THIS
  // asset go", and for an asset already on the board that means "where may it
  // move to". Memoised for the same reason as above — `placementTargets` scans
  // the whole home zone and this re-renders on hover.
  //
  // Keyed on the ACTIVE SEAT, not on a fixed player (build-order step 10c): in
  // hotseat the second pass over this screen is P2 placing, and their legal
  // ground is the far end of the board (§7). `placed` and `selectedSlot` come
  // from viewer-keyed hooks, and while placing in hotseat the viewer and the
  // active seat are always the same player — the handoff moves them together.
  const setupTargets = useMemo(
    () => (view ? [] : placementTargets(map, activeSeat, placed, selectedSlot)),
    [view, map, activeSeat, placed, selectedSlot],
  );
  const setupExclusion = useMemo(
    () => (view ? [] : exclusionHexes(map, activeSeat, placed, selectedSlot)),
    [view, map, activeSeat, placed, selectedSlot],
  );
  const setupSlots = useMemo(
    () => (view ? [] : placementSlots(placed)),
    [view, placed],
  );
  const setupSelectedHex = setupSlots[selectedSlot]?.hex ?? null;

  // --- 2. terrain, and the camera's opening framing -------------------------
  // Keyed on the map object, which outlives any one match and which the sim
  // shares by reference from round to round (the filter is a projection, not a
  // deep clone), so this runs once per board rather than once per round.
  useEffect(() => {
    if (!scene) return;

    drawTerrain(
      scene.terrain,
      map,
      (hex) => {
        // A click that ended a pan is not a click on a tile.
        //
        // `pickHex`, not `selectHex`: what a click *means* depends on whether an
        // order is being composed, and that is a state decision. The render
        // layer reports where the player clicked and nothing else.
        if (dragRef.current.moved <= DRAG_SLOP) pickHex(hex);
      },
      hoverHex,
    );

    fitToScreen(scene);
  }, [scene, map]);

  // --- 3. everything that changes round to round ----------------------------
  // `view` is null on the setup screen, and the layers are cleared rather than
  // left alone: a new match sends the client back to setup, and a units layer
  // that kept painting the last match's board would be the map saying something
  // the state does not.
  useEffect(() => {
    if (!scene) return;
    if (!view) {
      clearLayer(scene.coverage);
      clearLayer(scene.intel);
      clearLayer(scene.units);
      return;
    }
    drawCoverage(scene.coverage, view);
    drawIntel(scene.intel, view.intel);
    drawUnits(scene.units, view.units);
  }, [scene, view]);

  useEffect(() => {
    if (!scene) return;
    drawSelection(scene.selection, selected);
  }, [scene, selected]);

  // --- 4. the order overlay -------------------------------------------------
  // Its own effect because it changes on hover, which is far more often than the
  // board does — redrawing units and intel at that rate would be waste.
  useEffect(() => {
    if (!scene) return;
    if (!view) {
      clearLayer(scene.orders);
      return;
    }
    drawOrders(scene.orders, view, {
      unit: orderUnit,
      mode: orderMode,
      targets,
      hovered,
      draft,
    });
  }, [scene, view, orderUnit, orderMode, targets, hovered, draft]);

  // --- 5. the setup overlay (build-order step 10b) ---------------------------
  // Also hover-driven, and also cleared on the transition — here the other way
  // round, when placement finishes and the match begins.
  useEffect(() => {
    if (!scene) return;
    if (view) {
      clearLayer(scene.placement);
      return;
    }
    drawPlacement(scene.placement, {
      targets: setupTargets,
      exclusion: setupExclusion,
      slots: setupSlots,
      selectedHex: setupSelectedHex,
      hovered,
    });
  }, [scene, view, setupTargets, setupExclusion, setupSlots, setupSelectedHex, hovered]);

  return <div ref={hostRef} className="canvas-host" />;
}

/**
 * Centre the board and zoom to fit.
 *
 * The board is portrait (16 wide x 19 tall, ~900px) and taller than most browser
 * windows, so fitting it on first paint beats dropping the player at the
 * top-left with P1's whole southern half off-screen.
 *
 * The margin is not cosmetic: an exact fit lands the outermost hexes flush
 * against the window edge, and P1's bunker sits on the very last row (spec §7's
 * home zone runs to row 18), so a board fitted to the pixel clips the piece the
 * whole match is about.
 */
function fitToScreen(scene: Scene): void {
  const { app, world } = scene;
  const bounds = world.getLocalBounds();
  if (bounds.width === 0 || bounds.height === 0) return;

  const fit = Math.min(
    (app.screen.width - FIT_MARGIN * 2) / bounds.width,
    (app.screen.height - FIT_MARGIN * 2) / bounds.height,
  );
  const scale = Math.min(ZOOM.max, Math.max(ZOOM.min, fit));

  world.scale.set(scale);
  world.x = (app.screen.width - bounds.width * scale) / 2 - bounds.x * scale;
  world.y = (app.screen.height - bounds.height * scale) / 2 - bounds.y * scale;
}

/**
 * Drag to pan, wheel to zoom.
 *
 * Listeners go on the canvas element rather than the Pixi stage so a drag that
 * starts on a tile still pans — the tiles are interactive (they are the click
 * targets), and a stage-level handler would fight them for the pointer.
 */
function attachCamera(
  app: Application,
  world: Container,
  dragRef: { current: DragState },
): void {
  const canvas = app.canvas;

  canvas.addEventListener('pointerdown', (e) => {
    dragRef.current = { down: true, moved: 0, x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('pointermove', (e) => {
    const drag = dragRef.current;
    if (!drag.down) return;

    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    world.x += dx;
    world.y += dy;

    drag.moved += Math.abs(dx) + Math.abs(dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
  });

  const release = () => { dragRef.current.down = false; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointerleave', release);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const next = Math.min(ZOOM.max, Math.max(ZOOM.min, world.scale.x * factor));
    world.scale.set(next);
  }, { passive: false });
}
