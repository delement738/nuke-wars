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

**Terrain:** **Plains** (normal), **Mountains** (impassable to launchers; missiles and drones fly over freely), **Urban** (visual flavor only in V1).

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
3. **Impact.** Surviving missiles strike their target hexes simultaneously. Direct hit only — **no splash damage to neighboring hexes.** Whatever ground asset occupies the hex takes the hit, friendly or enemy. Launchers, interceptor bases, and decoy bunkers die to 1 hit; the real bunker takes 1 of its 2. **Hits stack within a round:** two missiles landing on the same full-health bunker in one round destroy it outright — a 2-missile alpha strike is a legitimate way to skip the decoy test (§12), at the price of wasting a missile if the target turns out to be the fake.
4. **Outcome check.** Win/draw conditions are evaluated (§4). If a **real** bunker was just destroyed, dead hand triggers and phase 5 is skipped. Destroying a decoy never triggers anything.
5. **Ground movement.** Launcher moves resolve per §9.

**Phase-order consequences (intentional design, not accidents):**

- **Strikes land before movement**, so a launcher that fired last round (revealed origin, stationary) and is in enemy missile range **cannot escape a counter-battery strike this round** — the missile arrives before its move resolves. Firing is a hard commitment. The safe way to fire is from inside your own interceptor coverage or outside enemy reach.
- **Two launchers that fire at each other's positions in the same round both die** (both missiles are in flight simultaneously). This needs no special rule — it falls out of phase order.
- **Recon flies first**, so the drone photographs enemy launchers at their *pre-move* positions. Under the single commit window, drone intel can never influence launches committed the same round — it pays off next round. (A two-stage commit was considered and rejected for V1: it doubles the hotseat handoffs and the order-phase machinery.)

### Dead hand

When a player's real bunker is destroyed, they get one final round: every surviving launcher they own may fire one missile (normal range 6 from its current hex).

**The dead-hand round is launches only.** The only legal order is LAUNCH; no ground movement and no drone flight happen, so the round runs resolution phases 2 → 3 (launch & interception, then impact) and then adjudicates. There is no phase 1 and no phase 5. The opponent issues no orders at all, but their interceptor bases defend normally (1 intercept per base). Then the game ends and §4 adjudicates.

If both real bunkers die in the same impact phase, skip dead hand — it is already Mutual Annihilation.

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

