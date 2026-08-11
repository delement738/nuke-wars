# Nuke Wars

A 1v1 web-based strategy game: simultaneous hidden orders, hex-grid maneuver, drone reconnaissance, and a hidden-bunker decapitation endgame. Combat is fully deterministic — the only randomness in the game is map generation.

The design pillar is **commit → dread → reveal**. Both players queue orders without seeing the other's, resolution is simultaneous, and every exposure is a choice: firing reveals your launcher, advancing risks contact, and your recon drone finds the enemy bunker only by flying into defended air.

Each side fields the entire roster: **3 mobile launchers** (move *or* fire, never both), **2 interceptor bases** (each stops at most 1 missile per round — saturation beats defense), **1 recon drone** (the only way to find the bunker), **1 hidden bunker** (2 hits, triggers a dead-hand retaliation when destroyed), and **1 decoy bunker** (1 hit, and indistinguishable from the real thing until a missile proves otherwise).

**Seeing the enemy is deliberately simple.** The terrain is public, but enemy assets are hidden until you detect them, and there are only two detectors: fly your drone over them, or watch them fire — every launch is detected automatically, by both sides. A spotted launcher stays on your map for one round only, because it can relocate; a spotted bunker site or interceptor base can't move, so it stays marked permanently (and recon can never tell the real bunker from the decoy). Your event log keeps every launch you've detected for the whole match.

## Status

**V1 (hotseat) — in development.** The design was pivoted on 2026-08-11 (see the spec) and the sim code is fully migrated to it. Built and tested so far: hex math including the `hexLine` flight primitive, self-validating symmetric map generation (mountain ranges, re-rolled until playable), launcher movement, and `resolve()` with its recon-drone and ground-movement phases — 205 tests. The hex map renders with pan/zoom/select. Next up is the launch/intercept/impact phase. Not yet playable.

See the "Current status" section of [CLAUDE.md](CLAUDE.md) for exactly where things stand and what's next.

## Stack

- **TypeScript** + **Vite 8** + **React 19**
- **PixiJS v8** — game map, units, effects
- **Zustand** — client state
- **Vitest** — unit tests

Hex math is hand-rolled in [src/sim/hex.ts](src/sim/hex.ts) rather than pulled from a library, keeping the simulation layer dependency-free so it can move server-side unchanged in V1.5.

## Commands

```bash
npm install
npm run dev      # dev server at localhost:5173
npm run build    # production build + full type-check
npm run lint     # ESLint
npm test         # Vitest, single run
npm run test:watch
```

## Architecture

Four strictly separated layers. The separation is non-negotiable — it's what lets the same engine run authoritatively on a server in V1.5 without modification.

| Directory | Role | Rule |
|---|---|---|
| `src/sim/` | Pure simulation engine | Never imports React, Pixi, DOM, or network code. All rules and state live here as pure functions. |
| `src/render/` | PixiJS drawing | Reads state, draws it. Never mutates game state. |
| `src/ui/` | React HUD/menus *(not yet created)* | Reads state, sends player intents. |
| *(V1.5)* | Node.js WebSocket server | Rooms, order collection, authoritative resolve, per-player visibility filter. |

Three rules govern the sim layer:

- **Determinism** — `resolve(state, orders)` is fully deterministic by design: V1 combat uses no randomness at all, and every simultaneous tie has a written tiebreak in the spec. The seeded RNG in [src/sim/map.ts](src/sim/map.ts) exists only for map generation. Bugs are reproducible and a replay is just the initial state plus the orders.
- **Event log** — `resolve()` emits an ordered event list with per-player visibility rules (spec §6). Clients animate from those events, never by diffing state. It doubles as the replay format.
- **Data tables** — unit, terrain, and rule numbers live as plain keyed data in [src/sim/defs.ts](src/sim/defs.ts), never hardcoded in logic. A balance pass should be a one-file diff.

## Docs

- **[docs/nuke-wars-v1-spec.md](docs/nuke-wars-v1-spec.md)** — the design specification. Source of truth for every rule, number, and V1 scope decision. Fully post-pivot (2026-08-11).
- [docs/v2-backlog.md](docs/v2-backlog.md) — deferred features, including everything cut in the V1 pivot. Reference only; never implement from it.
- [CLAUDE.md](CLAUDE.md) — working instructions and current status.
