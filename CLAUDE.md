# Nuke Wars — Project Instructions

## What this project is
A 1v1 web-based strategy game: simultaneous hidden orders under a countdown timer, hex-grid maneuver, fog of war, finite interceptor defenses, and a hidden-Leader decapitation endgame ("commit → dread → reveal" is the core loop).

**The full game design is in `docs/nuke-wars-v1-spec.md`. Read it before implementing any game rule, and treat it as the source of truth for all mechanics, numbers, and V1 scope.** If an implementation decision would change a rule or number in the spec, say so explicitly and update the spec file as part of the change.

`docs/v2-backlog.md` is deferred-feature reference only — never implement from it.

## Stack
- TypeScript + Vite + React 18
- PixiJS v8 for the game map/rendering
- Zustand for client state
- Hex math is hand-rolled in `src/sim/hex.ts` (axial coords) — deliberately dependency-free so the sim engine can move server-side unchanged in V1.5
- Later (V1 step 5+): Node.js WebSocket server (not yet in the project)

## Architecture rules (non-negotiable)
- `src/sim/` — pure simulation engine. NEVER import React, Pixi, DOM APIs, or anything network-related here. All game rules, state, and resolution live here as pure functions.
- `src/render/` — PixiJS drawing only. Reads state, draws it. Never mutates game state.
- `src/ui/` — React HUD/menus. Same rule: reads state, sends player intents.
- All randomness in `src/sim/` must flow through the seeded RNG (`makeRng` in `src/sim/map.ts`). `resolve()` must be deterministic given (state, orders, seed). No `Math.random()` in sim code.
- Game stats/definitions (units, missiles, terrain) go in plain data tables keyed by string IDs, not hardcoded logic branches.
- Combat/resolution animates from the emitted event log, not by diffing states.

## Workflow rules
- One system per session. Confirm the session goal before writing code, and don't touch systems outside the stated boundary.
- For sim-engine work: define/adjust TypeScript types first and show them for approval before implementing logic.
- Every sim-engine feature ships with Vitest unit tests: normal case, edge cases, and at least one illegal-order case.
- Prefer small, verifiable steps. After changes, tell me exactly how to verify (what command to run, what I should see in the browser).
- Don't add new dependencies without asking first.
- At the end of each session, update the "Current status" section below.

## Working with me
- I'm a coding beginner. Explain what you're doing and why in plain terms as you go — teach, don't just produce.
- Primary machine is Windows (project at `C:\Users\stirl\nuke-wars`), but I also work remotely from a MacBook. Check which OS the current session is actually running on before giving shell commands — don't assume Windows.
- Walk me through any manual steps click-by-click.
- If something I ask for conflicts with the spec or architecture rules, push back and explain the trade-off instead of silently complying.

## Commands
- `npm run dev` — start dev server (localhost:5173)
- `npm run build` — production build / full type-check
- `npm run lint` — ESLint
- (once tests exist) `npx vitest` — run unit tests

## Current status (update at end of every session)
- Completed: project scaffold; `src/sim/hex.ts` (axial hex math + odd-q offset↔axial bridge + `hexKey`, unit-tested); `src/sim/map.ts` (mirrored terrain gen with seeded RNG, plus O(1) `tileAt()`); `src/render/GameCanvas.tsx` (Pixi hex map, flat-top orientation, pan/zoom/hover/select, StrictMode-safe init/destroy); wired into App; `src/sim/types.ts` (core sim types); `src/sim/defs.ts` (`UNIT_DEFS`/`TERRAIN_DEFS` balance tables); `src/sim/movement.ts` (`reachableHexes` cost-aware flood fill + `validateMove`). 47 tests passing. TS `strict` is on. `honeycomb-grid` was removed — hex math is hand-rolled and the sim layer is dependency-free.
- Next up: **applying** movement inside `resolve()` — mutate state, emit `UNIT_MOVED` events, and decide the two rules deliberately left open below.
- Rules decided this session: occupied tiles block both passage *and* landing (destroyed units block nothing); moving to your own hex is illegal (`SAME_HEX`), not a no-op.
- Open questions: (1) HP for launcher/radar/interceptor isn't in the spec (only the Leader's "2 penetrating hits") — assuming 1, unconfirmed. (2) `MISSILE_DEFS` doesn't exist yet — needed for the launch/interception sessions. (3) **Simultaneous-move conflicts**: two units ordered into the same empty hex in one round — who wins? (4) **Fog vs. blocked moves**: `validateMove` runs against true state, so a player can legally order a move into a hex a hidden enemy occupies. Does the order fail entirely, or move as far as it can? Both (3) and (4) must be settled in the next session.
- Known issues: none currently.