Victory conditions are evaluated only after a full resolution completes — never mid-resolution.

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
| `BUNKER_HIT` (non-lethal bunker damage) | **Owner only.** To the attacker, a non-lethal bunker hit is indistinguishable from hitting empty ground — this preserves "only drones find bunkers" against blind-fire probing. Decoys never emit it (they die to the hit that would cause it), so *silence after a hit* is exactly what identifies the real bunker |
| `DRONE_DOWNED` (hex) | **Both** (the defender knows their own base locations, so this leaks nothing to them; the owner learns only the death hex — the killing base is somewhere within 1, i.e. 7 candidates) |
| `DRONE_MOVED`, `ASSET_SPOTTED` (recon results) | **Spotting player only.** A spotted decoy is reported with `kind: 'bunker'` — the visibility filter applies the mask, so `resolve()` never lies and the sim stays honest internally (§11) |
| `DRONE_RESPAWNED` (unitId, hex) | **Owner only.** The enemy learning your recon is back online would be free intel they did nothing to earn. The spawn hex is public knowledge anyway (§12) — what is private is the *timing* |
| `UNIT_MOVED`, `MOVE_FAILED` | **Owner only** (`MOVE_FAILED` carries only the mover's unit id, §9) |
| `DEAD_HAND_TRIGGERED`, `GAME_OVER` | **Both** |

**Missile ids carry no information.** `LAUNCH_DETECTED`, `MISSILE_INTERCEPTED`, and `IMPACT` share a per-round missile id so the client can tell which missile an event belongs to and animate from the log rather than guess. It is derived from public data only — the round number plus the origin hex, which `LAUNCH_DETECTED` already publishes to both players — so it leaks nothing about the firing launcher's identity. A launcher fires at most one missile per round and no two launchers share a hex, so it is unique. Never derive it from a unit id: that would hand the enemy a trackable identity, which §11 deliberately withholds.

**Data-table rule:** unit/terrain stats and rule numbers live in plain data objects keyed by string IDs in `src/sim/defs.ts`, never hardcoded in logic. Balance patches = edited numbers, a one-file diff.

---

## 7. First-Draft Numbers (tune in playtest)

| Parameter | Value |
|---|---|
| Map size | 19 wide x 15 tall, mirrored |
| Orders | 1 per living asset per round (no global cap — with 3 launchers + 1 drone, 4 is the natural maximum) |
| Round cap | 25 |
| Launchers | 3 per player, 1 HP, move 3 hexes/round OR launch |
| Missile | range 6, direct hit only, kills 1-HP assets, bunker takes 2 hits |
| Interceptor bases | 2 per player, 1 HP, coverage radius 1, max 1 missile intercept per round each; drone kills are free |
| Recon drone | 1 per player, 6 hexes/round straight-line, reveal swath = path + neighbors (3 wide) |
| Drone respawn | 1 full blind round, then respawns at the drone spawn hex |
| Launcher sighting (recon or detected launch) | Visible for **1 round** — the next order phase only (§11) |
| Static sighting (bunker, decoy, interceptor base) | **Permanent**, until the asset is publicly destroyed (§11) |
| Bunker | 1 per player, 2 direct hits |
| Decoy bunker | 1 per player, 1 direct hit, no effect on any win condition |
| Interceptor placement exclusion | ≥ 3 hexes from **both** your bunker and your decoy (identical rule for both — §12) |
| Home zones (placement + spawns) | P1 columns 0–5, P2 columns 13–18 (offset coords) |
| Fixed spawns P1 | launchers (2,3), (2,7), (2,11); drone (1,7) — P2 mirrored: (16,3), (16,7), (16,11); drone (17,7) |
| Match length target | 10–20 minutes |

**Tuning intuition:** launcher speed 3 vs missile range 6 vs map width 19 gives ~2 rounds of maneuver before first exchanges are possible, and the drone reaches the enemy home zone on round 2 — first blood around round 3 without any grace-period rule. The pre-pivot grace rules (no launches round 1, leader untargetable rounds 1–3) were **cut as redundant: starting geometry enforces them.** If spawn positions or ranges change, re-check that this stays true.

---

## 8. Build Order (one focused session each)

**V1 — hotseat**
1. [DONE] Hex map render (Pixi): mirrored terrain, pan/zoom, hover/select.
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

**Reporting a failed move.** A failed or standoff move emits exactly one event, `MOVE_FAILED`, carrying only the mover's own unit id — no destination, no blocker, no reason code. Standoffs and blocked advances are byte-identical, so the player cannot distinguish "an enemy was parked there" from "an enemy raced me for that hex." The event carries no enemy-derived data, so it is leak-proof by construction. Surface it as flavour ("your advance met resistance") without naming a hex or unit.

**Information leak (intentional):** a player whose move fails learns an enemy ground unit is adjacent-ish to that path. Making contact is genuine intelligence, and it is the defender's reward for positioning well. It is *not* a detection: nothing appears on the map (§11).

---

## 10. Flight Paths & Interception

One geometric primitive powers both missiles and drone flight: **`hexLine(a, b)`** — the straight hex line from `a` to `b`, computed by cube-coordinate lerp + rounding (redblobgames method). Lines that graze exactly between two hexes are broken deterministically by nudging the interpolation with the fixed epsilon offsets **(+1e-6, +2e-6)** applied to `a`'s cube coordinates. These constants are part of the spec: every layer (sim, UI preview, server) must produce the identical path.

**Missile flight:** the missile traverses `hexLine(origin, target)`, checked for interception on every hex *after* the origin, including the target hex itself.

**Interception mechanics (phase 2):**

- A base covers its hex + 6 neighbors and may destroy **at most 1 enemy missile per round**. Friendly missiles and the owner's own drone are never engaged.
- All missiles fly simultaneously, advancing step-by-step along their paths. At each step, any missile entering a covered hex of an enemy base with capacity remaining is destroyed and that base's capacity for the round is spent. A missile crossing several coverage zones can be engaged by whichever base still has capacity when it enters.
- **Ties** (two missiles entering coverage at the same step, or one missile entering two bases' coverage at once): resolve in ascending unit-id order (missiles by their launcher's id, bases by base id). This is an accepted arbitrary-but-deterministic tiebreak, not a balance lever.
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
4. **No detection ever tells the real bunker from the decoy.** Both enter your map as a *bunker site* and stay labelled that way until a missile proves otherwise (§12).

Everything below is detail on those four rules.

### The two detectors

| Detector | Fires in | What it puts on your map | For how long |
|---|---|---|---|
| **Recon drone swath** | Phase 1 | Every enemy asset in the swath — launchers, interceptor bases, and bunker/decoy sites | Launchers: 1 round. Static assets: permanent |
| **Launch detection** | Phase 2 | The origin hex of every enemy missile fired this round (`LAUNCH_DETECTED`, §6). Automatic and unavoidable — launches are loud; no equipment is needed to detect one and nothing can suppress it | 1 round — a launcher can relocate next round, so the marker expires with it |

A launch origin is a *launcher* sighting, so it follows the mobile rule. The `LAUNCH_DETECTED` event stays in your log permanently (below); the map marker does not.

### Exactly when a one-round sighting is visible

**A detection made during round N's resolution is on your map for the whole of round N+1's order phase, and is cleared when round N+1 resolves.** You get exactly one order phase to act on it. Two consequences the design leans on:

- **A recon sighting can already be stale when you get it.** Recon flies in phase 1 and launchers move in phase 5 of the *same* round, so the launcher you photographed may have driven off before you ever issue an order. Shooting at a recon contact is a bet.
- **A launch origin cannot be stale.** A launcher that fires cannot also move (one order per unit, §9), so it is still sitting on the origin hex when the round ends, and your counter-battery missile lands in phase 3 — before it can move in phase 5 (§3). A detected launch is therefore a live target for exactly one round, which is what makes firing a hard commitment.

### What does *not* detect anything

These are public events (§6). They report that something happened at a hex; they never place an enemy asset on your map.

- **`IMPACT`** — emitted for every missile arrival, including hits on empty ground, precisely so its presence leaks nothing about occupancy.
- **`MISSILE_INTERCEPTED`** — tells you an enemy base covers that hex, i.e. the base is one of 7 candidates. That is an inference you draw, not a reveal; the base is not marked until recon actually sees it.
- **`DRONE_DOWNED`** — same shape of clue, same 7 candidates.
- **`MOVE_FAILED`** — you learn only that *your own* move was blocked, with no hex, no blocker, and no reason (§9).
- **Drones are never detectable at all.** No swath and no event ever reveals an enemy drone to you; drones do not reveal each other (§2). The only thing that touches an enemy drone is interceptor coverage, which kills it.

### The event log is permanent history, not live intel

Each player keeps an **append-only log of every event they were allowed to see** (§6), for the whole match — it is also the replay format. So the full record of **every launch you have detected**, with its round, origin hex and target hex, stays readable for the rest of the game.

The log and the map say different things on purpose:

- **The log** answers *"where have they fired from before?"* — pattern, tempo, which corner of the board they operate in.
- **The map** answers *"where is an enemy launcher right now?"* — and only for the one round a sighting is good for.

A launch logged in round 4 is a record of where a launcher *was* in round 4. By round 6 that launcher could be anywhere within 6 hexes of it. Reading the history is free; acting on it is a guess.

### Recon drone mechanics

**Drone flight order:** destination hex within 6; the drone flies `hexLine(current, destination)`. The player steers by choosing sweep lines, not by drawing paths (free-path waypoint orders are V2 — this keeps the order UI trivial and reuses §10's primitive). Ordering the drone to its own hex is illegal (give no order to hover). Hovering is safe: coverage kills on *entry* only.

**Reveal swath:** for every hex the drone safely traverses this round (including its start hex, including the destination), the hex and its 6 neighbors are revealed — a 3-wide corridor. **A drone that is shot down reveals nothing from its death hex** — it is destroyed before transmitting. Its owner learns only the death hex (`DRONE_DOWNED`), leaving 7 candidate hexes for the killing base. Intel transmitted from earlier hexes in the same flight is kept (live transmission, not recovered-wreckage).

**A spotted decoy is reported to the enemy as a bunker.** The sim always stores and emits the truth (`kind: 'decoy'`); the visibility filter applies the mask on the way out, and is the only layer permitted to know the difference (§6, §12).

**Drone loss & respawn:** when your drone is shot down you play the **next full round with no drone**. "Blind" means *no drone only*: launch detection still works, and your permanent static reveals are all kept (one-round launcher sightings still expire on the normal schedule — nothing preserves them). The round after that, a fresh drone spawns at your fixed drone spawn hex at the start of the order phase. Respawns are unlimited: recon can be taxed and delayed, never permanently denied.

**Terrain is public.** Both players see the whole map from the start — it is mirrored and symmetric, so hiding it would achieve nothing. Hidden information covers *assets only*, never tiles. The visibility filter must never strip or mask `MapData`.

### Why launcher sightings expire (design note — do not "fix" this)

An earlier draft kept permanent "last seen (hex, round N)" ghost markers. They were cut because a stale marker *looks* like knowledge: the map fills with contacts that are mostly wrong, and the player either learns to ignore all of them or gets punished for trusting one. Under the current rule the map only ever shows things that are true right now — a launcher marker means "it was there at the start of this round," a static marker means "it is there, full stop." Nothing is lost, because the event log keeps the whole history; it is just presented as history instead of as a target.

**The intel race is the game clock:** the defender cannot point-defend the bunker (placement rule, §12) — only delay its discovery by killing drones, taxing time, and spending the attacker's shots on the decoy. Finding a "bunker" is therefore not the end of the hunt: the attacker must still spend a missile to learn whether it is real (§12). Once the *real* bunker is confirmed, its survival is measured in the rounds it takes to land 2 hits through the remaining interceptor lanes. Endgames are sharp by design.

---

## 12. Setup & Placement

**Fixed spawns (public knowledge, forced to plains by map generation):** each player's 3 launchers and drone spawn at the §7 coordinates. Map generation must guarantee these 8 hexes are plains; placement may never use a spawn hex.

**Secret placement (SETUP phase, hotseat: P1 places while P2 looks away, then swap):** each player places, in order:

1. **Bunker** — any passable, non-spawn hex in their home zone (columns 0–5 / 13–18).
2. **Decoy bunker** — the same constraints as the bunker, on a different hex. No minimum or maximum distance from the real bunker (see the design note below).
3. **2 Interceptor bases** — any passable, non-spawn, unoccupied hexes in their home zone, each **at least 3 hexes from both their own bunker and their own decoy** (so both sites and their neighbors sit outside all friendly coverage — no point-blank shield; defending approach *lanes* at a distance is legal and is the intended skill).

Each step validates against the rules above, and the UI must offer only legal hexes. A 6×15 home zone is far larger than two radius-2 exclusion zones, so no bunker/decoy pair can box a player out of legal base positions — but placement validation is still a pure function in `src/sim/`, tested, and the single authority both the UI and the engine call.

**Why the exclusion rule exists:** without it, both bases sit on top of the bunker, the drone dies before it can ever see it, and missiles can't reach it — an unfindable, unkillable turtle. The rule forces the bunker to be defended by *concealment and geography*, never by walls.

### The indistinguishability principle (binding on every layer)

**Every rule that applies to the bunker applies identically to the decoy, with exactly one exception: hit points.** Same home zone, same terrain and spawn constraints, same interceptor exclusion, same permanent-detection behaviour (§11), same appearance in enemy intel and events.

This is not stylistic. Any asymmetry becomes a *rules-derived tell* — a way for the attacker to identify the real bunker by reasoning about the rulebook instead of by spending a missile. If the exclusion rule covered only the real bunker, then "the site inside interceptor coverage" would be provably the fake, and the decoy would be worthless the instant both were spotted. When adding any future rule that mentions the bunker, ask whether it must also mention the decoy; the default answer is yes.

**How the bluff resolves (intended, do not "fix"):** the attacker finds a site, fires one missile, and reads the result. A public `UNIT_DESTROYED` means it was the decoy. Silence — no destruction, no dead hand — means the missile hit the real bunker for 1 of its 2, because only the real bunker can absorb a hit (§6). So one missile buys certainty. The cost of that missile is the real price: a launcher that spends its round firing cannot move, its origin hex becomes public, and it must be within range 6 of the target — deep in enemy ground. Testing a decoy is cheap in munitions and expensive in exposure, which is the trade the whole game is built on.

**Design notes:**

- *Placing the two sites far apart is usually stronger.* One drone swath is 3 hexes wide, so adjacent sites are found together, and destroying the fake immediately hands the attacker the real one's location. Sites in different corners must each be found separately. This is left to player judgment rather than enforced by a minimum-distance rule — fewer rules, and the incentive already points the right way.
- *Finding interceptor bases narrows the bunker hunt.* Because bases must sit ≥3 from both sites, an attacker who spots both bases can rule out every hex within 2 of either. Recon that finds defenses is therefore also recon that finds the leader — a genuine second use for drone intel.
- *Tuning lever if the bluff proves too cheap in playtest:* raise the decoy to 2 HP. It then becomes fully symmetric with the real bunker and is distinguishable only by the absence of dead hand when it dies — a longer, more expensive bluff. V1 ships at 1 HP deliberately, for a faster resolution.

There is no placement of launchers or the drone; asymmetric openings come from secret bunker/decoy/base placement plus mirrored terrain.

---

## Resolved-by-pivot ledger

For the record, the pivot resolved every open design question from the pre-pivot spec: damage model (hits-based: 1/1/2, no variance), non-leader HP (1), `MISSILE_DEFS` (moot — one missile type, stats in RULES), event-log visibility (§6 table), starting positions (§7/§12), starting defense counts (2 bases), and intra-round move-vs-impact ordering (§3: strikes first). Newly accepted rough edges, on purpose: the §10 unit-id tiebreak is arbitrary-but-deterministic, and all §7 numbers are untested first drafts.

**Amendment, same day — decoy bunker added to V1.** One decoy per player, 1 HP, placed secretly alongside the real bunker and rule-identical to it in every observable way (§12). It was in the original pre-pivot vision, deferred to V2, and is now back in V1 scope because the pivot's simplifications left room for it and it restores the bluff layer to the leader hunt. Its cost to build is small: one unit kind, one placement step, one mask in the visibility filter. The V1 asset count per player goes 7 → 8.

**Amendment, 2026-08-11 — detection rules clarified, "fog of war" retired as a term.** §11 is now a flat four-rule detection system (map public; only recon and launch detection reveal enemy assets; mobile sightings last one round, static sightings are permanent; nothing distinguishes bunker from decoy), and the old permanent "last seen (hex, round N)" launcher ghost markers are **cut** — a detected launch site expires after one order phase because the launcher can relocate. The permanent record moves to the event log, which keeps every detected launch for the whole match (§6). Architecture layer 2 is now called the **visibility filter** throughout; "fog"/"fog of war" is no longer used anywhere in the design.
