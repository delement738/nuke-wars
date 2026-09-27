# Session brief: missile flight time (V1.1 Step 3)

> Session brief, following the `next-session-10a.md` precedent — **the
> implementing session deletes this file on merge.** Context and the full case
> for the change: `docs/v1.1-design-consultation.md` §5 Step 3. Direction
> (deterministic, incremental) was decided 2026-08-30; two designer additions —
> battle reports and the single public base — were inserted ahead of it the same
> day, so this is now the **third** session, not the first. Nothing in the rule
> below changed; note only that the inbound-strike warning it creates should be
> surfaced through the battle-report layer built in Step 1, and that the soak
> baseline to compare against is the one taken after Step 2, not the §1 figures.

## Session goal and boundary

Sim engine only: `types.ts`, `defs.ts`, `missiles.ts`, `resolve.ts`,
`outcomes.ts`, `visibility.ts`, their tests, and the spec (§3, §4, §6 note, §7,
§10). **Not this session:** UI (drawing in-flight missiles, order-panel copy) and
CPU (dodge-on-warning, target leading) — both named follow-ups, the same split
the forced march shipped with. Expect the soak numbers to move and *record* them;
do not chase them here (see "Soak expectations" below).

## The rule

- New `RULES.missileSpeed = 4` — hexes a missile advances per resolution, along
  its existing `path` (`hexLine(origin, target).slice(1)`, unchanged).
- **Range ≤ 4 therefore lands the same round it fires — today's behaviour
  exactly.** Range 5–6 spends one round in flight and lands in the *next* round's
  phase 3. (Path length equals distance, so "≤ speed" is "same round".)
- **Phase 2 becomes: advance every in-flight missile** — those launched this
  round and those carried in state — step-at-a-time with the existing §10
  intercept logic. Each path hex is intercept-checked **once, on entry, over the
  missile's whole life**; base capacity stays per-round, so a bubble can also be
  *walked through* across two rounds — saturation gains a time axis.
- **Phase 3 impacts only missiles that completed their path this round.**
  Unfinished ones persist in `GameState.missiles` with their progress.
- `LAUNCH_DETECTED` is **unchanged** — it already publishes `{origin, target}` to
  both players (§6), and the impact round is derivable by both sides from public
  data (missile ids are `r{round}@{origin}`; speed is a public rule). The
  defender's warning costs zero new visibility rules. No new event kinds; the
  client can derive any in-flight position from the log (`hexLine` per gotcha 12),
  and the filtered state carries it directly (types below).

## Types — show for approval before implementing logic (workflow rule)

```ts
// types.ts ------------------------------------------------------------------

/**
 * A missile that has been launched and not yet impacted or been intercepted.
 * Lives in GameState.missiles between rounds. `path` is hexLine().slice(1) as
 * today (missiles.ts); `traveled` is how many of those hexes it has entered so
 * far — path[traveled - 1] is its current hex, and traveled === path.length
 * means it arrives this phase 3.
 */
export interface InFlightMissile {
  id: MissileId;              // r{round}@{origin} — unique across rounds by construction
  owner: PlayerId;
  launcherId: UnitId;         // engine bookkeeping only; NEVER leaves the sim (§11)
  origin: Hex;
  target: Hex;
  path: Hex[];
  traveled: number;
}

// GameState gains one field:
//   missiles: InFlightMissile[];   // canonical order: launch round asc, then compareHex(origin)

/**
 * The filtered projection (visibility.ts). Everything here is public — origin,
 * target and launch round were published by LAUNCH_DETECTED, and progress
 * follows from the public speed rule. `launcherId` is structurally absent:
 * carrying it would hand the enemy a trackable launcher identity, the exact
 * leak §11 keys intel by hex to prevent. Same design as VisibleGameState
 * dropping enemy units (§6): the field the leak needs does not exist.
 */
export interface VisibleMissile {
  id: MissileId;
  owner: PlayerId;
  origin: Hex;
  target: Hex;
  traveled: number;
}

// VisibleGameState gains:
//   missiles: VisibleMissile[];    // BOTH players' — flights are public
```

