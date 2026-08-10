# Nuke Wars — Project Instructions

## What this project is
A 1v1 web-based strategy game: simultaneous hidden orders under a countdown timer, hex-grid maneuver, fog of war, finite interceptor defenses, and a hidden-Leader decapitation endgame ("commit → dread → reveal" is the core loop).

**The full game design is in `docs/nuke-wars-v1-spec.md`. Read it before implementing any game rule, and treat it as the source of truth for all mechanics, numbers, and V1 scope.** If an implementation decision would change a rule or number in the spec, say so explicitly and update the spec file as part of the change.

`docs/v2-backlog.md` is deferred-feature reference only — never implement from it.

## Stack
- TypeScript + Vite + React 18
- PixiJS v8 for the game map/rendering
- Zustand for client state
- honeycomb-grid for hex math (sim layer)
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
- Completed: project scaffold; `src/sim/hex.ts` (axial hex math — distance/neighbors/hexesInRange, unit-tested); `src/sim/map.ts` (mirrored terrain gen with seeded RNG); `src/render/GameCanvas.tsx` (Pixi hex map, flat-top orientation, pan/zoom/hover/select, StrictMode-safe init/destroy); wired into App; `src/sim/types.ts` (core sim types: `GameState`, `Unit`, `Order`, `GameEvent`, `Outcome` — approved, no logic yet).
- Next up: movement logic against the approved types — offset (col/row) ↔ axial (q/r) coordinate bridge, launcher movement validation (≤2 hexes/round, mountains impassable), with Vitest tests incl. an illegal-move case (spec §6–§8, build-order step 2, movement sub-stage).
- Open questions to resolve before/during the movement or damage sessions: (1) HP for launcher/radar/interceptor isn't specified in the spec (only the Leader's "2 penetrating hits" is) — current assumption is 1 (destroyed by any impact), unconfirmed. (2) `UNIT_DEFS`/`MISSILE_DEFS` data tables (movement points, ammo, radii, the spec §7 numbers) don't exist yet — needed once movement/launch logic is implemented.
- Known issues: none currently.
