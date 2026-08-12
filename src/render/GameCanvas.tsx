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
// layers to `./draw`. Three effects with three different lifetimes:
//
//   1. **the application**, once per mount (StrictMode remounts it in dev);
//   2. **terrain**, once per map — the biggest layer, and the map is fixed for a
//      whole match;
//   3. **pieces**, on every state change — units, intel and the selection.

import { useEffect, useRef, useState } from 'react';
import { Application, Container } from 'pixi.js';
import { selectHex } from '../state/match';
import { useSelected, useView } from '../state/useMatch';
import { drawCoverage, drawIntel, drawSelection, drawTerrain, drawUnits } from './draw';

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
  selection: Container;
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
      // Draw order, bottom to top: the board, what my bases cover, the tile I
      // clicked, what I know of the enemy, then my own units on top.
      const terrain = new Container();
      const coverage = new Container();
      const selection = new Container();
      const intel = new Container();
      const units = new Container();
      world.addChild(terrain, coverage, selection, intel, units);
      app.stage.addChild(world);

      attachCamera(app, world, dragRef);
      setScene({ app, world, terrain, coverage, selection, intel, units });
    })();

    return () => {
      cancelled = true;
      // Only destroy here if init() already resolved (app.renderer exists).
      // Otherwise the async block above destroys it once init() finishes.
      if (app.renderer) app.destroy(true, { children: true });
      setScene(null);
    };
  }, []);

  const view = useView();
  const selected = useSelected();

  // --- 2. terrain, and the camera's opening framing -------------------------
  // Keyed on the map object, which the sim shares by reference from round to
  // round (the filter is a projection, not a deep clone), so this runs once per
  // match rather than once per round.
  useEffect(() => {
    if (!scene) return;

    drawTerrain(scene.terrain, view.map, (hex) => {
      // A click that ended a pan is not a click on a tile.
      if (dragRef.current.moved <= DRAG_SLOP) selectHex(hex);
    });

    fitToScreen(scene);
  }, [scene, view.map]);

  // --- 3. everything that changes round to round ----------------------------
  useEffect(() => {
    if (!scene) return;
    drawCoverage(scene.coverage, view);
    drawIntel(scene.intel, view.intel);
    drawUnits(scene.units, view.units);
  }, [scene, view]);

  useEffect(() => {
    if (!scene) return;
    drawSelection(scene.selection, selected);
  }, [scene, selected]);

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
