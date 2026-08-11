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
- Combat/resolution animates from the emitted event log, not by diffing states. Event visibility (which player may see which event) is specified in spec §6 — respect it in the visibility filter, never in resolve().
- **`resolve()` never lies; the visibility filter does.** The decoy bunker must be indistinguishable from the real one to the enemy, but the sim always stores and emits the truth (`kind: 'decoy'`). The decoy→bunker mask is applied *only* in `filterForPlayer`/`filterEventsForPlayer` (spec §6, §12). The visibility filter is the single place in the codebase permitted to know a decoy is a decoy.
- **Detection rules (spec §11) — four rules, no exceptions.** (1) The map is public and your own assets are always visible. (2) An enemy asset appears on your map only via one of exactly two detectors: the recon drone's swath, or automatic launch detection. (3) A launcher sighting lasts **one round** (the next order phase, then it's cleared — it can relocate); a static sighting (bunker, decoy, interceptor base) is **permanent** until public destruction. (4) No detection distinguishes the real bunker from the decoy. There is no vision radius around units, no line of sight, and no persistent "last seen" ghost markers — that history lives in the event log, which is permanent.
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

### ✅ Code and docs are both post-pivot as of 2026-08-11 — no known mismatch

### Completed
- Project scaffold; `src/sim/hex.ts` (axial hex math + odd-q offset↔axial bridge + `hexKey`, unit-tested); `src/sim/map.ts` (symmetric terrain gen with seeded RNG, O(1) `tileAt()` — the mirror became a 180° rotation on 2026-08-11, see below); `src/render/GameCanvas.tsx` (Pixi hex map, flat-top, pan/zoom/hover/select, StrictMode-safe); `src/sim/types.ts` + `src/sim/defs.ts` (pre-pivot versions); `src/sim/movement.ts` (`reachableHexes` cost-aware flood fill + `validateMove`). 47 tests passing. TS `strict` on. Sim layer dependency-free.
- 2026-08-11: **design pivot** — spec rewritten (deterministic combat, drone recon, per-round intercept cap, hits-based damage, secret placement, straight-line flight via `hexLine`); v2-backlog gained the cut-systems ledger; README updated. All seven pre-pivot open design questions resolved (see spec's "Resolved-by-pivot ledger").
- 2026-08-11: **build-order step 2 — pivot migration DONE.** `types.ts` rewritten (5 unit kinds, MOVE/LAUNCH/FLY orders, §6 event shapes with per-round `missileId`, two-part intel, `droneRespawnIn`, `deadHandFor`, `SETUP` phase, `MUTUAL_DISARMAMENT` outcome); `defs.ts` rewritten (`UNIT_DEFS` with hp, `SPAWNS`/`ALL_SPAWN_HEXES`, `RULES` with `ordersPerUnit`/ranges/exclusion/home zones/round cap); `map.ts` forces the 8 spawn hexes to plains (§12); new `map.test.ts`; `movement.test.ts` migrated. Two gaps found and closed: `validateMove` now rejects drone MOVE orders with `AIR_UNIT` (its move 6 is a flight range, not a ground budget), and the movement tests now derive geometry from `UNIT_DEFS.launcher.movement` instead of hardcoding it. Spec amended: `missileId` on the three missile events, `DRONE_RESPAWNED` row, MOVE-is-launcher-only note in §9. 67 tests passing.
- 2026-08-11 (docs only, no logic changed): **detection rules rewritten and simplified.** Spec §11 is now four flat rules (map is public / exactly two detectors / launcher sighting lasts 1 round, static sighting is permanent / nothing tells bunker from decoy). Persistent launcher ghost markers were **cut**; the permanent record is the event log (§6). "Fog of war" retired as a term project-wide — architecture layer 2 is now the **visibility filter**. Touched: spec §2/§6/§7/§9/§11/§12 + ledger, README, v2-backlog, and the comments in `types.ts` and `movement.ts`.
- 2026-08-11 (same session, amendment): **decoy bunker added to V1** — 1 per player, 1 HP, secretly placed, rule-identical to the real bunker except HP (spec §12's indistinguishability principle). Roster is now 5 asset kinds / 8 assets per player. Spec §1/§2/§3/§4/§6/§7/§8/§11/§12 amended; v2-backlog marks the decoy promoted out of deferred (its "false signal emission" behaviour stays V2).

- 2026-08-11: **map axis corrected to north/south.** Territory was split left/right (19w × 15t, mirrored columns); it is now split top/bottom — **P1 holds the south and advances north**, P2 holds the north. Map is **16 wide × 19 tall**. Symmetry changed from a column mirror to a **180° rotation** (`rotate180` in `map.ts`), because a top/bottom mirror is geometrically impossible on flat-top odd-q hexes — verified by brute force over all 92k hex pairs before committing to it. Width must stay even for the half-turn to be an isometry; `generateMap` throws otherwise. `defs.ts`: `SPAWNS` transposed (P1 launchers row 16 / drone row 17; P2 row 2 / row 1 — 14 rows apart, same as the old 14 columns, so §7 tuning is untouched), `homeZoneCols` → `homeZoneRows`. Spec §7 gained a north/south statement and a "why a rotation, not a mirror" note; §8/§11/§12 de-mirrored. `GameCanvas` now fits the (portrait, ~900px) board to the window on first paint. 81 tests passing.

- 2026-08-11: **terrain simplified to two types (`feature/terrain-tiles`).** `urban` is **cut** (flavour-only, no rule; its V2 regime-score role is flagged in `v2-backlog.md`). `Terrain` is now `'plains' | 'mountain'`. Mountains went from ~14% scattered singletons to **15% grown as ranges** — 4 per generated half, walked with a 0.7 straightness bias, then a de-orphaning pass that relocates any lone mountain against an existing range, so "every mountain touches another" is a guaranteed property and not a tendency. Because ridges (unlike noise) can wall a board off, `generateMap` is now **generate → validate → re-roll**: coverage inside 10–20%, all 8 spawns in one connected plains region, and no launcher more than 12 ground-cost from a firing position on the enemy line (8 on open ground — this is the §7 "first blood ~round 3" premise made testable). Re-roll rather than carve, because an asymmetric carve breaks the half-turn. Spawn hexes *and their rings* are now excluded from mountain seeding up front, rather than converted to plains afterwards. **Rules change: bunker, decoy and interceptor bases may be built on mountains**; launchers and drones still spawn and move on plains only. `TerrainDef.passable` → `groundPassable` and new `RULES.placementTerrain` — the rename exists so placement code cannot silently reuse the movement flag. New `defs.test.ts` asserts bunker and decoy allow identical terrain (§12) and that HP is their only difference; `movement.test.ts` cross-checks the new `groundCostsFrom` in `map.ts` against `reachableHexes` so the two flood fills can't drift. Spec §2/§7/§10/§11/§12 + ledger amended. 116 tests passing.

### Next up: build-order step 3 — `hexLine()` in `hex.ts`
Cube-lerp line drawing with the pinned (+1e-6, +2e-6) epsilon nudge (spec §10), plus tests. One primitive, used by **both** missiles and drone flight, so every layer (sim, UI preview, V1.5 server) must produce byte-identical paths — the epsilon constants are part of the spec, not an implementation detail. Test the grazing cases that sit exactly between two hexes; those are the whole reason the nudge exists.

Then step 4: `resolve()` skeleton + the ground-movement phase (§9 standoffs, one-order-per-unit batch validation, `UNIT_MOVED`/`MOVE_FAILED`, and the determinism test — same inputs twice, deep-equal outputs).

**Gotchas for future sessions — each of these is load-bearing, don't "simplify" any of them:**
1. The decoy is immobile and **blocks hexes** exactly like any ground unit. If it were passable, walking a launcher through a site would identify the fake for free.
2. The decoy never emits `BUNKER_HIT` — it dies to the hit. That silence-vs-destruction difference *is* the tell that identifies the real bunker.
3. Destroying a decoy triggers no dead hand and satisfies no win condition.
4. **Hits stack within a round** (spec §3): two missiles on a full-health real bunker kill it outright, so the impact phase must total damage per hex, not apply one hit per hex.
5. **`IMPACT` fires even when the target hex is empty** (spec §6). If it only fired on hitting something, its presence would leak occupancy and blind-fire probing would locate bunkers and bases for free.
6. **The dead-hand round is launches only** (spec §3): phases 2→3 only, no recon phase, no movement phase, no orders from the opponent.
7. **Terrain is public** (spec §11). Hidden information covers assets, never tiles — the visibility filter must never strip or mask `MapData`.
7b. **`groundPassable` is not "can this be built here"** (spec §2, §12). V1 has two terrains, and mountains block *movement only*: bunker, decoy and interceptor base may all be built on them. Placement validation must read `RULES.placementTerrain`, never `TerrainDef.groundPassable` — the field was renamed from `passable` precisely so that mistake looks wrong. The corollary for step 6: **missile targeting must never filter by terrain**, or a mountain bunker becomes invulnerable (spec §10).
7c. **`generateMap` validates and re-rolls; never patch a bad map.** Mountains are grown as ranges, and unlike scattered noise a ridge can wall the board off, so every generated map is checked for coverage, spawn connectivity and approach cost (spec §7). Carving a pass through an offending ridge is the tempting fix and it is a trap — every carve must be applied to a hex *and its half-turn twin* or the two players silently get different maps.
8. **Launcher sightings expire after one order phase; static sightings never do** (spec §11). The intel state therefore has two parts with different lifetimes: a permanent set of revealed static assets, and a this-round-only set of launcher contacts that is rebuilt from scratch every resolution. Don't "improve" this by keeping stale launcher markers with a round number — persistent ghosts were deliberately cut; the event log is the history.
9. **The event log is append-only and permanent** (spec §6). Every launch a player detected stays readable for the whole match. Expiring a map marker must never delete a log entry.
10. **`UNIT_DEFS.drone.movement` is a straight-line flight range, not a ground budget** (spec §11). Never feed the drone to the ground-movement flood fill — it ignores terrain and units entirely. `reachableHexes` returns only its own hex for a drone and `validateMove` rejects drone MOVE orders with `AIR_UNIT`; the drone moves by FLY, resolved with `hexLine`.
11. **The board is fought north/south and its width MUST stay even** (spec §7). Territory splits by *row*: P1 south (rows 13–18, high numbers, advancing north), P2 north (rows 0–5). Hexes are flat-top precisely so the advance axis has true N/S neighbours. Map symmetry is a **180° rotation, not a mirror** — on flat-top odd-q hexes a top/bottom mirror shears the grid and hands the two players subtly different distances, and the half-turn is only an isometry while the width is even (hence 16, not 15). `generateMap` throws on an odd width and `map.test.ts` checks distance preservation over every hex pair. Consequence to expect, not "fix": the two sides' launcher *columns* differ (P1 col 2 answers P2 col 13).

### Open questions
- None blocking. All §7 numbers are untested first drafts (validate by playtest after step 10); the §10 unit-id intercept tiebreak is accepted-arbitrary by design.

### Known issues
- Code/spec mismatch until the migration session lands (see warning above). Nothing else outstanding: the pivot docs were committed on `docs/v1-pivot` and merged into `main` on 2026-08-11, so `main` carries the post-pivot design with pre-pivot code.
