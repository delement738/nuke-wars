# Nuke Wars — Project Instructions

## What this project is
A 1v1 web-based strategy game: simultaneous hidden orders, hex-grid maneuver, drone reconnaissance, fully deterministic combat (no dice — dread comes from hidden information), and a hidden-bunker decapitation endgame ("commit → dread → reveal" is the core loop).

**The full game design is in `docs/nuke-wars-v1-spec.md`. Read it before implementing any game rule, and treat it as the source of truth for all mechanics, numbers, and V1 scope.** If an implementation decision would change a rule or number in the spec, say so explicitly and update the spec file as part of the change.

**The design was pivoted on 2026-08-11** (single missile type, unlimited munitions, recon drone, decoy bunker, per-round intercept cap, hits-based damage, deterministic combat). The spec is fully post-pivot; spec section *numbers* §1–§9 kept their old meanings so code citations stay valid, and §10–§12 are new. **But §8's build-order step numbers changed** — old step 2 was "simulation engine core"; new step 2 is the pivot migration. Existing code comments citing "build-order step 2" mean the old numbering; fix them as you touch each file. Systems cut in the pivot (and the decoy, promoted back in) are listed at the top of `docs/v2-backlog.md`.

`docs/v2-backlog.md` is deferred-feature reference only — never implement from it.

## Stack
- TypeScript + Vite + React 19
- PixiJS v8 for the game map/rendering
- Zustand for client state
- Hex math is hand-rolled in `src/sim/hex.ts` (axial coords) — deliberately dependency-free so the sim engine can move server-side unchanged in V1.5
- Later (V1.5, build-order step 11+): Node.js WebSocket server (not yet in the project)