`defs.ts`: `missileSpeed: 4` in `RULES`, with a note tying it to `missileRange`
(6): the gap between them — shots at 5–6 — is exactly the band that gets
telegraphed, so the two numbers tune the warning together.

## Rulings the spec must gain (recommendations, decide in-session)

1. **In-flight missiles count as offensive capability.** A side with ≥ 1 missile
   in flight is not disarmed even at zero launchers — §1's own rationale ("zero
   launchers = zero offensive capability") stops being true the moment a
   kill-shot can be mid-air when its launcher dies. `adjudicate` reads
   `state.missiles` alongside launcher counts, for Disarmament and Mutual
   Disarmament both. Without this, a player's winning missile is voided by a
   verdict issued while it flies.
2. **A phase-4 verdict freezes flights.** "A round that ends at phase 4 stops
   there" (§3) extends to missiles: kept in state, never advanced again, no
   impact after `GAME_OVER` for a client to animate. (With ruling 1, a frozen
   missile can no longer be a voided win for Disarmament; a bunker verdict
   outranks everything anyway, §4.)
3. **The dead-hand round advances ALL in-flight missiles, both owners'**, in its
   phases 2→3. A decapitation with enemy missiles still inbound can therefore
   still become Mutual Annihilation — the consultation's "not a clean win", by
   construction rather than by new rule.
4. **Cross-round tiebreak: oldest launch round first, then origin hex** within a
   round (existing `canonicalOrder`). Both keys are public — the missile id
   publishes them — so this passes the gotcha 22/50 test: public ordering from
   public data.
5. **Fire-and-forget:** a launcher's death does not touch its missile. Falls out
   of `InFlightMissile` owning its own data; pin it with a test, not code.

## Tests (normal / edge / illegal, per workflow)

- Normal: range-6 shot — `LAUNCH_DETECTED` round N, no `IMPACT` round N,
  `IMPACT` round N+1; range-4 shot byte-identical to today's events.
- Determinism: same (state, orders) twice → deep-equal, with missiles in flight.
- Edge: interception in the missile's *second* round; per-hex-once (a missile
  parked inside a bubble is not re-engaged on its parked hex); per-round capacity
  reset (same base intercepts in consecutive rounds); launcher dies while its
  missile flies (missile lands anyway); in-flight missile crossing the dead-hand
  round; phase-4 verdict with missiles mid-air (state keeps them, log shows no
  later impact); zero-launcher side with a missile in flight is not disarmed —
  and IS disarmed once it lands/intercepts with no launcher left.
- Illegal: unchanged `validateLaunch` cases still hold (no new order shape).
- Mutation checks: break ruling 4's ordering → determinism/log tests fail; leak
  `launcherId` into `VisibleMissile` → a structural-redaction test fails
  (mirror the gotcha 31 test's shape).

## Soak expectations (record, don't chase)

Run `SOAK_MATCHES=60 SOAK_SEED=3 npm run soak` before and after; baseline is in
the consultation §1. Expected: hard-tier decapitations and hits-on-bunker dip —
the CPU still assumes same-round impact, so its long-range shots now telegraph
and its counter-battery beyond range 4 whiffs against movers. That regression is
the *feature working* against an opponent who hasn't learned it; the CPU
follow-up session (dodge-on-warning: move any launcher sitting in a published
impact disc; prefer firing solutions ≤ 4 when lethality matters; target leading)
is where the head-to-head acceptance target (≥ 70–20) gets measured for real.

## Files, in implementation order

1. `types.ts` — the two interfaces + two field additions above (approval gate).
2. `defs.ts` — `missileSpeed`, with the tuning note.
3. `missiles.ts` — split `flyMissiles` into advance-N-steps over
   `InFlightMissile[]` + partition done/pending; the hex-at-a-time intercept
   loop survives verbatim.
4. `resolve.ts` — phase 2 merges newly-launched + carried missiles; phase 3
   impacts the done set; phase-4 freeze per ruling 2; dead-hand branch per
   ruling 3.
5. `outcomes.ts` — ruling 1.
6. `visibility.ts` — project `missiles` → `VisibleMissile[]` (strip
   `launcherId`), both players'.
7. Spec §3/§4/§6/§7/§10 amendments + CLAUDE.md status entry + delete this file.
