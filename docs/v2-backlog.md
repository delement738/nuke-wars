# SUPERSEDED — V2 BACKLOG, NOT THE ACTIVE SPEC

This is the original full design vision. The authoritative V1 spec is
`docs/nuke-wars-v1-spec.md`. Nothing in this file is in V1 scope.
Use this only as a reference for future features after V1 ships.

# NUKE WARS — V1 Design Specification

*A 1v1 strategic command-and-control duel. Simultaneous hidden orders, hex-grid maneuver, finite defenses, and a decapitation endgame.*

**Design pillar (judge every feature against this):** the core loop is **Commit → Dread → Reveal**. Players commit orders under a countdown without knowing the enemy's orders; resolution is simultaneous and dramatic. Moving into striking range is itself the act of exposure.

---

## 1. Objective

Destroy the enemy regime before yours falls. Two paths:

1. **Decapitation** — find and kill the enemy Leader, then survive their final retaliation.
2. **Disarmament** — destroy all enemy offensive capability (launchers + missiles).

The Leader is a hidden piece (Stratego-flag style). The intel war — finding theirs, hiding yours — is the heart of the mid-game.

---

## 2. V1 Scope (deliberately minimal)

### Included

| System | V1 version |
|---|---|
| Map | Hex grid, mirrored generation, 3 terrain types: **Plains** (normal), **Mountains** (block radar line-of-sight, impassable), **Urban** (regime hexes — your infrastructure/score) |
| Offensive units | **Mobile Launcher (TEL)** — moves, fires SRM or MRM |
| Missiles | **SRM** (short range, cheap, hard to intercept), **MRM** (longer range, more damage, easier to intercept) |
| Defensive assets | **Radar station** (fixed, detection radius, LoS-blocked by mountains), **Interceptor battery** (fixed, finite interceptor ammo) |
| Recon | **Recon sweep** (limited-use ability: reveal a small hex area for 1 round) |
| Deception | **1 Decoy Leader site** per player (emits false command signal) |
| Leader | Hidden. Starts in a bunker (2 hits to crack). May relocate — relocation leaks a detectable signature that round |
| Detection feedback | Defender is notified when enemy recon pings near their Leader (not what enemy inferred) |
| Turn structure | Simultaneous order phases with countdown timer (75s default; both players can ready-up early). Server resolves once per round |
| Chance model | Interception: resource-driven probability (each interceptor committed adds fixed %), single roll per inbound. Damage: 85–115% variance band |
| Reveal rule | Any launch reveals the origin hex to the opponent |
| Fog of war | Enemy units visible only inside radar/recon coverage; stale contacts persist as decaying "last seen" ghosts |

### Explicitly deferred to V2+
Long-range/strategic missiles, cruise/stealth missiles, saturation decoy warheads, EMP/jammers, doctrines, escalation clock, naval/water hexes, 3+ player modes, ranked ladder, spectator mode, account system.

**Roster discipline:** V1 = 1 mobile unit type, 2 missile types, 2 fixed defense types, 1 recon tool, 1 decoy, 1 leader. Depth comes from interactions (radar shadows × interceptor economy × leader hunt), not roster size.

---

## 3. Gameplay Flow

1. **Setup phase** (untimed or generous timer): each player secretly places Leader bunker, decoy site, radars, interceptor batteries, and starting launchers within their home zone.
2. **Order phases** (repeating): countdown starts → each player queues up to N orders (move, launch, recon sweep, relocate leader) → timer expires or both ready → server resolves simultaneously → animated reveal sequence (radar pings → launches detected → intercepts → impacts) → new round.
3. **Grace rules:** Leader is untargetable for the first 3 rounds. No launches round 1 (forces at least minimal maneuver before shooting).
4. **Endgame:** on Leader death → **DEAD HAND**: the decapitated player gets one final round to manually launch everything surviving. Then final adjudication.

---

## 4. Outcomes (checked in priority order, after full round resolution)

| # | Outcome | Condition |
|---|---|---|
| 1 | **Victory by Decapitation** | Enemy Leader dead, your Leader survives the dead-hand round |
| 2 | **Victory by Disarmament** | Enemy has zero launchers and zero missiles |
| 3 | **Victory by Capitulation** | Opponent resigns |
| 4 | **Draw — Mutual Annihilation** | Both Leaders dead (same round, or via dead-hand retaliation) |
| 5 | **Attrition Adjudication** | Round cap reached → compare surviving regime % (urban hexes + assets + leader status). Within 5% margin = **Armistice** (draw) |

