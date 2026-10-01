# Nuke Wars

A 1v1 web-based strategy game: simultaneous hidden orders, hex-grid maneuver, drone reconnaissance, and a hidden-bunker decapitation endgame. Combat is fully deterministic — the only randomness in the game is map generation.

The design pillar is **commit → dread → reveal**. Both players queue orders without seeing the other's, resolution is simultaneous, and every exposure is a choice: firing reveals your launcher, advancing risks contact, and your recon drone finds the enemy bunker only by flying into defended air.

Each side fields the entire roster: **3 mobile launchers** (move *or* fire, never both), **1 interceptor base** (covers 2 hexes around it, stops at most 1 missile per round — saturation beats defense — and gives itself away the first time it does), **1 recon drone** (the only way to find the bunker), **1 hidden bunker** (2 hits, triggers a dead-hand retaliation when destroyed), and **1 decoy bunker** (1 hit, and indistinguishable from the real thing until a missile proves otherwise).

**Seeing the enemy is deliberately simple.** The terrain is public, but enemy assets are hidden until you detect them, and there are only two detectors: fly your drone over them, or watch them fire — every launch is detected automatically, by both sides. A spotted launcher stays on your map for one round only, because it can relocate; a spotted bunker site or interceptor base can't move, so it stays marked permanently (and recon can never tell the real bunker from the decoy). Your event log keeps every launch you've detected for the whole match.

## Status

**V1.5 — online beta.** Play at **<https://nuke-wars.vercel.app/>**: against a CPU opponent (three difficulty tiers), **hotseat** on one machine, or **Play online** against a friend. Create a room, send the link, and the match server pairs you up. Each round you have **35 seconds** to send your orders (a round resolves the moment both players have sent), and a match lasts at most 25 rounds.

**The rules are frozen** (since 2026-09-28; reopened once on 2026-10-01 to keep both bunker sites off the back row at the map edge). A how-to-play screen (`?` on any screen) teaches them in about three minutes. The board is a paper plotting table, each round replays from its event log with missiles in flight and inbound warnings, and the sound is synthesized in the browser.

Online play runs on the same engine as solo. The server holds the true match state and sends each player only what they may see, so a client never receives the enemy's hidden positions. A dropped connection or a reloaded tab rejoins its seat. 1016 tests.

See the "Current status" section of [CLAUDE.md](CLAUDE.md) for exactly where things stand, [docs/roadmap-v1.5.md](docs/roadmap-v1.5.md) for the V1.5 plan, [docs/playtests.md](docs/playtests.md) for the beta log, and [docs/history.md](docs/history.md) for how it was built. The client deploys to Vercel and the match server to Railway, both from `main` ([docs/deploy.md](docs/deploy.md)); every pull request is checked by GitHub Actions (lint, test, build).

## Stack

- **TypeScript** + **Vite 8** + **React 19**
- **PixiJS v8** — game map, units, effects
- **Zustand** — client state
- **Vitest** — unit tests

Plus **ws** for the Node WebSocket match server. Hex math is hand-rolled in [src/sim/hex.ts](src/sim/hex.ts) rather than pulled from a library, which keeps the simulation layer dependency-free; the server runs it unchanged.

## Commands

```bash
npm install
npm run dev      # dev server at localhost:5173
npm run build    # production build + full type-check
npm run lint     # ESLint
npm test         # Vitest, single run
npm run test:watch
npm run soak     # balance harness: CPU-vs-CPU matches, outcome stats
npm run server   # online match server on port 8787 (then npm run dev shows "Play online")
```

## Architecture

Strictly separated layers. The separation is non-negotiable — it's what lets the same engine run authoritatively on the server without modification.

| Directory | Role | Rule |
|---|---|---|
| `src/sim/` | Pure simulation engine | Never imports React, Pixi, DOM, or network code. All rules and state live here as pure functions. |
| `src/state/` | Match authority + Zustand store | `authority.ts` is the only module that ever holds the unfiltered state; the store holds only the filtered updates it is sent. |
| `src/render/` | PixiJS drawing | Reads state, draws it. Never mutates game state. The type flowing in is `VisibleGameState`. |
| `src/ui/` | React HUD/menus | Reads state, sends player intents. |
| `src/net/` | Wire protocol + browser connection | The messages shared with the server, and a WebSocket stand-in for the local authority. |
| `server/` | Node.js WebSocket server | Rooms, order clock, reconnect, rate limits; runs the same authority and routes each player only their own filtered updates. |

Three rules govern the sim layer:

- **Determinism** — `resolve(state, orders)` is fully deterministic by design: V1 combat uses no randomness at all, and every simultaneous tie has a written tiebreak in the spec. The seeded RNG in [src/sim/map.ts](src/sim/map.ts) exists only for map generation. Bugs are reproducible and a replay is just the initial state plus the orders.
- **Event log** — `resolve()` emits an ordered event list with per-player visibility rules (spec §6). Clients animate from those events, never by diffing state. It doubles as the replay format.
- **Data tables** — unit, terrain, and rule numbers live as plain keyed data in [src/sim/defs.ts](src/sim/defs.ts), never hardcoded in logic. A balance pass should be a one-file diff.

**`resolve()` never lies; [src/sim/visibility.ts](src/sim/visibility.ts) does.** The engine always computes and emits the whole truth — a decoy is stored and logged as a decoy. `filterForPlayer` / `filterEventsForPlayer` hand each player a redacted copy, and that module is the only layer permitted to know the difference. In hotseat it hides the inactive player's information across the handoff; online, the server applies it before sending, so a client never receives the enemy's positions and cheating is impossible by construction rather than by policy.

**And the filter cannot be skipped.** A redaction layer only protects callers that actually call it, so the unfiltered state lives in a closure variable inside [src/state/authority.ts](src/state/authority.ts) — not in the store, not exported, no accessor. There is no code path by which a component could obtain one, which makes "the renderer never sees the truth" a property of the module rather than a rule someone has to remember.

## Docs

- **[docs/nuke-wars-v1-spec.md](docs/nuke-wars-v1-spec.md)** — the design specification. Source of truth for every rule, number, and V1 scope decision. Fully post-pivot (2026-08-11).
- [docs/v2-backlog.md](docs/v2-backlog.md) — deferred features, including everything cut in the V1 pivot. Reference only; never implement from it.
- [CLAUDE.md](CLAUDE.md) — working instructions and current status.