## Architecture rules (non-negotiable)
- `src/sim/` — pure simulation engine. NEVER import React, Pixi, DOM APIs, or anything network-related here. All game rules, state, and resolution live here as pure functions.
- `src/render/` — PixiJS drawing only. Reads state, draws it. Never mutates game state.
- `src/ui/` — React HUD/menus. Same rule: reads state, sends player intents.
- **V1 combat is deterministic BY DESIGN — `resolve()` uses no randomness at all.** The seeded RNG (`makeRng` in `src/sim/map.ts`) is used only for map generation. `resolve()` keeps a `seed` parameter for forward compatibility but nothing in V1 resolution may read it (documented in spec §6 — don't "fix" this by adding RNG). No `Math.random()` anywhere in sim code, ever. Every simultaneous tie has a written tiebreak in the spec (§10); determinism bugs are iteration-order bugs.
- Game stats/definitions (units, terrain, rule numbers) go in plain data tables keyed by string IDs in `src/sim/defs.ts`, not hardcoded logic branches.
- Combat/resolution animates from the emitted event log, not by diffing states. Event visibility (which player may see which event) is specified in spec §6 — respect it in the fog filter, never in resolve().
- **`resolve()` never lies; the fog filter does.** The decoy bunker must be indistinguishable from the real one to the enemy, but the sim always stores and emits the truth (`kind: 'decoy'`). The decoy→bunker mask is applied *only* in `filterForPlayer`/`filterEventsForPlayer` (spec §6, §12). The fog filter is the single place in the codebase permitted to know a decoy is a decoy.
- **The indistinguishability principle (spec §12):** every rule that mentions the bunker must apply identically to the decoy, with hit points the only exception. Any asymmetry becomes a rules-derived tell that identifies the real bunker for free. When writing a new rule that touches the bunker, ask whether it must also name the decoy — the default answer is yes.

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
- `npm test` — Vitest, single run (`npm run test:watch` for watch mode)

## Current status (update at end of every session)

### ⚠️ Code predates the 2026-08-11 pivot — migration is the next session
The docs (spec, backlog, README) are fully post-pivot. The code is NOT yet:
- `src/sim/types.ts` is stale: has `radar`/`leader` unit kinds (now `launcher`/`interceptor`/`drone`/`bunker`/`decoy`), `MissileType`/`MissileStock`, a `RECON` order (now `FLY` for the drone), `missileStock`/`reconSweepsRemaining` in `GameState`, and pre-pivot event shapes.
- `src/sim/defs.ts` is stale: `radar` row; `RULES.ordersPerRound`/`moveOrdersPerUnit` are replaced by `RULES.ordersPerUnit = 1` (spec §3/§9); launcher movement is now 3 (spec §7) and its "spec §7: 2 hexes/round" comment is wrong.
- `src/sim/movement.test.ts` references the `radar` kind and old RULES in comments/fixtures.
- `src/sim/map.ts` doesn't yet force the 8 fixed spawn hexes to plains (spec §12).
- Unaffected by the pivot: `src/sim/hex.ts` (+tests) entirely; `src/sim/movement.ts`'s algorithm (it reads UNIT_DEFS, so kind changes flow through); `src/render/GameCanvas.tsx`.

### Completed
- Project scaffold; `src/sim/hex.ts` (axial hex math + odd-q offset↔axial bridge + `hexKey`, unit-tested); `src/sim/map.ts` (mirrored terrain gen with seeded RNG, O(1) `tileAt()`); `src/render/GameCanvas.tsx` (Pixi hex map, flat-top, pan/zoom/hover/select, StrictMode-safe); `src/sim/types.ts` + `src/sim/defs.ts` (pre-pivot versions); `src/sim/movement.ts` (`reachableHexes` cost-aware flood fill + `validateMove`). 47 tests passing. TS `strict` on. Sim layer dependency-free.
- 2026-08-11: **design pivot** — spec rewritten (deterministic combat, drone recon, per-round intercept cap, hits-based damage, secret placement, straight-line flight via `hexLine`); v2-backlog gained the cut-systems ledger; README updated. All seven pre-pivot open design questions resolved (see spec's "Resolved-by-pivot ledger").
- 2026-08-11 (same session, amendment): **decoy bunker added to V1** — 1 per player, 1 HP, secretly placed, rule-identical to the real bunker except HP (spec §12's indistinguishability principle). Roster is now 5 asset kinds / 8 assets per player. Spec §1/§2/§3/§4/§6/§7/§8/§11/§12 amended; v2-backlog marks the decoy promoted out of deferred (its "false signal emission" behaviour stays V2).

### Next up: build-order step 2 — pivot migration (types first, show for approval)
Checklist: `UnitKind = 'launcher' | 'interceptor' | 'drone' | 'bunker' | 'decoy'`; drop `MissileType`/`MissileStock`; Orders → `MOVE` (launcher), `LAUNCH` (launcher, target hex, no missile-type field), `FLY` (drone destination); events per spec §6 visibility table (`LAUNCH_DETECTED`, `MISSILE_INTERCEPTED`, `IMPACT` hex-only, `UNIT_DESTROYED` (truthful about decoys), `BUNKER_HIT` (real bunker only), `DRONE_DOWNED`, `DRONE_MOVED`, `ASSET_SPOTTED` (masked decoy→bunker at filter time, not here), `UNIT_MOVED`, `MOVE_FAILED`, `DEAD_HAND_TRIGGERED`, `GAME_OVER`); `GameState` needs per-player intel (permanent static-asset reveals + launcher ghost markers) and drone-respawn countdown; defs.ts → new `UNIT_DEFS` (launcher move 3 hp 1; interceptor move 0 hp 1; drone move 6 air; bunker move 0 hp 2; **decoy move 0 hp 1**) + `RULES` (`ordersPerUnit: 1`, missile range 6, coverage radius 1, interceptsPerRound 1, respawn/blind-round, round cap 25, spawn coords, home zones, **exclusion 3 from bunker *and* decoy**); `map.ts` spawn-hex plains guarantee; fix `movement.test.ts` kind names (`radar` → `interceptor`/`bunker` in the immobile-unit cases; the decoy is a fourth immobile kind worth adding to that `it.each`). Then step 3: `hexLine()` with the pinned (+1e-6, +2e-6) nudge (spec §10) and tests.

**Gotchas for future sessions — each of these is load-bearing, don't "simplify" any of them:**
1. The decoy is immobile and **blocks hexes** exactly like any ground unit. If it were passable, walking a launcher through a site would identify the fake for free.
2. The decoy never emits `BUNKER_HIT` — it dies to the hit. That silence-vs-destruction difference *is* the tell that identifies the real bunker.
3. Destroying a decoy triggers no dead hand and satisfies no win condition.
4. **Hits stack within a round** (spec §3): two missiles on a full-health real bunker kill it outright, so the impact phase must total damage per hex, not apply one hit per hex.
5. **`IMPACT` fires even when the target hex is empty** (spec §6). If it only fired on hitting something, its presence would leak occupancy and blind-fire probing would locate bunkers and bases for free.
6. **The dead-hand round is launches only** (spec §3): phases 2→3 only, no recon phase, no movement phase, no orders from the opponent.
7. **Terrain is public** (spec §11). Fog hides assets, never tiles — the fog filter must never strip or mask `MapData`.

### Open questions
- None blocking. All §7 numbers are untested first drafts (validate by playtest after step 10); the §10 unit-id intercept tiebreak is accepted-arbitrary by design.

### Known issues
- Code/spec mismatch until the migration session lands (see warning above). Docs changes are uncommitted as of the pivot session — commit when ready.
