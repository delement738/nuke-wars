# NUKE WARS — V1 Design Specification (Lean)

*A 1v1 strategic command-and-control duel. Simultaneous hidden orders, hex-grid maneuver, finite defenses, and a decapitation endgame.*

**Design pillar (judge every feature against this):** the core loop is **Commit → Dread → Reveal**. Players commit orders without knowing the enemy's; resolution is simultaneous and dramatic. Moving into striking range is itself the act of exposure.

**Milestones:** **V1 = hotseat (two players, one screen), playable and fun.** **V1.5 = networked 1v1 with countdown timer.** Everything else is V2+.

---

## 1. Objective

Destroy the enemy regime before yours falls. Two paths:

1. **Decapitation** — find and destroy the enemy Leader's bunker, then survive their final retaliation.
2. **Disarmament** — destroy all enemy offensive capability (launchers + missiles).

The Leader is a hidden piece. Finding theirs while protecting yours is the mid-game.

---

## 2. V1 Scope

### Included

| System | V1 version |
|---|---|
| Map | Hex grid, mirrored generation. Terrain: **Plains** (normal), **Mountains** (impassable), **Urban** (visual flavor only in V1) |
| Offensive units | **Mobile Launcher (TEL)** — moves, fires SRM or MRM |
| Missiles | **SRM** (short range, cheap, harder to intercept), **MRM** (longer range, more damage, easier to intercept) |
| Defensive assets | **Radar station** (fixed, simple detection radius — no line-of-sight rules), **Interceptor battery** (fixed, finite ammo, defends a radius) |
| Recon | **Recon sweep** — limited-use order: reveal a small hex area for 1 round. The only way to search enemy territory |
| Leader | Hidden, **static**, in a bunker requiring 2 penetrating hits. Untargetable rounds 1–3 |
| Turn structure | Simultaneous order phases. **V1: untimed hotseat.** V1.5 adds the 75s countdown |
| Chance model | Interception: each interceptor committed adds fixed % (cap 90%), one roll per inbound. Damage: 85–115% variance |
| Reveal rule | Any launch reveals its origin hex to the opponent |
| Fog of war | Binary visibility inside radar/recon coverage. Out-of-coverage enemies show as static "last seen round N" markers |
| Starting positions | **Fixed and symmetric** — no placement phase |

### Deferred to V2+
Setup/placement phase, Leader relocation + convoy signatures, decoy Leader site, recon-ping notifications, radar line-of-sight and mountain shadows, fog decay/confidence levels, urban-hex scoring and attrition adjudication, post-match fog-lifted replay, long-range/stealth/cruise missiles, saturation decoys, EMP/jammers, doctrines, escalation clock, 3+ player modes, accounts/matchmaking/ranked ladder, spectator mode.

**Roster discipline:** V1 = 1 mobile unit, 2 missile types, 2 fixed defenses, 1 recon order, 1 leader. Depth comes from interactions (interceptor economy x fog x range exposure), not roster size.

---

## 3. Gameplay Flow

1. **Start:** fixed symmetric deployment, both sides out of range of each other.
2. **Order phases (repeating):** each player queues up to 4 orders (move launcher, launch SRM/MRM, recon sweep) -> both confirm -> simultaneous resolution -> animated reveal sequence (launches detected -> intercept attempts -> impacts) -> next round. Movement conflicts during simultaneous resolution are governed by **§9**.
3. **Grace rules:** Leader untargetable rounds 1–3. No launches on round 1.
4. **Endgame:** Leader bunker destroyed -> **DEAD HAND**: the decapitated player gets one final round to manually launch everything surviving. Then final adjudication.

---

## 4. Outcomes (checked after full round resolution, in priority order)

| # | Outcome | Condition |
|---|---|---|
| 1 | **Victory by Decapitation** | Enemy Leader dead, your Leader survives the dead-hand round |
| 2 | **Victory by Disarmament** | Enemy has zero launchers and zero missiles |
| 3 | **Victory by Capitulation** | Opponent resigns |
| 4 | **Draw — Mutual Annihilation** | Both Leaders dead (same round, or via dead-hand retaliation) |
| 5 | **Draw — Armistice** | Round cap (30) reached with no victory |

Target match length: **15–25 minutes.**

---

## 5. Game State Machine

```
SETUP -> ORDER_PHASE <-> RESOLUTION -> (check outcomes)
                            |
                   leader killed?
                            v
              DEAD_HAND_PHASE -> FINAL_RESOLUTION -> GAME_OVER
```

Victory conditions are evaluated only after a full resolution completes — never mid-resolution.

---

## 6. Technical Architecture

**Stack:** TypeScript. PixiJS (map/units/effects) + React (HUD/menus) + Zustand (client state). Hex math is hand-rolled in `src/sim/hex.ts` (axial coordinates), keeping the sim engine dependency-free. V1.5 adds Node.js + WebSockets.

**Four layers, strictly separated:**

