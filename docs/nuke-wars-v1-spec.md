# NUKE WARS — V1 Design Specification

*A 1v1 strategic command-and-control duel. Simultaneous hidden orders, hex-grid maneuver, drone reconnaissance, and a hidden-bunker decapitation endgame. All combat is deterministic — the only randomness in the game is map generation.*

> **Pivot note (2026-08-11):** this spec supersedes the pre-pivot design. The old missile roster (SRM/MRM), missile stock, radar stations, interceptor ammo economy, probabilistic interception, damage variance, and recon-sweep orders were all cut; the recon drone and the decoy bunker were added. See "Cut in the V1 pivot" and "Promoted back INTO V1" in `docs/v2-backlog.md`.
>
> Section numbers §1–§9 keep their pre-pivot *meanings* (objective, scope, flow, outcomes, state machine, architecture, numbers, build order, ground movement) so existing code comments that cite them stay valid. §10–§12 are new. **The §8 build-order step *numbers* did change** — pre-pivot step 2 was "simulation engine core", post-pivot step 2 is the migration and the engine is now steps 4–8. Code comments citing a step number by name predate this and should be updated as each file is touched.

**Design pillars (judge every feature against these):**

1. **Commit → Dread → Reveal.** Players commit orders without knowing the enemy's; resolution is simultaneous and dramatic. Moving into striking range — or firing at all — is itself the act of exposure.
2. **Deterministic and explainable.** No dice in combat. Every loss must be traceable to information the player could have had. Dread comes entirely from hidden information, never from luck.

**Milestones:** **V1 = hotseat (two players, one screen), playable and fun.** **V1.5 = networked 1v1 with countdown timer.** Everything else is V2+.

---

## 1. Objective

Destroy the enemy regime before yours falls. Two paths:

1. **Decapitation** — find the enemy bunker with your recon drone, destroy it with 2 direct missile hits, then survive their final retaliation (dead hand).
2. **Disarmament** — destroy all 3 enemy mobile launchers. A player with zero launchers has zero offensive capability (munitions are unlimited, so launchers are the only thing that runs out) and **loses immediately**.

Both the bunker and a **decoy bunker** are hidden, and to the enemy they are indistinguishable on sight. Finding theirs, telling real from fake, and keeping yours unfound is the heart of the game.

---

## 2. V1 Scope

### The complete asset roster (5 types, 8 assets per player — this is everything)

| Asset | Count | Mobility | HP | Role |
|---|---|---|---|---|
| **Mobile Launcher** | 3 | 3 hexes/round, ground | 1 hit | The only offense. Each round: move **or** launch one missile (range 6) — never both. Cannot target drones. |
| **Interceptor Base** | 2 | Static (placed at setup) | 1 hit | Covers its own hex + 6 neighbors (radius 1). Destroys **at most 1 enemy missile per round** whose flight path crosses its coverage. Also destroys any enemy drone that enters coverage (does not consume the missile intercept). |
| **Recon Drone** | 1 | 6 hexes/round, air | — | Flies a straight line each round, revealing a 3-wide swath. The **only** way to find enemy bunker sites and interceptor bases — though recon alone cannot tell the real bunker from the decoy. Spotted launchers stay on your map for one round; spotted static assets stay forever (§11). Killed only by enemy interceptor coverage. Respawns after 1 blind round. |
| **Bunker** | 1 | Static (placed at setup) | 2 direct hits | The leader. Hidden until a drone swath reveals it; once revealed, revealed forever (it cannot move). Its destruction triggers dead hand. |
| **Decoy Bunker** | 1 | Static (placed at setup) | 1 direct hit | Empty concrete. Identical to the real bunker in every observable way (§12) — same placement rules, reported as a bunker by enemy recon. Destroying it wins nothing and triggers nothing; it costs the attacker a missile, a launcher's round, and the exposure of having fired. |

**Air layer:** the drone never blocks, and is never blocked by, ground units or terrain. Missiles cannot hit it; it cannot be hit on the ground. Drones ignore mountains. Two drones may cross or share a hex; drones never interact with or reveal each other.

**Munitions are unlimited.** No missile stock, no interceptor ammo counts. The interceptor limit is *per round* (rate), not total (stockpile).

**Terrain — two types, and that is the whole system:**

| Terrain | Share | Rule |
|---|---|---|
| **Plains** | ~85% | Passable. The only ground a launcher moves on, and the only ground a launcher or drone spawns on. |
| **Mountains** | ~15% | **Impassable to launchers.** Missiles and drones cross freely, and **static structures — bunker, decoy, interceptor base — may be built on them** (§12). Generated as *ranges*, not scattered noise (§7). |

**Mobile things need plains; built things do not.** A mountain stops a vehicle, not a construction crew. A bunker on a mountain is still photographed by recon, still marked permanently once spotted, and still destroyed by two missiles — nothing about it is safer except that no enemy launcher can ever be ordered onto it, so ground probing can never bump into it (§9, §11). What it pays for that is a much narrower search: terrain is public, so the enemy knows precisely which hexes those are.

*Urban terrain was cut on 2026-08-11.* It was flagged "visual flavour only" and carried no rule, so it was a third case in every terrain switch for no gameplay. Its V2 role (regime hexes as score) is recorded in `docs/v2-backlog.md` and would need reintroducing there.

**Roster discipline:** V1 fields exactly five asset types — one mobile offensive unit, one static defense, one recon unit, one leader piece, one decoy — plus a single missile type. That is 8 assets per player and nothing else. Depth comes from interactions (interceptor geometry × concealment × the real-or-fake read × counter-battery exposure), not roster size.

### Deferred to V2+
See `docs/v2-backlog.md`, including everything cut in the 2026-08-11 pivot.

---

## 3. Gameplay Flow

### Order phase — one commit window

Both players secretly queue orders, then both confirm. **Every living asset may receive at most one order per round** (`RULES.ordersPerUnit = 1`). Bunkers, decoys, and interceptor bases never take orders; they are permanently static and act passively. Only launchers and the drone are orderable. Possible orders:

