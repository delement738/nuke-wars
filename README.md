# Nuke Wars

A 1v1 web-based strategy game: simultaneous hidden orders under a countdown timer, hex-grid maneuver, fog of war, finite interceptor defenses, and a hidden-Leader decapitation endgame.

The design pillar is **commit → dread → reveal**. Both players queue orders without seeing the other's, resolution is simultaneous, and moving into striking range is itself the act of exposure.

## Status

**V1 (hotseat) — in development.** The hex map renders with pan/zoom/select; the simulation engine core is being built one system per session. Not yet playable.

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
| *(V1.5)* | Node.js WebSocket server | Rooms, order collection, authoritative resolve, per-player fog filter. |

Three rules govern the sim layer:

- **Determinism** — `resolve(state, orders, seed)` is fully deterministic. No `Math.random()`; all randomness flows through the seeded RNG in [src/sim/map.ts](src/sim/map.ts). This makes bugs reproducible and lets you replay an identical match with exactly one balance number changed.
- **Event log** — `resolve()` emits an ordered event list. Clients animate from those events, never by diffing state. It doubles as the replay format.
- **Data tables** — unit, terrain, and missile stats live as plain keyed data in [src/sim/defs.ts](src/sim/defs.ts), never hardcoded in logic. A balance pass should be a one-file diff.

## Docs

- **[docs/nuke-wars-v1-spec.md](docs/nuke-wars-v1-spec.md)** — the design specification. Source of truth for every rule, number, and V1 scope decision.
- [docs/v2-backlog.md](docs/v2-backlog.md) — deferred features. Reference only; never implement from it.
- [CLAUDE.md](CLAUDE.md) — working instructions and current status.