1. **Simulation engine** — pure TypeScript, zero React/Pixi/network imports. One pure function: `resolve(state, ordersP1, ordersP2, seed) -> newState + eventLog`. Fully unit-tested. In V1.5 this runs server-side and authoritative, unchanged.
2. **Fog filter** — pure function `filterForPlayer(state, playerId) -> visibleState`. In hotseat it hides the inactive player's info; in V1.5 the server applies it before sending state, making cheating impossible by construction.
3. **Presentation** — Pixi + React. Reads visible state, renders, builds pending orders. Never mutates game state.
4. **Network (V1.5)** — rooms, order collection window, countdown enforcement, reconnect, per-player broadcast.

**Determinism rule:** simulation takes an explicit RNG seed; identical (state, orders, seed) always yields identical results. Enables reproducible bugs, cheap replays, and automated balance testing.

**Event log rule:** `resolve()` emits an ordered event list (LAUNCH_DETECTED, INTERCEPT_ATTEMPT, IMPACT, LEADER_KILLED...). Clients animate from events, never by diffing state. This is also the future replay format.

**Data-table rule:** unit/missile/terrain stats live in plain data objects keyed by string IDs (`MISSILE_DEFS` etc.), never hardcoded in logic. V2 content = new rows; balance patches = edited numbers.

---

## 7. First-Draft Numbers (tune in playtest)

| Parameter | Value |
|---|---|
| Map size | ~19 wide x 15 tall, mirrored |
| Orders per round | 4 |
| Round cap | 30 |
| Starting launchers | 4 per player |
| Starting missiles | 6 SRM + 4 MRM per player |
| SRM | range 5, damage 2, 35% intercept chance per interceptor |
| MRM | range 9, damage 4, 50% intercept chance per interceptor |
| Interceptor stacking | additive, capped at 90% |
| Interceptor battery | 4 ammo, defends radius 3 |
| Radar station | detection radius 6 |
| Launcher movement | 2 hexes/round |
| Recon sweeps | 5 per match, radius 2, lasts 1 round |
| Leader bunker | 2 penetrating hits |
| Damage variance | 85–115% |
| Order phase timer (V1.5) | 75 seconds |

---

## 8. Build Order (one focused session each)

**V1 — hotseat**
1. [DONE] Hex map render (Pixi): mirrored terrain, pan/zoom, hover/select.
2. Simulation engine core (pure TS + Vitest): types -> movement -> range/launch -> interception -> damage -> fog filter -> win conditions -> state machine.
3. Wire sim -> renderer: single-player sandbox against a static dummy opponent.
4. Order builder UI + hotseat two-player with fog handoff. **<- V1 done: the game is playable and testable for fun.**

**V1.5 — networked**
5. WebSocket server: rooms, order collection, authoritative resolve, per-player fog filter.
6. Countdown timer, ready-up, reconnect handling.
7. Resolution animation sequence from event log; dead-hand phase UI.
8. Deploy: static client (Vercel/Netlify) + socket server (Fly.io/Railway).

Do not start V2 features until two humans have played V1 to completion multiple times.

---

## 9. Movement Resolution Rules

Movement is simultaneous, so orders can conflict in ways a turn-based game never has to answer. These rulings are binding on `resolve()`.

**Foundational rule: every move is validated and applied against the state as it stood at the *start* of the round.** No move may depend on another move having already resolved. This is what keeps resolution order-independent, which the determinism rule (§6) requires.

| Situation | Ruling | Why |
|---|---|---|
| Two units ordered into the same empty hex | **Standoff — neither moves.** | Symmetric, deterministic, needs no tiebreak. Same solution Diplomacy has used for simultaneous orders for a century. A seeded coin flip would also be deterministic but makes a key positional outcome unexplainable; player priority would break 1v1 symmetry. |
| Two units ordered to swap hexes | **Both orders illegal.** | Falls out of the occupied-tile rule for free: at round start each destination is occupied. No special case needed. |
| Unit ordered into a hex another unit is vacating this round | **Illegal — no chaining or following.** | The hex is occupied at round start. Permitting it would make resolution order-dependent. |
| Move blocked by a hidden enemy unit | **The order fails entirely; the unit holds position. No partial advance.** | Partial movement would require path reconstruction plus deterministic tiebreaks between equal-cost routes — real complexity in the most correctness-sensitive code. More importantly, a failed order is what gives recon sweeps their value: advancing into unscouted ground risks wasting one of your 4 orders. |
| Move blocked by terrain or a unit the player can see | **Rejected at order entry.** | The UI validates against fog-filtered state, so these never reach resolution. |

**Occupancy:** a living unit blocks both *passage through* and *landing on* its hex, friendly or enemy. Destroyed units block nothing. Ordering a unit to the hex it already occupies is illegal, not a no-op — it would silently waste one of the 4 orders.

**Information leak (intentional):** a player whose move fails can see their unit didn't move, and since visible terrain is already known to them, this effectively reveals that an enemy was there. This is accepted rather than worked around. Making contact with the enemy is genuine intelligence, and it is the defender's reward for having positioned well. Surface it as "your advance was halted" without naming the blocking unit or where it came from.

**Design note:** these rules apply the core loop (**commit → dread → reveal**) to maneuver rather than missiles. You commit an advance without knowing whether it will happen.