- **MOVE** a launcher (ground movement, §9)
- **LAUNCH** a missile from a launcher at any hex within range 6 (blind fire at unseen hexes is legal; the target hex just must be on the map and not the launcher's own hex)
- **FLY** the drone to a destination hex within 6 (straight-line flight, §11)

A launcher with no order holds position. A drone with no order hovers in place.

### Resolution — five strictly ordered phases

1. **Recon flight.** Drones fly their lines simultaneously; interception is checked hex-by-hex (§10); reveals are recorded for safely traversed hexes (§11).
2. **Launch & interception.** All missiles fire and fly simultaneously; interceptor bases engage per §10.
3. **Impact.** Surviving missiles strike their target hexes simultaneously, each dealing `RULES.missileDamage` (1). Direct hit only — **no splash damage to neighboring hexes.** Whatever **ground** asset occupies the hex takes the hit, friendly or enemy — a drone over the target hex is untouched (§2's air layer), and an already-destroyed unit takes no second hit. Launchers, interceptor bases, and decoy bunkers die to 1 hit; the real bunker takes 1 of its 2. **Hits stack within a round:** two missiles landing on the same full-health bunker in one round destroy it outright — a 2-missile alpha strike is a legitimate way to skip the decoy test (§12), at the price of wasting a missile if the target turns out to be the fake.
4. **Outcome check.** Win/draw conditions are evaluated (§4). If a **real** bunker was just destroyed, dead hand triggers. Destroying a decoy never triggers anything.
5. **Ground movement.** Launcher moves resolve per §9.

**A round that ends at phase 4 stops there.** §3 originally said this only of dead hand; it applies to *any* phase-4 verdict (amended 2026-08-11, build-order step 7). If the match is over — or a dead-hand round is owed — phase 5 does not run, and neither does the drone respawn tick that hands over to the next order phase (§11). The outcome is unaffected either way, because nothing in movement can change a §4 condition; what it protects is the log, which would otherwise show launchers driving around *after* `GAME_OVER` for a client to animate. The consequence players feel: **the round that decapitates someone is a round in which nobody moves**, so you cannot reposition out of the dead-hand volley you just provoked — the same commitment the counter-battery rule imposes on firing.

**Phase-order consequences (intentional design, not accidents):**

- **Strikes land before movement**, so a launcher that fired last round (revealed origin, stationary) and is in enemy missile range **cannot escape a counter-battery strike this round** — the missile arrives before its move resolves. Firing is a hard commitment. The safe way to fire is from inside your own interceptor coverage or outside enemy reach.
- **Two launchers that fire at each other's positions in the same round both die** (both missiles are in flight simultaneously). This needs no special rule — it falls out of phase order.
- **Recon flies first**, so the drone photographs enemy launchers at their *pre-move* positions. Under the single commit window, drone intel can never influence launches committed the same round — it pays off next round. (A two-stage commit was considered and rejected for V1: it doubles the hotseat handoffs and the order-phase machinery.)

### Dead hand

When a player's real bunker is destroyed, they get one final round: every surviving launcher they own may fire one missile (normal range 6 from its current hex).

**The dead-hand round is launches only.** The only legal order is LAUNCH; no ground movement and no drone flight happen, so the round runs resolution phases 2 → 3 (launch & interception, then impact) and then adjudicates. There is no phase 1 and no phase 5. The opponent issues no orders at all, but their interceptor bases defend normally (1 intercept per base). Then the game ends and §4 adjudicates.

If both real bunkers die in the same impact phase, skip dead hand — it is already Mutual Annihilation.

**A decapitated player with no launchers left gets no final round** (amended 2026-08-11, build-order step 7). "Every surviving launcher may fire one missile" is not a round that can be played with zero of them: it could not change the adjudication, and in hotseat it would be a pass-the-screen handoff to confirm an empty order phase. The match ends immediately in Victory by Decapitation, and no `DEAD_HAND_TRIGGERED` is emitted, because no final round happened. Nothing is hidden by this: launcher losses are public (`UNIT_DESTROYED`, §6) and both sides start with three, so both players can see the retaliation was empty before it is skipped.

**The dead-hand round carries its own round number.** It is a real round, and missile ids are `r{round}@{origin}` (§6) — reusing the previous round's number would let a launcher firing twice from the same hex put two events with one id into a log that keeps both forever.

**Match length target: 10–20 minutes.**

---

## 4. Outcomes (checked after each full resolution, in priority order)

| # | Outcome | Condition |
|---|---|---|
| 1 | **Draw — Mutual Annihilation** | Both bunkers destroyed (same round, or via dead-hand retaliation) |
| 2 | **Victory by Decapitation** | Enemy bunker destroyed, your bunker survives the dead-hand round |
| 3 | **Victory by Capitulation** | Opponent resigns |
| 4 | **Draw — Mutual Disarmament** | Both players' last launchers destroyed in the same round |
| 5 | **Victory by Disarmament** | Enemy has zero launchers, you have at least one |
| 6 | **Draw — Armistice** | Round cap (25) reached with no victory |

Bunker outcomes outrank launcher outcomes: a player who loses their last launcher in the same resolution that destroys the enemy bunker still wins by decapitation (subject to dead hand).

**The decoy bunker is never an outcome.** Destroying it triggers no dead hand, wins nothing, and does not count toward any condition above. Its only effects are informational.

**Absence is not destruction** (ruled 2026-08-11, build-order step 7). Every condition above is read off units that exist and are flagged destroyed — a side with no bunker *unit* is not decapitated, and a side with no launcher *units* is not disarmed. In a real match this never differs, since `startMatch` (§12) gives both players a bunker and three launchers; it exists so the engine stays inert on the partial boards its tests are built from, and because "you lose by having your launchers destroyed" is the honest reading of §1.

**Capitulation is not a fact about the board.** No arrangement of units implies a resignation, so `resolve()` never returns it; whatever owns the match sets it when a player resigns (build-order step 9). It stays in the table because a game-over screen must render it.

**Rows 4 and 5 are read as board state, not as history.** A player with zero launchers loses immediately (§1), so the match can never reach a later round with one still standing at zero — which makes "in the same round" in row 4 descriptive rather than an extra condition to test.

---

## 5. Game State Machine

```
SETUP (secret placement, P1 then P2)
   -> ORDER_PHASE <-> RESOLUTION -> (check outcomes §4)
                          |
                 bunker destroyed?
                          v
            DEAD_HAND_PHASE -> FINAL_RESOLUTION -> GAME_OVER
```

Victory conditions are evaluated only after a full resolution completes — never mid-resolution. Phase 4 is that point: it reads the post-impact board, which is the only place in a round where anything is destroyed, so evaluating there rather than after phase 5 cannot change a verdict (see §3).

**One entry point drives the whole diagram.** `resolve(state, ordersP1, ordersP2, seed)` runs a normal round or a dead-hand round according to `state.phase`, so no caller — store, UI, or V1.5 server — has to know which kind of round it is asking for. It **throws** when called on a `GAME_OVER` or `SETUP` state: the phase is the engine's to set, so either is a caller bug, and failing loudly beats a silent no-op that hides it. The `SETUP -> ORDER_PHASE` edge is `startMatch` (§12), not `resolve`.

`RESOLUTION` and `FINAL_RESOLUTION` are **presentation states**, not resting ones. Resolution is atomic in the engine — one call in, next state out — so a state handed back is never mid-resolution; those two nodes are where the client sits while it animates the event log.

---

## 6. Technical Architecture

**Stack:** TypeScript. PixiJS (map/units/effects) + React (HUD/menus) + Zustand (client state). Hex math is hand-rolled in `src/sim/hex.ts` (axial coordinates), keeping the sim engine dependency-free. V1.5 adds Node.js + WebSockets.

**Four layers, strictly separated:**

1. **Simulation engine** — pure TypeScript, zero React/Pixi/network imports. One pure function: `resolve(state, ordersP1, ordersP2, seed) -> newState + eventLog`. Fully unit-tested. In V1.5 this runs server-side and authoritative, unchanged.
2. **Visibility filter** — pure functions `filterForPlayer(state, playerId) -> visibleState` and `filterEventsForPlayer(events, playerId) -> visibleEvents` (visibility table below; the detection rules they implement are §11). In hotseat they hide the inactive player's info; in V1.5 the server applies them before sending, making cheating impossible by construction.
3. **Presentation** — Pixi + React. Reads visible state, renders, builds pending orders. Never mutates game state.
4. **Network (V1.5)** — rooms, order collection window, countdown enforcement, reconnect, per-player broadcast.

**Determinism rule (strengthened by the pivot):** V1 combat uses **no randomness at all** — identical (state, orders) always yields identical results, full stop. The seeded RNG (`makeRng` in `src/sim/map.ts`) is used *only* for map generation. `resolve()` keeps the `seed` parameter for forward compatibility (V2 may reintroduce chance) but **nothing in V1 resolution may read it** — this is documented so nobody hunts for missing RNG plumbing. All remaining nondeterminism risks are iteration-order bugs; every simultaneous tie in this spec has a written tiebreak.

**Event log rule:** `resolve()` emits an ordered event list. Clients animate from events, never by diffing states. Also the replay format.

**The log is permanent; map markers are not.** Each player keeps every event they were allowed to see for the whole match — the full history of detected launches is always readable. Map detections expire on the §11 schedule (launchers after one round, static assets never). The log is history; the map is live intel. Do not conflate them.

**Event visibility table** (which player may see which event — the detection rules these serve are §11):

| Event | Visible to |
|---|---|
| `LAUNCH_DETECTED` (origin, target) | **Both** — launches are loud, and detection is automatic and unsuppressable. The origin marks an enemy launcher on the defender's map for **one round** (§11); the log entry itself is permanent |
| `MISSILE_INTERCEPTED` (missile id + hex) | **Both** — probing lanes with missiles is legitimate, risky recon. Names no interceptor base: the attacker learns only that *some* base covers that hex, i.e. one of 7 candidates |
| `IMPACT` (missile id + hex — **never** names a victim) | **Both.** Emitted for **every** missile that reaches its target hex, including hits on empty ground. This is load-bearing: if `IMPACT` only fired when something was struck, its mere presence would reveal that the hex was occupied, and blind-fire probing would find bunkers and bases for free — defeating both the `BUNKER_HIT` secrecy rule below and "only drones find bunkers" |
| `UNIT_DESTROYED` (unitId, kind, hex) | **Both** — kills are observable. Reports a destroyed decoy **truthfully as a decoy**: masking it as "bunker" would fool nobody, since the absence of dead hand gives it away in the same instant, and a lie the engine has to maintain is a bug waiting to happen |
| `BUNKER_HIT` (unitId, owner, hex, hpRemaining — a non-lethal hit on a bunker **or decoy**) | **Owner only.** To the attacker, a non-lethal bunker hit is indistinguishable from hitting empty ground — this preserves "only drones find bunkers" against blind-fire probing. The rule names both site kinds, but at 1 HP a decoy can never reach it: it dies to the hit that would cause it, and that *silence after a hit* is exactly what identifies the real bunker. Writing the rule as "bunker or decoy" is what keeps §12's tuning lever (raise the decoy to 2 HP) indistinguishable by construction rather than needing a new rule |
| `DRONE_DOWNED` (hex) | **Both** (the defender knows their own base locations, so this leaks nothing to them; the owner learns only the death hex — the killing base is somewhere within 1, i.e. 7 candidates). This is the drone's *only* death event: it does **not** also emit `UNIT_DESTROYED`, which is for ground assets |
| `DRONE_MOVED` (unitId, owner, from, to, **path**), `ASSET_SPOTTED` (recon results) | **Spotting player only.** Note the two name their audience differently: `DRONE_MOVED.owner` *is* the spotting player (it is their drone), while `ASSET_SPOTTED.owner` is the owner of the asset that was **seen** — so its audience is that player's *opponent*. It is the one event where reading `owner` as "who may see this" is exactly backwards. A spotted decoy is reported with `kind: 'bunker'` — the visibility filter applies the mask, so `resolve()` never lies and the sim stays honest internally (§11). `DRONE_MOVED` is emitted for **every** living drone every round, hovers included (from = to, path = one hex), so the round's swath is always in the log for the client to animate and the replay to keep. Its `path` is what the drone **transmitted**, not where it flew: on a downed flight it stops one hex short of the kill (§11), so anything drawing the reveal corridor from `path` is correct without knowing that rule |
| `DRONE_RESPAWNED` (unitId, owner, hex) | **Owner only.** The enemy learning your recon is back online would be free intel they did nothing to earn. The spawn hex is public knowledge anyway (§12) — what is private is the *timing* |
| `UNIT_MOVED` (unitId, owner, from, to), `MOVE_FAILED` (unitId, owner) | **Owner only.** `MOVE_FAILED` still carries no destination, no blocker and no reason code (§9) — both of its fields describe the recipient's *own* unit, so it stays leak-proof by construction |
| `DEAD_HAND_TRIGGERED`, `GAME_OVER` | **Both** |

**Every owner-only event names its audience.** `filterEventsForPlayer(events, playerId)` is handed the log and a player id and *nothing else* — no `GameState` — so it cannot look a `unitId` up to discover whose event it is reading. A `UnitId` is deliberately an opaque string that nothing may derive meaning from (see the missile-id rule below, and §11 on withholding trackable identities), so the audience has to be stated on the event itself. Every owner-only event therefore carries `owner: PlayerId`: `UNIT_MOVED`, `MOVE_FAILED`, `BUNKER_HIT`, `DRONE_MOVED` and `DRONE_RESPAWNED`, joining `DRONE_DOWNED`, which already did. This leaks nothing — the only player who ever receives one is the owner, who knows their own units — and it keeps the filter a pure function of the log alone, which is what lets a replay be re-filtered without reconstructing the state of each round. The one exception to read carefully is `ASSET_SPOTTED`, whose `owner` is the spotted asset's side and whose audience is therefore the *other* player.

**Missile ids carry no information.** `LAUNCH_DETECTED`, `MISSILE_INTERCEPTED`, and `IMPACT` share a per-round missile id so the client can tell which missile an event belongs to and animate from the log rather than guess. It is derived from public data only — the round number plus the origin hex, which `LAUNCH_DETECTED` already publishes to both players — so it leaks nothing about the firing launcher's identity. A launcher fires at most one missile per round and no two launchers share a hex, so it is unique. Never derive it from a unit id: that would hand the enemy a trackable identity, which §11 deliberately withholds.

**The log is grouped by phase, and canonically ordered inside each phase.** A resolution emits its events in §3's phase order — recon, then launches and interceptions, then impacts and their damage, then movement, then the respawn tick — so a client can animate straight through the array without sorting or looking ahead. Within a phase the order is fixed by the data, never by how a client sorted its submission: **launch events go in canonical missile order** (origin hex, §10), **interceptions in chronological flight-step order**, and **every event naming a unit in `GameState.units` order** (§9). Phase 3 emits **all** `IMPACT`s before any damage event, which is also what keeps `IMPACT` honest — it names no victim and reveals nothing by its position in the log.

**Data-table rule:** unit/terrain stats and rule numbers live in plain data objects keyed by string IDs in `src/sim/defs.ts`, never hardcoded in logic. Balance patches = edited numbers, a one-file diff.

---

## 7. First-Draft Numbers (tune in playtest)

| Parameter | Value |
|---|---|
| Map size | 16 wide x 19 tall, symmetric under a 180° rotation (see note below) |
| Mountain coverage | 15% of the board (46 of 304 hexes), grown as **4 ranges per half**; the generator enforces a 10–20% band |
| Mountain shape | Every mountain hex touches another — no lone hexes (`TERRAIN_GEN.rangeStraightness`) |
| Spawn clearance | No mountain on, or adjacent to, any of the 8 spawn hexes |
| Max approach cost | 12 (8 on open ground) — see the generation note below |
| Orders | 1 per living asset per round (no global cap — with 3 launchers + 1 drone, 4 is the natural maximum) |
| Round cap | 25 |
| Launchers | 3 per player, 1 HP, move 3 hexes/round OR launch |
| Missile | range 6, direct hit only, kills 1-HP assets, bunker takes 2 hits |
| Interceptor bases | 2 per player, 1 HP, coverage radius 1, max 1 missile intercept per round each; drone kills are free |
| Recon drone | 1 per player, 6 hexes/round straight-line, reveal swath = path + everything within `RULES.reconSwathRadius` (1, i.e. 3 wide) |
| Drone respawn | 1 full blind round, then respawns at the drone spawn hex |
| Launcher sighting (recon or detected launch) | Visible for **1 round** — the next order phase only (§11) |
| Static sighting (bunker, decoy, interceptor base) | **Permanent**, until the asset is publicly destroyed (§11) |
| Bunker | 1 per player, 2 direct hits |
| Decoy bunker | 1 per player, 1 direct hit, no effect on any win condition |
| Interceptor placement exclusion | ≥ 3 hexes from **both** your bunker and your decoy (identical rule for both — §12) |
| Home zones (placement + spawns) | **P1 rows 13–18 (south), P2 rows 0–5 (north)** — full-width 6-row bands, 7 rows of neutral ground between them (offset coords) |
| Fixed spawns P1 | launchers (2,16), (8,16), (13,16); drone (8,17) — P2 is their half-turn image: (13,2), (7,2), (2,2); drone (7,1) |
| Match length target | 10–20 minutes |

**The board is fought north/south.** P1 holds the southern edge and advances north; P2 holds the northern edge and advances south. Row 0 is the top of the screen, so P1's home rows are the *high* numbers. This is not cosmetic — hexes are **flat-top**, which means every hex has a true north and south neighbour and none directly east or west, so an advance up the board is a straight line rather than a zigzag. The north/south axis is the long one (19) precisely because it is the axis of approach.

**Why a 180° rotation rather than a mirror.** The map is flat-top hexes in odd-q offset coordinates, where odd columns sit half a hex lower than even ones. A top/bottom mirror is therefore geometrically impossible: reflecting the row index lands odd columns half a hex off the grid, and the two halves end up at subtly different distances from their owner's spawns — an invisible unfairness no playtest would ever isolate. A half-turn about the map centre is a true isometry (distances, adjacency and movement costs all survive it), **but only while the map width is even** — hence 16, not 15 or 19. `generateMap` throws on an odd width, and `map.test.ts` checks distance preservation across every pair of hexes on the board. The visible consequence is that the two sides' launcher *columns* differ (P1's col 2 answers P2's col 13); their geometry is identical.

**Why mountains are generated as ranges, and why the generator validates itself.** Scattered singleton mountains at 15% are speed bumps: a launcher steps around one without the detour ever mattering. The same 15% grown into ridges is walls, chokepoints, and routes — terrain that shapes an advance instead of decorating it. That is the point, and it is also the risk: unlike noise, ridges can produce a map nobody can cross. So `generateMap` **generates, validates, and re-rolls** rather than patching, and a map is rejected if any of three things is true:

1. Mountain coverage falls outside 10–20%.
2. The 8 spawn hexes are not all in one connected region of plains (a ridge across the board, or a launcher walled into a pocket).
3. Any launcher's ground path to a hex within missile range of an enemy launcher spawn costs more than 12. On open ground that path costs 8 — the 14-row gap less the missile's 6 — which at movement 3 is what the tuning note below is built on. 12 permits about one extra round of detour; past that, matches drift toward the Armistice draw.

**Re-rolling rather than carving is deliberate.** Cutting a pass through an offending ridge is the tempting fix and it is a trap: every carve must be applied to the hex *and its half-turn twin* or the two players quietly receive different maps, which is the exact failure this whole layout exists to prevent. A rejected map is thrown away whole and a fresh one rolled from a derived seed, so `generateMap` stays a pure function of its seed.

**Tuning intuition:** launcher speed 3 vs missile range 6 vs the 14 rows between the two launcher lines gives ~2 rounds of maneuver before first exchanges are possible, and the drone reaches the enemy home zone on round 2 — first blood around round 3 without any grace-period rule. The pre-pivot grace rules (no launches round 1, leader untargetable rounds 1–3) were **cut as redundant: starting geometry enforces them.** If spawn positions or ranges change, re-check that this stays true.

---

## 8. Build Order (one focused session each)

**V1 — hotseat**
1. [DONE] Hex map render (Pixi): rotationally symmetric terrain, pan/zoom, hover/select.
2. **Pivot migration:** rewrite `types.ts` (unit kinds `launcher | interceptor | drone | bunker | decoy`, new Order/Event shapes, GameState with per-player intel — permanent static reveals + this-round launcher contacts (§11) — and drone respawn tracking, drop MissileStock/recon-sweep fields) and `defs.ts` (new UNIT_DEFS incl. the decoy row, `RULES.ordersPerUnit`); update movement tests' kind names; add spawn-hex terrain guarantee to `map.ts`. Types shown for approval before logic, per workflow.
3. **`hexLine()`** in `hex.ts` + tests: cube-lerp line drawing with the pinned epsilon nudge (§10). One primitive, used by both missiles and drones.
4. **`resolve()` skeleton + ground movement phase:** §9 application, one-order-per-unit batch validation, `UNIT_MOVED`/`MOVE_FAILED`, plus the determinism test (same inputs twice -> deep-equal outputs).
5. **Recon phase:** drone flight, interception, swath reveals, intel state (permanent static reveals + expiring launcher contacts, §11), respawn countdown.
6. **Launch/intercept/impact phases:** step-wise intercept assignment (§10), stacking damage, `UNIT_DESTROYED`/`BUNKER_HIT`, decoy destruction.
7. **Dead hand + outcomes + state machine**, including setup-placement validation as pure functions (home zone, terrain, spawn hexes, the ≥3 exclusion against *both* bunker and decoy).
8. **Visibility filter:** `filterForPlayer` + `filterEventsForPlayer` per the §6 visibility table and the §11 detection rules, including the decoy→bunker mask (§12). This is the single place in the codebase permitted to know a decoy is a decoy; test it explicitly, and test that a launcher contact is gone one round later.
9. **Wire sim -> renderer:** Zustand store owns state; canvas draws units/intel/highlights; HUD keeps the running event log (all detected launches, §11); single-player sandbox vs a static dummy opponent.
10. **Setup placement UI + order builder + hotseat handoff** (bunker → decoy → 2 bases per player, then orders; placement and resolution reveals are viewed per-player with a pass-the-screen handoff, since both contain private intel). **<- V1 done: playable and testable for fun.**

**V1.5 — networked**
11. WebSocket server: rooms, order collection, authoritative resolve, per-player visibility filter.
12. Countdown timer, ready-up, reconnect handling.
13. Deploy: static client (Vercel/Netlify) + socket server (Fly.io/Railway).

Do not start V2 features until two humans have played V1 to completion multiple times.

---

## 9. Ground Movement Resolution Rules

Ground movement (launchers only — the drone is exempt, §11) resolves in phase 5, simultaneously for both players. These rulings are binding on `resolve()`.

**Foundational rule: every move is validated and applied against the ground positions as they stood at the *start of the movement phase*.** No move may depend on another move having already resolved. This keeps resolution order-independent, which the determinism rule (§6) requires. (Impacts in phase 3 may have destroyed units or created vacancies — the movement phase sees that post-impact state as its starting point.)

| Situation | Ruling | Why |
|---|---|---|
| Two units ordered into the same empty hex | **Standoff — neither moves.** | Symmetric, deterministic, needs no tiebreak. Same solution Diplomacy has used for a century. |
| Two units ordered to swap hexes | **Both orders illegal.** | Falls out of the occupied-tile rule for free: at phase start each destination is occupied. |
| Unit ordered into a hex another unit is vacating this round | **Illegal — no chaining or following.** | The hex is occupied at phase start. Permitting it would make resolution order-dependent. |
| Move blocked by an undetected enemy unit | **The order fails entirely; the unit holds position. No partial advance.** | Partial movement would require path reconstruction plus tiebreaks between equal-cost routes. More importantly, a failed order is part of what makes recon valuable: advancing into unscouted ground risks wasting that launcher's entire round. |
| Move blocked by terrain or a unit the player can currently see | **Rejected at order entry.** | The UI validates against the visibility-filtered state (§11), so these never reach resolution. Note a launcher contact that has expired is *not* visible — you can legally order a move into a hex where you saw a launcher two rounds ago, and it can fail. |

**MOVE is a launcher-only order.** The drone moves 6 hexes a round but only by FLY, along a straight `hexLine` that ignores terrain and units (§11) — so a MOVE order naming the drone is a category error, rejected at validation with its own reason (`AIR_UNIT`) rather than being quietly treated as immobile or, worse, run through the ground-movement flood fill.

**Occupancy:** a living ground unit (launcher, interceptor base, bunker, **decoy**) blocks both *passage through* and *landing on* its hex, friendly or enemy. Destroyed units block nothing. The drone neither blocks nor is blocked. Ordering a unit to the hex it already occupies is illegal, not a no-op — it would silently waste that unit's round.

The decoy blocking movement is not a detail — it is required by §12. If it were passable, an attacker could walk a launcher through a suspected site and identify the fake without firing a shot.

**One order per unit per round** (`RULES.ordersPerUnit` in `src/sim/defs.ts`). This subsumes the pre-pivot "one MOVE order per unit" rule and is also what makes move-XOR-launch structural: a launcher's single order is either a move or a launch. It is a balance lever, not an invariant — but raising it would unravel the counter-battery commitment dynamic (§3), so treat it as near-frozen.

**A unit given more than one order does nothing.** The count is over *all* order kinds, not just MOVEs — a launcher handed both a MOVE and a LAUNCH is over budget, so move-XOR-launch is enforced by the budget itself rather than by a separate rule. Such a unit holds position and emits no event. `resolve()` deliberately does not guess which order was meant: honouring the first would make the outcome depend on the client's array order, breaking §6 determinism, and an honest UI cannot produce this case at all. It is malformed input, and the safe reading of malformed input is "did nothing." One unit going over budget never disturbs the rest of the batch.

**Reporting a failed move.** A failed or standoff move emits exactly one event, `MOVE_FAILED`, carrying only the mover's own unit id — no destination, no blocker, no reason code. Standoffs and blocked advances are byte-identical, so the player cannot distinguish "an enemy was parked there" from "an enemy raced me for that hex." The event carries no enemy-derived data, so it is leak-proof by construction. Surface it as flavour ("your advance met resistance") without naming a hex or unit.

**Only failures hidden information could have caused are reported.** `MOVE_FAILED` fires for exactly two rejection reasons — the destination was occupied by a unit the mover could not see, and no route to the destination survived an unseen blocker (`TILE_OCCUPIED` and `OUT_OF_RANGE` in `movement.ts`). Every other rejection is a fact the ordering player could already see: terrain is public (§11), a unit's own position and kind are its own, and the UI validates against the visibility-filtered state before submitting. Those are dropped silently — the unit holds, no event.

The split is not fastidiousness, it is required. An order naming an *enemy* unit must emit nothing, because `MOVE_FAILED` names a unit id, and answering one would put a real enemy unit id into the sender's log — precisely the trackable identity §11 withholds. Given that constraint, reporting the remaining impossible-for-an-honest-client cases would only make "your advance met resistance" ambiguous between genuine contact and a UI bug, for no gain.

**Information leak (intentional):** a player whose move fails learns an enemy ground unit is adjacent-ish to that path. Making contact is genuine intelligence, and it is the defender's reward for positioning well. It is *not* a detection: nothing appears on the map (§11).

**Event emission order is canonical.** Movement events are emitted in `GameState.units` order, never in the order either client listed its orders. Both are deterministic, but only the former guarantees that the same physical outcome yields a byte-identical log regardless of how a client sorted its submission — which is what makes the §6 determinism test meaningful and keeps replays from diverging over presentation order.

---

## 10. Flight Paths & Interception

One geometric primitive powers both missiles and drone flight: **`hexLine(a, b)`** — the straight hex line from `a` to `b`, computed by cube-coordinate lerp + rounding (redblobgames method). Lines that graze exactly between two hexes are broken deterministically by nudging the interpolation with the fixed epsilon offsets **(+1e-6, +2e-6)**, applied in cube coordinates to **both endpoints** (the third offset is **-3e-6**, forced by q + r + s = 0). These constants are part of the spec: every layer (sim, UI preview, server) must produce the identical path.

**Both endpoints, not just the origin** (amended 2026-08-11, implementation session). This matches the redblobgames reference the method is taken from, so any reimplementation — notably the V1.5 server — can copy the standard code and agree with the client. It also makes the offset constant along the line, which makes lines **reversible**: `hexLine(a, b)` reversed is exactly `hexLine(b, a)`. Nudging only `a` shrinks the offset toward `b` and loses that property on grazing lines, which would let a UI previewing a line cursor-to-launcher draw a path the sim never flies.

`hexLine` returns **both endpoints** — `a` first, `b` last, length `distance(a, b) + 1` — and is pure geometry: no range limit, no terrain, no legality checks (those belong to the order validators). `hexLine(a, a)` returns `[a]`; "the drone may not fly to its own hex" (§11) is a validation rule, not a geometric one.

**Missile flight:** the missile traverses `hexLine(origin, target)`, checked for interception on every hex *after* the origin, including the target hex itself.

**A rejected LAUNCH is dropped in silence**, exactly like a rejected FLY (§11) and unlike a blocked MOVE. Every way a launch can be rejected — unknown, enemy or destroyed unit, an order naming something that is not a launcher, the launcher's own hex, off-map, or past range 6 — is derivable from the ordering player's own assets plus the public map, so none of them can have been caused by hidden information and none is worth reporting (§9's reasoning, applied to the missile layer). An honest UI cannot produce any of them. Note the asymmetry with a *legal* launch: firing is the loudest thing in the game, but failing to fire is silent, because nothing about the failure came from the enemy.

**Missiles ignore terrain entirely — in flight and in targeting.** Any hex on the map within range 6 is a legal target, mountains included, and no terrain blocks or deflects a missile in transit. This is load-bearing, not an omission: static structures may be built on mountains (§2, §12), so a targeting rule that filtered out impassable hexes would make a mountain bunker literally invulnerable and hand the defender a guaranteed win. Blind fire at a mountain hex is as legal as blind fire at open plains.

**Interception mechanics (phase 2):**

- A base covers its hex + 6 neighbors and may destroy **at most 1 enemy missile per round**. Friendly missiles and the owner's own drone are never engaged.
- All missiles fly simultaneously, advancing step-by-step along their paths. At each step, any missile entering a covered hex of an enemy base with capacity remaining is destroyed and that base's capacity for the round is spent. A missile crossing several coverage zones can be engaged by whichever base still has capacity when it enters.
- **Ties** (two missiles entering coverage at the same step, or one missile entering two bases' coverage at once): **missiles resolve in ascending origin-hex order** (`compareHex` in `hex.ts` — by `q`, then by `r`), **bases in ascending base id**. Arbitrary-but-deterministic, not a balance lever.

**Why the missile tiebreak is the origin hex and not the launcher's id** (amended 2026-08-11, build-order step 6). The pre-implementation wording put missiles in ascending *launcher unit-id* order. That is deterministic, but the ordering is publicly observable and unit ids are not supposed to be: with two launches in a round, the order of the log tells the defender which of two enemy launcher ids sorts first, and a few such rounds reconstruct the ordering of all three — enough to link "the same launcher" across rounds. §11 keys every scrap of intel by hex precisely to make that impossible, and §6 already forbids deriving missile ids from unit ids for exactly this reason. The origin hex is public the instant `LAUNCH_DETECTED` fires, so ordering by it is equally arbitrary, equally deterministic, and tells the enemy nothing they were not already handed. **Bases keep the id tiebreak**: a base belongs to the defender, who knows their own ids; no event ever names one; and a base cannot move, so there is no cross-round identity to track.
- The interception hex is a **public event** (§6). Deliberately firing cheap probes to map defense lanes is legal, valid strategy — the prober pays by revealing a stationary launcher to counter-battery.

**Why the 1-per-round cap exists (do not remove it casually):** without it, interceptor geometry is self-protecting — a missile aimed at a base must cross that base's own coverage, so bases would be unkillable and any launcher parked inside a bubble would be permanently safe. The cap makes **saturation** the counter: a coordinated volley of 2+ missiles through the same lane in one round overwhelms it. The cap is the stalemate-breaker for the whole design.

**Drones and interception:** a drone is destroyed the moment it *enters* any hex of enemy interceptor coverage during its flight. Drone kills do **not** consume the base's per-round missile intercept. A drone can never start its turn in enemy coverage (it would have died entering it), so only entered hexes are checked.

---

## 11. Detection & Intel

### The detection rules — this is the entire system

1. **The map is public, and your own assets are always visible to you.** Only *enemy assets* are ever hidden.
2. **An enemy asset appears on your map only when you detect it.** There are exactly two detectors: your **recon drone's swath** and **automatic launch detection**. Nothing else on the board reveals an enemy asset — no adjacency, no line of sight, no "you can see 2 hexes around your units."
3. **How long a detection lasts depends only on whether the thing can move.**
   - **Mobile (launchers) — one round.** The sighting is on your map for your next order phase, then it is gone. A launcher moves 3 hexes a round, so an older sighting is a guess, not intel.
   - **Static (bunker, decoy, interceptor bases) — permanent.** They cannot move, so the sighting stays true forever. It leaves your map only when the asset is publicly destroyed.
   - **Either way, `UNIT_DESTROYED` clears the marker.** Public destruction removes that hex from the enemy's map — the permanent static reveal and, for a launcher killed the same round it was detected, the one-round contact too. The map shows only what is true right now; the kill is in the log forever.
4. **No detection ever tells the real bunker from the decoy.** Both enter your map as a *bunker site* and stay labelled that way until a missile proves otherwise (§12).

Everything below is detail on those four rules.

### The two detectors

| Detector | Fires in | What it puts on your map | For how long |
|---|---|---|---|
| **Recon drone swath** | Phase 1 | Every enemy asset in the swath — launchers and bunker/decoy sites. **Interceptor bases are excluded in practice, not by rule** — see "Bases are inferred, never photographed" below | Launchers: 1 round. Static assets: permanent |
| **Launch detection** | Phase 2 | The origin hex of every enemy missile fired this round (`LAUNCH_DETECTED`, §6). Automatic and unavoidable — launches are loud; no equipment is needed to detect one and nothing can suppress it | 1 round — a launcher can relocate next round, so the marker expires with it |

A launch origin is a *launcher* sighting, so it follows the mobile rule. The `LAUNCH_DETECTED` event stays in your log permanently (below); the map marker does not.

**A launcher caught by both detectors in one round is one contact, not two.** Intel is keyed by hex, so the second detector to report a hex changes nothing; the first one to file it is the one kept. The two can never disagree about *where*: a launcher that fired cannot also have moved (§9), so if recon photographed it as well, both report the same hex. The only thing the source affects is UI flavour — a recon contact is normally "possibly already stale" and a launch contact never is.

### Exactly when a one-round sighting is visible

**A detection made during round N's resolution is on your map for the whole of round N+1's order phase, and is cleared when round N+1 resolves.** You get exactly one order phase to act on it. Two consequences the design leans on:

- **A recon sighting can already be stale when you get it.** Recon flies in phase 1 and launchers move in phase 5 of the *same* round, so the launcher you photographed may have driven off before you ever issue an order. Shooting at a recon contact is a bet.
- **A launch origin cannot be stale.** A launcher that fires cannot also move (one order per unit, §9), so it is still sitting on the origin hex when the round ends, and your counter-battery missile lands in phase 3 — before it can move in phase 5 (§3). A detected launch is therefore a live target for exactly one round, which is what makes firing a hard commitment.

### What does *not* detect anything

These are public events (§6). They report that something happened at a hex; they never place an enemy asset on your map.

- **`IMPACT`** — emitted for every missile arrival, including hits on empty ground, precisely so its presence leaks nothing about occupancy.
- **`MISSILE_INTERCEPTED`** — tells you an enemy base covers that hex, i.e. the base is one of 7 candidates. That is an inference you draw, not a reveal; the base is not marked until recon actually sees it.
- **`DRONE_DOWNED`** — same shape of clue, same 7 candidates.
- **`MOVE_FAILED`** — you learn only that *your own* move was blocked, with no hex, no blocker, and no reason (§9). This is the closest thing to a third detector, and it is why terrain matters to concealment: a plains hex can be probed by driving a launcher at it, and a **mountain hex cannot be probed at all**, because the order is rejected at entry from public terrain data before it ever reaches resolution (§12).
- **Drones are never detectable at all.** No swath and no event ever reveals an enemy drone to you; drones do not reveal each other (§2). The only thing that touches an enemy drone is interceptor coverage, which kills it.

### The event log is permanent history, not live intel

Each player keeps an **append-only log of every event they were allowed to see** (§6), for the whole match — it is also the replay format. So the full record of **every launch you have detected**, with its round, origin hex and target hex, stays readable for the rest of the game.

The log and the map say different things on purpose:

- **The log** answers *"where have they fired from before?"* — pattern, tempo, which corner of the board they operate in.
- **The map** answers *"where is an enemy launcher right now?"* — and only for the one round a sighting is good for.

A launch logged in round 4 is a record of where a launcher *was* in round 4. By round 6 that launcher could be anywhere within 6 hexes of it. Reading the history is free; acting on it is a guess.

### Recon drone mechanics

**Drone flight order:** destination hex within 6; the drone flies `hexLine(current, destination)`. The player steers by choosing sweep lines, not by drawing paths (free-path waypoint orders are V2 — this keeps the order UI trivial and reuses §10's primitive). Ordering the drone to its own hex is illegal (give no order to hover). Hovering is safe: coverage kills on *entry* only.

**A hovering drone still watches.** A drone with no order — or with one that was rejected, or that went over budget (§9) — hovers, and a hover is resolved as a zero-length flight, so it transmits the corridor around its own hex. This is what makes "give no order to hover" a real choice rather than a wasted round: hovering trades the width of a sweep for the certainty of not flying into a coverage bubble. It is strictly weaker than flying, which sweeps far more hexes for the same round.

**A rejected FLY order is dropped in silence** — there is no air-layer counterpart to `MOVE_FAILED`. Every way a FLY can be rejected (unknown/enemy/destroyed unit, a launcher named instead of the drone, its own hex, off-map, out of range) is derivable from information the ordering player already holds, so unlike a blocked MOVE none of them can have been caused by hidden information and none is worth reporting (§9's reasoning, applied to the air layer). An honest UI cannot produce any of them.

**Reveal swath:** for every hex the drone safely traverses this round (including its start hex, including the destination), the hex and everything within `RULES.reconSwathRadius` of it is revealed — at radius 1, the hex and its 6 neighbours, a 3-wide corridor. **A drone that is shot down reveals nothing *from* its death hex** — it is destroyed before transmitting from there. Note the precise meaning: the death hex contributes no corridor of its own, so everything *beyond* it is unseen; the death hex itself is still photographed, from the corridor of the last hex the drone safely reached. Its owner learns only the death hex (`DRONE_DOWNED`), leaving 7 candidate hexes for the killing base. Intel transmitted from earlier hexes in the same flight is kept (live transmission, not recovered-wreckage).

**Seeing a static asset again is not news.** A permanent reveal is recorded once, keyed by hex, and keeps the round it was *first* spotted; re-photographing a building that cannot move changes nothing. The `ASSET_SPOTTED` event still fires each time the drone sees it, because the event log records observations, not deltas.

**A spotted decoy is reported to the enemy as a bunker.** The sim always stores and emits the truth (`kind: 'decoy'`); the visibility filter applies the mask on the way out, and is the only layer permitted to know the difference (§6, §12).

**Drone loss & respawn:** when your drone is shot down you play the **next full round with no drone**. "Blind" means *no drone only*: launch detection still works, and your permanent static reveals are all kept (one-round launcher sightings still expire on the normal schedule — nothing preserves them). The round after that, a fresh drone spawns at your fixed drone spawn hex at the start of the order phase. Respawns are unlimited: recon can be taxed and delayed, never permanently denied.

Precisely: a drone downed during round N's phase 1 sets `droneRespawnIn` to `RULES.droneRespawnDelay` (2). The counter ticks down as each resolution hands over to the next order phase — so it reads 1 for round N+1 (the blind round) and reaches 0 as round N+1 resolves, putting the replacement on the board in time to be **ordered** in round N+2. The tick is deliberately not one of §3's five resolution phases; it belongs to the start of the order phase, which is what makes the drone visible to the player who has to give it an order.

The replacement is the *same unit*, revived at the spawn hex: one drone unit per player exists for the whole match, flagged destroyed while it is down. Reusing the id leaks nothing, because no detector ever reports an enemy drone at all — no drone id is ever observable across the wire.

**Terrain is public.** Both players see the whole map from the start — it is rotationally symmetric, so hiding it would achieve nothing. Hidden information covers *assets only*, never tiles. The visibility filter must never strip or mask `MapData`.

### Bases are inferred, never photographed (decided 2026-08-11)

Raised as an open question while implementing build-order step 5, **decided at the start of step 6: the radii stay as they are.**

`RULES.reconSwathRadius` (1) and `RULES.interceptorCoverageRadius` (1) are equal, and that makes base-spotting geometrically impossible. Any base close enough to fall inside the swath is, by that same distance, covering a hex the drone must *enter* in order to see it — so the drone is destroyed one step before the picture is taken. Verified by brute force over every flight geometry: the only cases where a drone photographs a base are ones where the base sits within 1 of the drone's *starting* hex, which cannot arise in a real match (the drone would have died entering that hex, and spawn hexes are 7+ rows from any legal enemy placement).

**So an interceptor base is found by inference, and a dying drone is the strongest clue there is.** The public 7-candidate signals — `MISSILE_INTERCEPTED` and `DRONE_DOWNED` — are the base-detection mechanic: you pay a drone (or a probing missile) for a 7-hex answer, and the ≥3 exclusion rule (§12) then turns that answer into a narrowed bunker search. Recon itself stays a launcher-and-bunker hunter.

Why not the alternatives: raising `reconSwathRadius` to 2 would let the drone photograph bases from outside the bubble, but it widens *every* reveal from a 3-wide corridor to a 5-wide one — a large across-the-board buff that shortens the bunker hunt, which is the game's clock. Making coverage lethal to drones only on the base's own hex splits one rule into two and is exactly the shape of asymmetry §12 warns about. Both are one-number balance changes with board-wide consequences, and all §7 numbers are untested first drafts until playtest (§8 step 10) — so this is a decision to revisit with real games behind it, not a bug to fix in passing. The radius is a data-table number and `defs.ts` carries the note at both constants.

### Why launcher sightings expire (design note — do not "fix" this)

An earlier draft kept permanent "last seen (hex, round N)" ghost markers. They were cut because a stale marker *looks* like knowledge: the map fills with contacts that are mostly wrong, and the player either learns to ignore all of them or gets punished for trusting one. Under the current rule the map only ever shows things that are true right now — a launcher marker means "it was there at the start of this round," a static marker means "it is there, full stop." Nothing is lost, because the event log keeps the whole history; it is just presented as history instead of as a target.

**The intel race is the game clock:** the defender cannot point-defend the bunker (placement rule, §12) — only delay its discovery by killing drones, taxing time, and spending the attacker's shots on the decoy. Finding a "bunker" is therefore not the end of the hunt: the attacker must still spend a missile to learn whether it is real (§12). Once the *real* bunker is confirmed, its survival is measured in the rounds it takes to land 2 hits through the remaining interceptor lanes. Endgames are sharp by design.

---

## 12. Setup & Placement

**Fixed spawns (public knowledge, forced to plains by map generation):** each player's 3 launchers and drone spawn at the §7 coordinates. Map generation must guarantee these 8 hexes are plains; placement may never use a spawn hex.

**Secret placement (SETUP phase, hotseat: P1 places while P2 looks away, then swap):** each player places, in order:

1. **Bunker** — any non-spawn hex in their home zone (P1 rows 13–18 in the south / P2 rows 0–5 in the north), on **plains or mountain**.
2. **Decoy bunker** — the same constraints as the bunker, on a different hex. No minimum or maximum distance from the real bunker (see the design note below).
3. **2 Interceptor bases** — any non-spawn, unoccupied hex in their home zone, on **plains or mountain**, each **at least 3 hexes from both their own bunker and their own decoy** (so both sites and their neighbors sit outside all friendly coverage — no point-blank shield; defending approach *lanes* at a distance is legal and is the intended skill).

**All three placed assets may be built on any terrain** (`RULES.placementTerrain` in `src/sim/defs.ts`). The rule is "mobile things need plains, built things do not" — nothing static is driven into position, so nothing static cares whether a launcher could get there. Note that "passable" is therefore **not** the test for placement: `TerrainDef.groundPassable` answers only "may a ground unit *enter* this hex", and placement validation must read `RULES.placementTerrain` instead. The field is named `groundPassable` rather than `passable` specifically so that reaching for the wrong one looks wrong.

Each step validates against the rules above, and the UI must offer only legal hexes. A 6-row × 16-column home zone (96 hexes) is far larger than two radius-2 exclusion zones, so no bunker/decoy pair can box a player out of legal base positions — but placement validation is still a pure function in `src/sim/`, tested, and the single authority both the UI and the engine call (`validatePlacement` / `legalPlacementHexes` / `validateSetup` in `src/sim/setup.ts`, build-order step 7).

**The placement order is enforced, not merely suggested** (ruled 2026-08-11, step 7). A decoy submitted before the bunker, or a base before both sites, is rejected — the exclusion rule is measured against both sites, so a base placed first could not be checked against anything.

**Validation never consults the opponent's placements**, and cannot need to: the two home zones are disjoint row bands (§7), so the two players' setups can never collide. That is also what keeps it safe. A validator that read the enemy's setup would turn the legal-hex highlight into a third detector (§11) — the enemy's secret placement would show up as a hole in your own overlay.

**`startMatch(map, setups)` is the `SETUP -> ORDER_PHASE` edge of §5's state machine**: it re-validates both setups, throws rather than start a match on an illegal board, and returns the round-1 state with all 16 units — 3 launchers and a drone per side on the public spawn hexes, plus the 4 placed assets. Unit array order is canonical, because events naming a unit are emitted in `GameState.units` order (§9).

**Why the exclusion rule exists:** without it, both bases sit on top of the bunker, the drone dies before it can ever see it, and missiles can't reach it — an unfindable, unkillable turtle. The rule forces the bunker to be defended by *concealment and geography*, never by walls.

### The indistinguishability principle (binding on every layer)

**Every rule that applies to the bunker applies identically to the decoy, with exactly one exception: hit points.** Same home zone, same terrain and spawn constraints, same interceptor exclusion, same permanent-detection behaviour (§11), same appearance in enemy intel and events.

The terrain rule is the newest test of this and the easiest to get wrong: `RULES.placementTerrain.bunker` and `RULES.placementTerrain.decoy` must stay identical lists, because if the decoy could not be built where the bunker could, every site found on that terrain would be provably real. `defs.test.ts` asserts the two are equal, so a balance pass cannot break it by editing one row and forgetting the other.

This is not stylistic. Any asymmetry becomes a *rules-derived tell* — a way for the attacker to identify the real bunker by reasoning about the rulebook instead of by spending a missile. If the exclusion rule covered only the real bunker, then "the site inside interceptor coverage" would be provably the fake, and the decoy would be worthless the instant both were spotted. When adding any future rule that mentions the bunker, ask whether it must also mention the decoy; the default answer is yes.

**How the bluff resolves (intended, do not "fix"):** the attacker finds a site, fires one missile, and reads the result. A public `UNIT_DESTROYED` means it was the decoy. Silence — no destruction, no dead hand — means the missile hit the real bunker for 1 of its 2, because only the real bunker can absorb a hit (§6). So one missile buys certainty. The cost of that missile is the real price: a launcher that spends its round firing cannot move, its origin hex becomes public, and it must be within range 6 of the target — deep in enemy ground. Testing a decoy is cheap in munitions and expensive in exposure, which is the trade the whole game is built on.

**Design notes:**

- *A mountain site trades one kind of safety for another.* Because no launcher can be ordered onto a mountain, a site there can never be found by ground probing — the trick where you drive a launcher at a suspected hex and read the failed move (§9) simply cannot be aimed at it. But terrain is public, so mountains in a home zone are a short, publicly-known list of candidate hexes, and an opponent who suspects you favour them can point recon straight at them. Neither choice dominates, which is the point: it is a read on your opponent, not a solved optimum. **Both the bunker and the decoy get this option** — if only one did, the terrain itself would identify the real one for free (see the principle below).
- *Placing the two sites far apart is usually stronger.* One drone swath is 3 hexes wide, so adjacent sites are found together, and destroying the fake immediately hands the attacker the real one's location. Sites in different corners must each be found separately. This is left to player judgment rather than enforced by a minimum-distance rule — fewer rules, and the incentive already points the right way.
- *Locating interceptor bases narrows the bunker hunt.* Because bases must sit ≥3 from both sites, an attacker who locates both bases can rule out every hex within 2 of either. Defense-finding is therefore also leader-finding — but **by inference, not by photograph** (decided 2026-08-11, §11): at the shipped radii a drone dies one hex before it could picture a base, so what the attacker gets is a 7-candidate clue from `DRONE_DOWNED` or `MISSILE_INTERCEPTED`. That makes the clue itself the second use for drone intel: a drone lost over enemy ground is not a wasted round, it is a bearing on a base and therefore a shadow on the bunker.
- *Tuning lever if the bluff proves too cheap in playtest:* raise the decoy to 2 HP. It then becomes fully symmetric with the real bunker and is distinguishable only by the absence of dead hand when it dies — a longer, more expensive bluff. V1 ships at 1 HP deliberately, for a faster resolution.

There is no placement of launchers or the drone; asymmetric openings come from secret bunker/decoy/base placement plus rotationally symmetric terrain.

---

## Resolved-by-pivot ledger

For the record, the pivot resolved every open design question from the pre-pivot spec: damage model (hits-based: 1/1/2, no variance), non-leader HP (1), `MISSILE_DEFS` (moot — one missile type, stats in RULES), event-log visibility (§6 table), starting positions (§7/§12), starting defense counts (2 bases), and intra-round move-vs-impact ordering (§3: strikes first). Newly accepted rough edges, on purpose: the §10 unit-id tiebreak is arbitrary-but-deterministic, and all §7 numbers are untested first drafts.

**Amendment, same day — decoy bunker added to V1.** One decoy per player, 1 HP, placed secretly alongside the real bunker and rule-identical to it in every observable way (§12). It was in the original pre-pivot vision, deferred to V2, and is now back in V1 scope because the pivot's simplifications left room for it and it restores the bluff layer to the leader hunt. Its cost to build is small: one unit kind, one placement step, one mask in the visibility filter. The V1 asset count per player goes 7 → 8.

**Amendment, 2026-08-11 — terrain simplified to two types; static structures may be built on mountains.** Urban terrain is **cut**: it was "visual flavour only in V1", carried no rule, and cost a case in every terrain switch (its V2 regime-score role is noted in `docs/v2-backlog.md`). Mountains go from ~14% scattered singletons to **15% grown as ranges**, which makes them terrain that shapes an advance rather than decoration — and because ridges, unlike noise, can wall a board off, `generateMap` now validates every map it produces (coverage band, spawn connectivity, approach cost) and re-rolls rather than shipping or patching one (§7). The placement rule changed with it: **bunker, decoy and interceptor base may be built on mountains**, launchers and drones still spawn and move on plains only. "Mobile things need plains, built things do not." The consequence worth naming is that a mountain site is immune to ground probing (§11) but sits in a small, publicly-known set of candidate hexes — and that the option must belong to the bunker and the decoy identically, or terrain becomes a rules-derived tell (§12).

**Amendment, 2026-08-11 — detection rules clarified, "fog of war" retired as a term.** §11 is now a flat four-rule detection system (map public; only recon and launch detection reveal enemy assets; mobile sightings last one round, static sightings are permanent; nothing distinguishes bunker from decoy), and the old permanent "last seen (hex, round N)" launcher ghost markers are **cut** — a detected launch site expires after one order phase because the launcher can relocate. The permanent record moves to the event log, which keeps every detected launch for the whole match (§6). Architecture layer 2 is now called the **visibility filter** throughout; "fog"/"fog of war" is no longer used anywhere in the design.

**Amendment, 2026-08-11 — §6 and §11 gain the rulings the recon phase forced into the open (build-order step 5).** Implementing the drone surfaced six questions the spec never answered, none of which changed an existing rule or number. (1) **A hovering drone still watches** — no order, a rejected order and an over-budget order all resolve as a zero-length flight that transmits its own hex's corridor, which is what makes "give no order to hover" a choice instead of a wasted round. (2) **A rejected FLY is silent** — every way a FLY can fail is derivable from what the ordering player already knows, so there is no air-layer `MOVE_FAILED`. (3) **`DRONE_MOVED` fires every round including hovers, and its `path` is what the drone *transmitted*** — on a downed flight it stops one hex short of the kill, so a client drawing the corridor from `path` is right without knowing the rule. (4) **"Reveals nothing from its death hex" means the death hex contributes no corridor** — the hex itself is still photographed from one hex back; what is lost is everything beyond it. (5) **A re-sighted static asset keeps its first-seen round** but still emits `ASSET_SPOTTED`, because the log records observations rather than deltas. (6) **The drone's only death event is `DRONE_DOWNED`**, never also `UNIT_DESTROYED`; the same unit and id are revived at the spawn hex, since no detector ever reports an enemy drone.

One **defect in the code, not the spec**, was found and fixed by the same session: `occupiedHexes` in `movement.ts` blocked on every living unit including drones, contradicting §9's "the drone neither blocks nor is blocked." It was invisible while drones sat on their spawn hexes; from step 5 on it would have made a parked drone a third detector — park it on a hex, watch an enemy advance fail, and you have found a unit no rule says you may see.

The same session found one thing that **is** a design problem and is deliberately left undecided: at the shipped radii recon can never photograph an interceptor base. See the OPEN QUESTION in §11.

**Amendment, 2026-08-11 — every owner-only event now carries `owner` (found by a project audit, before build-order step 8).** The §6 visibility table assigns five events to their owner alone — `UNIT_MOVED`, `MOVE_FAILED`, `BUNKER_HIT`, `DRONE_MOVED`, `DRONE_RESPAWNED` — but each carried only a `unitId`, and `filterEventsForPlayer(events, playerId)` receives no `GameState` to look that id up in. The filter therefore could not have routed them: it would have had to drop them for both players or show them to both, and both are wrong. Since `UnitId` is deliberately opaque (nothing may derive meaning from it — the same rule that governs missile ids), the audience is now stated on the event, matching what `DRONE_DOWNED` already did. No rule, number or audience changed; the events only became self-describing. `resolve.test.ts` pins it with a both-sides check, so an event added later without `owner` fails rather than reaching the filter unroutable. Noted at the same time and left alone: `ASSET_SPOTTED.owner` is the *spotted* asset's side, so its audience is that player's opponent — the only event where `owner` is not the recipient.

**Amendment, 2026-08-11 — §10's missile tiebreak changed, and §6/§10/§11 gain the rulings the launch phases forced into the open (build-order step 6).** One rule genuinely changed: **the simultaneous-missile tiebreak is now the origin hex, not the firing launcher's unit id** (§10). The old wording was deterministic but publicly observable, and unit ids are not supposed to be — the log's order would have handed the defender an ordering of enemy launcher ids, which is the cross-round trackable identity §11 keys all intel by hex to prevent and §6 already forbids in missile ids. Bases keep their id tiebreak, for the reasons given in §10. Six rulings were added without changing any rule or number: (1) **a rejected LAUNCH is silent**, like a rejected FLY — every rejection is derivable from public or own-side information, so nothing hidden can have caused it (§10). (2) **The log is grouped by phase and canonically ordered inside each phase** — launches by origin hex, interceptions chronologically by flight step, unit-naming events in `GameState.units` order, and every `IMPACT` before any damage event (§6). (3) **`BUNKER_HIT` is written as "a non-lethal hit on a bunker *or decoy*"**, which changes nothing at 1 HP (the decoy always dies to the hit) but keeps §12's 2 HP tuning lever indistinguishable by construction. (4) **Impact touches ground assets only** — a drone over the target hex is untouched, and a destroyed unit takes no second hit (§3). (5) **`UNIT_DESTROYED` clears that hex from the enemy's map**, both permanent static reveals and a same-round launcher contact; the kill stays in the log forever (§11). (6) **A launcher caught by both detectors in one round is one hex-keyed contact**, first source kept — they cannot disagree, because a launcher that fired cannot also have moved (§11). Also settled the same session: the §11 open question — **the recon and coverage radii stay at 1, so bases are inferred, never photographed.**

**Amendment, 2026-08-11 — §9 gains three rulings `resolve()` forced into the open (build-order step 4).** Implementing the movement phase surfaced three questions the section never answered. (1) **A unit given more than one order does nothing** — counted across all order kinds, so move-XOR-launch is enforced by the budget itself; the engine never guesses which order was meant, because guessing would make the result depend on the client's array order. (2) **Only `TILE_OCCUPIED` and `OUT_OF_RANGE` emit `MOVE_FAILED`** — the two failures hidden information can cause. The rest are dropped silently, forced by the fact that answering an order which named an enemy unit would leak that unit's id into the sender's log. (3) **Events are emitted in `GameState.units` order**, not order-array order, so the same physical outcome always yields the same log. No numbers changed and no existing ruling was altered — §9's five-row table survived implementation intact, and three of its five rulings needed no code at all, falling out of validating every move against the start-of-phase snapshot.

**Amendment, 2026-08-11 — §3/§4/§5 gain the rulings the outcome check and the dead-hand round forced into the open (build-order step 7).** One rule was genuinely generalised: **any phase-4 verdict stops the round**, not just a dead-hand trigger — phase 5 and the respawn tick are skipped whenever the match ends or a final round is owed (§3). It changes no outcome, because movement cannot affect a §4 condition; it keeps the event log from showing units moving after `GAME_OVER`, and it makes the round that decapitates a player a round in which nobody moves. Six rulings were added without changing any rule or number: (1) **a decapitated player with no launchers gets no final round** — it could not change the adjudication and would be an empty hotseat handoff, so the match ends immediately with no `DEAD_HAND_TRIGGERED` (§3). (2) **The dead-hand round carries its own round number**, which is what keeps per-round missile ids unique in a permanent log (§3, §6). (3) **Absence is not destruction** — only units that exist and are flagged destroyed satisfy a §4 condition (§4). (4) **Capitulation is never derived from the board**; `resolve()` cannot return it (§4). (5) **`resolve()` is the single entry point for both kinds of round and throws on a finished or unstarted match**, and `RESOLUTION`/`FINAL_RESOLUTION` are presentation states the engine never rests in (§5). (6) **Placement order is enforced, and placement validation never consults the opponent's setup** — it cannot need to, since the home zones are disjoint, and a validator that did would make the legal-hex overlay a detector (§12). `startMatch` was added as the `SETUP -> ORDER_PHASE` edge (§12).
