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
//      therefore redrawn far more often than the board is;
//   6. **the replay** (presentation phase, sessions 1–2): while the viewer has an
//      unwatched resolution, the board shows the view from *before* it and a
//      function on Pixi's ticker plays the round's events over it, frame by
//      frame, from `./timeline`. When it ends — or is skipped — the store
//      clears the replay and effect 3 settles on the current view.
//
// **Nothing plays during a hotseat handoff, and that is structural** (gotchas
// 58, 62): `App` unmounts this whole component while the screen is blanked, so
// there is no ticker to run. Each player's replay waits in the store until they
// take the screen.
//
// Exactly one of (3, 4) and (5) has anything to draw at a time: `useView()` is
// null while the human is still placing their assets, because a `GameState`
// only exists on the far side of `startMatch` (build-order step 10b).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Application, Container, type Ticker } from 'pixi.js';
import { finishReplay, hoverHex, pickHex } from '../state/match';
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
  useIntelOverlay,
  useMap,
  useOrderMode,
  usePlaced,
  useReplay,
  useSelected,
  useSelectedSlot,
  useSelectedUnitId,
  useView,
  useViewer,
} from '../state/useMatch';
import {
  drawCaption,
  drawReplayLabels,
  drawReplayShapes,
  labelKey,
  verdictBanner,
} from './playbackDraw';
import { planFlights } from './flights';
import {
  buildTimeline,
  captionAt,
  frameAt,
  hiddenMissileIds,
  hiddenUnitIds,
} from './timeline';
import {
  clearLayer,
  drawCoverage,
  drawIntel,
  drawIntelOverlay,
  drawMissiles,
  drawOrders,
  drawPlacement,
  drawSelection,
  drawTerrain,
  drawUnits,
} from './draw';
import { wheelZoomFactor, ZOOM, zoomAt } from './camera';

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
  /** What the viewer has worked out from their log: photographed ground and
   *  where the enemy base could be (session 3). Under everything that marks a
   *  piece, because it is a backdrop, not a sighting. */
  inferred: Container;
  placement: Container;
  selection: Container;
  orders: Container;
  intel: Container;
  units: Container;
  /** Missiles still in the air, with the warning on their targets (session 2).
   *  Above the units, so a warning over your own piece is never hidden by it. */
  missiles: Container;
  /** The replay's moving effects and their words — above the units, because an
   *  impact or a sliding launcher is the thing to look at while it plays. */
  fxShapes: Container;
  fxLabels: Container;
  /** Screen-space, outside `world`: the replay caption stays put when panning. */
  caption: Container;
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
      // Draw order, bottom to top: the board, what my bases cover, what I have
      // inferred (ground photographed, where their base could be), where I may
      // build during setup, the tile I clicked, the orders I am giving, what I
      // know of the enemy, then my own units on top. Orders sit *under* intel
      // and units deliberately — a range wash must never obscure a detected
      // enemy or a piece of mine. The setup and match layers never hold content
      // at the same time; they are separate so neither has to know about the
      // other's lifetime.
      const terrain = new Container();
      const coverage = new Container();
      const inferred = new Container();
      const placement = new Container();
      const selection = new Container();
      const orders = new Container();
      const intel = new Container();
      const units = new Container();
      const missiles = new Container();
      const fxShapes = new Container();
      const fxLabels = new Container();
      world.addChild(
        terrain, coverage, inferred, placement, selection, orders, intel, units, missiles, fxShapes, fxLabels,
      );
      const caption = new Container();
      app.stage.addChild(world, caption);

      attachCamera(app, world, dragRef);
      setScene({
        app,
        world,
        terrain,
        coverage,
        inferred,
        placement,
        selection,
        orders,
        intel,
        units,
        missiles,
        fxShapes,
        fxLabels,
        caption,
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
  const replay = useReplay();
  const viewer = useViewer();
  const inference = useIntelOverlay();

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
        // During a replay the store reads the click as "skip".
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
      clearLayer(scene.inferred);
      clearLayer(scene.intel);
      clearLayer(scene.units);
      clearLayer(scene.missiles);
      return;
    }
    // While a replay is pending the board is the view from BEFORE the round —
    // the backdrop its events play over. Effect 6 animates on top; when it
    // finishes, `replay` goes null and this redraws the current view: the settle.
    const board = replay ? replay.from : view;
    drawCoverage(scene.coverage, board);
    // Already describes `board` — the hook swaps in the pre-round picture too.
    drawIntelOverlay(scene.inferred, inference);
    drawIntel(scene.intel, board.intel);
    drawUnits(scene.units, board.units);
    drawMissiles(scene.missiles, board.missiles, viewer);
  }, [scene, view, replay, viewer, inference]);

  useEffect(() => {
    if (!scene) return;
    drawSelection(scene.selection, selected);
  }, [scene, selected]);

  // --- 4. the order overlay -------------------------------------------------
  // Its own effect because it changes on hover, which is far more often than the
  // board does — redrawing units and intel at that rate would be waste.
  useEffect(() => {
    if (!scene) return;
    if (!view || replay) {
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
  }, [scene, view, replay, orderUnit, orderMode, targets, hovered, draft]);

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

  // --- 6. the replay (presentation phase, session 1) -------------------------
  // Pixi's ticker calls `tick` once per frame with the time since the last one.
  // The timeline turns elapsed time into "which clips are on screen and how far
  // through", and the draw functions paint exactly that — so the only state this
  // effect owns is a clock. Skipping and finishing are the same act: ask the
  // store to clear the viewer's replay.
  useEffect(() => {
    if (!scene || !replay) return;

    const timeline = buildTimeline(replay.events);
    const ctx = {
      own: replay.from.units,
      flights: planFlights(replay.events, replay.from.missiles, replay.from.units),
      map: replay.from.map,
      events: replay.events,
    };
    let elapsed = 0;
    let hiddenKey = '';
    let hiddenMissilesKey = '';
    let labelsKey = '';
    let captionKey = '';

    const tick = (ticker: Ticker) => {
      elapsed += ticker.deltaMS;
      if (elapsed >= timeline.duration) {
        finishReplay();
        return;
      }
      const frames = frameAt(timeline, elapsed);

      drawReplayShapes(scene.fxShapes, frames, ctx);

      // The static pieces are redrawn only when the set a clip is standing in
      // for changes — a launcher starts sliding, the drone takes off.
      const hidden = hiddenUnitIds(frames);
      const nextHidden = [...hidden].join(',');
      if (nextHidden !== hiddenKey) {
        hiddenKey = nextHidden;
        drawUnits(scene.units, replay.from.units.filter((unit) => !hidden.has(unit.id)));
      }

      // Same for a missile carried over from last round: its marker gives way
      // to the final dive once its intercept or impact clip starts.
      const hiddenMissiles = hiddenMissileIds(frames);
      const nextHiddenMissiles = [...hiddenMissiles].join(',');
      if (nextHiddenMissiles !== hiddenMissilesKey) {
        hiddenMissilesKey = nextHiddenMissiles;
        drawMissiles(scene.missiles, replay.from.missiles, viewer, hiddenMissiles);
      }

      const nextLabels = labelKey(frames);
      if (nextLabels !== labelsKey) {
        labelsKey = nextLabels;
        drawReplayLabels(scene.fxLabels, frames, ctx);
      }

      const caption = captionAt(timeline, elapsed);
      const banner = verdictBanner(frames, viewer);
      const { width, height } = scene.app.screen;
      const nextCaption = `${caption}|${banner}|${width}x${height}`;
      if (nextCaption !== captionKey) {
        captionKey = nextCaption;
        drawCaption(scene.caption, { width, height }, replay.round, caption, banner);
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Escape') {
        event.preventDefault();
        finishReplay();
      }
    };

    scene.app.ticker.add(tick);
    window.addEventListener('keydown', onKey);
    return () => {
      scene.app.ticker.remove(tick);
      window.removeEventListener('keydown', onKey);
      clearLayer(scene.fxShapes);
      clearLayer(scene.fxLabels);
      clearLayer(scene.caption);
    };
  }, [scene, replay, viewer]);

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
 * Drag to pan, wheel (or pinch) to zoom about the cursor.
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

  // Zoom about the cursor, like a map app. Trackpad pinch arrives here too, as
  // a wheel event with ctrlKey set; preventDefault stops the browser zooming
  // the whole page instead. Two-finger scroll zooms as well — see
  // `wheelZoomFactor` for why the step follows deltaY.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cam = zoomAt(
      { x: world.x, y: world.y, scale: world.scale.x },
      e.clientX - rect.left,
      e.clientY - rect.top,
      wheelZoomFactor(e.deltaY, e.deltaMode, e.ctrlKey),
    );
    world.scale.set(cam.scale);
    world.position.set(cam.x, cam.y);
  }, { passive: false });
}
