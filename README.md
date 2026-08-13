# Nuke Wars

A 1v1 web-based strategy game: simultaneous hidden orders, hex-grid maneuver, drone reconnaissance, and a hidden-bunker decapitation endgame. Combat is fully deterministic — the only randomness in the game is map generation.

The design pillar is **commit → dread → reveal**. Both players queue orders without seeing the other's, resolution is simultaneous, and every exposure is a choice: firing reveals your launcher, advancing risks contact, and your recon drone finds the enemy bunker only by flying into defended air.

Each side fields the entire roster: **3 mobile launchers** (move *or* fire, never both), **2 interceptor bases** (each stops at most 1 missile per round — saturation beats defense), **1 recon drone** (the only way to find the bunker), **1 hidden bunker** (2 hits, triggers a dead-hand retaliation when destroyed), and **1 decoy bunker** (1 hit, and indistinguishable from the real thing until a missile proves otherwise).

**Seeing the enemy is deliberately simple.** The terrain is public, but enemy assets are hidden until you detect them, and there are only two detectors: fly your drone over them, or watch them fire — every launch is detected automatically, by both sides. A spotted launcher stays on your map for one round only, because it can relocate; a spotted bunker site or interceptor base can't move, so it stays marked permanently (and recon can never tell the real bunker from the decoy). Your event log keeps every launch you've detected for the whole match.

## Status

**V1 (hotseat) — in development.** The design was pivoted on 2026-08-11 (see the spec) and the sim code is fully migrated to it. **The simulation engine is feature-complete, it is wired to the screen, and the game is playable against a CPU opponent.** Built and tested: hex math including the `hexLine` flight primitive, self-validating symmetric map generation (mountain ranges, re-rolled until playable), launcher movement, secret setup placement, `resolve()` with **all five phases** — recon drone, launch and interception, impact, the outcome check, and ground movement — the dead-hand retaliation round and win/draw state machine, and the **visibility filter** that turns the engine's omniscient truth into each player's redacted view. On top of that sits a Zustand store that owns the match, a Pixi board that draws one player's redacted view, a HUD that keeps that player's permanent event log, an order builder, a setup-placement screen, and a difficulty-tiered CPU that plays from its own redacted view rather than from the truth. 550 tests.

You can play a full match today: **hide your bunker and decoy**, place two interceptor bases at least 3 hexes from both, then fly recon, advance launchers and fire — against a CPU that is hunting your bunker while you hunt its. The board draws your units, your intel and your interceptor coverage; the log fills; and flipping the viewer between P1 and P2 shows the same truth as two completely different pictures. What is still missing is the **hotseat handoff** — the pass-the-screen sequence that lets two humans share one machine without seeing each other's board — which is step 10c.

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
| `src/state/` | Zustand match store | The only module that ever holds the unfiltered state, in a module-private variable with no accessor. Everything it hands out has been through the visibility filter. |
| `src/render/` | PixiJS drawing | Reads state, draws it. Never mutates game state. The type flowing in is `VisibleGameState`. |
| `src/ui/` | React HUD/menus | Reads state, sends player intents. |
| *(V1.5)* | Node.js WebSocket server | Rooms, order collection, authoritative resolve, per-player visibility filter. |

Three rules govern the sim layer:

- **Determinism** — `resolve(state, orders)` is fully deterministic by design: V1 combat uses no randomness at all, and every simultaneous tie has a written tiebreak in the spec. The seeded RNG in [src/sim/map.ts](src/sim/map.ts) exists only for map generation. Bugs are reproducible and a replay is just the initial state plus the orders.
- **Event log** — `resolve()` emits an ordered event list with per-player visibility rules (spec §6). Clients animate from those events, never by diffing state. It doubles as the replay format.
- **Data tables** — unit, terrain, and rule numbers live as plain keyed data in [src/sim/defs.ts](src/sim/defs.ts), never hardcoded in logic. A balance pass should be a one-file diff.

**`resolve()` never lies; [src/sim/visibility.ts](src/sim/visibility.ts) does.** The engine always computes and emits the whole truth — a decoy is stored and logged as a decoy. `filterForPlayer` / `filterEventsForPlayer` hand each player a redacted copy, and that module is the only layer permitted to know the difference. In hotseat it hides the inactive player's information across the handoff; in V1.5 the server applies it before broadcasting, so a client never receives the enemy's positions and cheating is impossible by construction rather than by policy.

**And the filter cannot be skipped.** A redaction layer only protects callers that actually call it, so the unfiltered state lives in a module-private variable inside [src/state/match.ts](src/state/match.ts) — not in the store, not exported, no accessor. There is no code path by which a component could obtain one, which makes "the renderer never sees the truth" a property of the module rather than a rule someone has to remember.

## Docs

- **[docs/nuke-wars-v1-spec.md](docs/nuke-wars-v1-spec.md)** — the design specification. Source of truth for every rule, number, and V1 scope decision. Fully post-pivot (2026-08-11).
- [docs/v2-backlog.md](docs/v2-backlog.md) — deferred features, including everything cut in the V1 pivot. Reference only; never implement from it.
- [CLAUDE.md](CLAUDE.md) — working instructions and current status.