Post-match: fog-lifted replay for both players (see what was real, what was bluff, how close the reads were).

Match length target: **15–25 minutes.**

---

## 5. Game State Machine (server-side)

```
LOBBY → SETUP → ORDER_PHASE ⇄ RESOLUTION → (check outcomes)
                                   │
                          leader killed?
                                   ↓
                          DEAD_HAND_PHASE → FINAL_RESOLUTION → GAME_OVER
```

Victory conditions are evaluated only after a full resolution completes — never mid-resolution.

---

## 6. Technical Architecture (web stack)

**Stack:** TypeScript everywhere. PixiJS (map/units/effects rendering) + React (lobby, HUD, timer, panels) + Zustand (client state). Node.js + WebSockets (`socket.io` or `ws`) server. Hex math via `honeycomb-grid`.

**Four layers, strictly separated:**

1. **Simulation engine** — pure TypeScript module, zero dependencies on React/Pixi/network. One pure function: `resolve(state, ordersP1, ordersP2, rngSeed) → newState + eventLog`. Fully unit-testable. Runs ONLY on the server in multiplayer (authoritative).
2. **Fog filter** — pure function: `filterForPlayer(state, playerId) → visibleState`. The server applies this before sending state to each client. Clients NEVER receive hidden enemy data (anti-cheat by construction).
3. **Presentation** — Pixi + React. Reads visible state, renders it, builds pending orders. Never mutates game state.
4. **Network** — rooms/matches, order collection window, countdown enforcement, reconnect handling, per-player state broadcast.

**Determinism rule:** the simulation takes an explicit RNG seed and is fully deterministic given (state, orders, seed). This gives you: reproducible bug reports, cheap replays (store initial state + orders + seeds per round = full replay), and simulation-vs-simulation balance testing.

**Event log rule:** `resolve()` emits an ordered event list (LAUNCH_DETECTED, INTERCEPT_ATTEMPT, IMPACT, LEADER_KILLED...). The client plays animations from events, not by diffing states. This is also the replay format.

---

## 7. First-Draft Numbers (tune in playtest — all values are starting guesses)

| Parameter | Value |
|---|---|
| Map size | ~19 hexes wide, mirrored |
| Order phase timer | 75 seconds |
| Orders per round | 4 |
| Round cap | 30 rounds |
| Starting launchers | 4 per player |
| Starting missiles | 6 SRM + 4 MRM per player |
| SRM: range / damage / base intercept chance vs it | 5 hexes / 2 / 35% per interceptor |
| MRM: range / damage / base intercept chance vs it | 9 hexes / 4 / 50% per interceptor |
| Multiple interceptors on one inbound | each adds its base % (cap 90%) |
| Interceptor battery | 4 interceptors ammo, protects radius 3 |
| Radar station | detection radius 6, LoS-blocked by mountains |
| Launcher movement | 2 hexes/round |
| Recon sweeps per player | 5 per match, reveals radius-2 area for 1 round |
| Leader bunker HP | 2 penetrating hits |
| Leader relocation | convoy signature detectable by radar that round; 1-hit kill while mobile |
| Urban hexes per player | 6 (regime score base) |
| Damage variance | 85–115% |

---

## 8. Build Order (each step = one focused coding session)

1. Hex map render (Pixi): mirrored terrain gen, pan/zoom, hover/select.
2. Simulation engine core (pure TS + unit tests): types, movement, range, launch, intercept, damage, fog visibility, win-condition check, state machine.
3. Wire sim → renderer: single-player sandbox vs. static dummy.
4. Order builder UI + local hotseat (pass-and-play proves fog + reveal tension).
5. WebSocket server: rooms, order collection, authoritative resolve, per-player fog filter, two browser tabs playing each other.
6. Countdown timer + ready-up, reconnect handling.
7. Resolution animation sequence from event log; dead-hand phase UI.
8. Setup-phase placement UI; post-match fog-lifted replay.
9. Deploy: static client (Vercel/Netlify) + persistent socket server (Fly.io/Railway).

**V1 done = step 9.** Everything in "deferred" list is V2+.
