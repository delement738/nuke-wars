import { useEffect, useRef } from 'react';
import { Application, Container, Graphics } from 'pixi.js';
import { generateMap, type TileData } from '../sim/map';

const HEX = 26; // hex radius in pixels

const FILL: Record<string, number> = {
  plains: 0x1f3d2b,   // dark green
  mountain: 0x4a4f57, // slate gray
  urban: 0x8a6d3b,    // amber
};

// Flat-top hexes have a flat edge on top/bottom, so columns stack directly
// north/south of each other — the offset (odd-q) instead shifts alternating
// *columns* vertically, and adjacent columns are the diagonal NE/SE/NW/SW
// neighbors.
//
// That is exactly why the game is fought north/south (spec §7): a flat-top hex
// has a true N and S neighbor and none directly E or W, so advancing up the
// board is a straight line. P1 holds the southern (high-row) edge.
function hexCenter(col: number, row: number) {
  const h = Math.sqrt(3) * HEX;
  return {
    x: HEX * 1.5 * col + HEX * 2,
    y: h * (row + 0.5 * (col % 2)) + h,
  };
}

function hexCorners(cx: number, cy: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i); // flat-top
    pts.push(cx + HEX * Math.cos(angle), cy + HEX * Math.sin(angle));
  }
  return pts;
}

function paint(g: Graphics, tile: TileData, selected: boolean) {
  const { x, y } = hexCenter(tile.col, tile.row);
  g.clear();
  g.poly(hexCorners(x, y))
    .fill(FILL[tile.terrain])
    .stroke({ width: selected ? 3 : 1, color: selected ? 0xffd54a : 0x101820 });
}

export default function GameCanvas() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    let cancelled = false;

    (async () => {
      await app.init({ background: 0x0b0f14, resizeTo: host });
      if (cancelled) {
        // Effect was cleaned up (e.g. React StrictMode's mount/unmount/remount
        // in dev) while init() was still pending. `app` wasn't fully
        // initialized yet at cleanup time, so destroying it there would throw
        // inside Pixi's ResizePlugin — safe to destroy now that init finished.
        app.destroy(true, { children: true });
        return;
      }
      host.appendChild(app.canvas);

      const world = new Container();
      app.stage.addChild(world);

      const map = generateMap();
      let selectedGfx: Graphics | null = null;
      let selectedTile: TileData | null = null;

      for (const tile of map.tiles) {
        const g = new Graphics();
        paint(g, tile, false);
        g.eventMode = 'static';
        g.cursor = 'pointer';

        g.on('pointerover', () => { g.alpha = 0.75; });
        g.on('pointerout', () => { g.alpha = 1; });
        g.on('pointertap', () => {
          if (selectedGfx && selectedTile) paint(selectedGfx, selectedTile, false);
          selectedGfx = g;
          selectedTile = tile;
          paint(g, tile, true);
        });

        world.addChild(g);
      }

      // --- Initial framing ---
      // The board is portrait now (16 wide x 19 tall, ~900px) and taller than
      // most browser windows, so fit it on first paint instead of dropping the
      // player at the top-left with P1's whole southern half off-screen.
      // Clamped to the same 0.5–2.5 range the wheel handler enforces.
      const bounds = world.getLocalBounds();
      const fit = Math.min(
        app.screen.width / bounds.width,
        app.screen.height / bounds.height,
      );
      const scale = Math.min(2.5, Math.max(0.5, fit));
      world.scale.set(scale);
      world.x = (app.screen.width - bounds.width * scale) / 2 - bounds.x * scale;
      world.y = (app.screen.height - bounds.height * scale) / 2 - bounds.y * scale;

      // --- Pan (drag) ---
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      app.canvas.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
      });
      app.canvas.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        world.x += e.clientX - lastX;
        world.y += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
      });
      app.canvas.addEventListener('pointerup', () => { dragging = false; });
      app.canvas.addEventListener('pointerleave', () => { dragging = false; });

      // --- Zoom (mouse wheel) ---
      app.canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const next = Math.min(2.5, Math.max(0.5, world.scale.x * factor));
        world.scale.set(next);
      }, { passive: false });
    })();

    return () => {
      cancelled = true;
      // Only destroy here if init() already resolved (app.renderer exists).
      // Otherwise the async block above will destroy it once init() finishes.
      if (app.renderer) app.destroy(true, { children: true });
    };
  }, []);

  return <div ref={hostRef} style={{ width: '100vw', height: '100vh' }} />;
}