# Next sessions: finishing the rules layer (the sim freeze)

> **Not spec.** A working brief for the sessions that complete `src/sim/`. The spec
> (`docs/nuke-wars-v1-spec.md`) stays the source of truth and is amended *inside*
> each session that changes a rule. Delete this file in the merge that closes the
> last rules session, as `next-session-10a.md` and `next-session-flight-time.md` were.

## Goal

Freeze the game rules so that the next phase (animation from the event log, missile
launch/flight visuals, inbound warnings, how-to-play) builds on rules that no longer
move. After the freeze, `src/sim/` changes only for bugs.

**Exit criterion (CLAUDE.md, agreed 2026-09-27):** the three rules below are in and
specced, hard mirror Armistice < 15%, hard beats medium clearly, and 2–3 human hotseat
games that don't feel like a race. The last item is on the designer: it cannot be
soaked.

## Where we start

- **Step 0: commit the CPU base-placement work** (HARD's `cpuSetup`, currently
  uncommitted on `main`) before branching for anything below.
- Baseline, `SOAK_MATCHES=60 SOAK_SEED=3`: hard mirror decapitation 46 / Armistice 5 /
  mutual annihilation 7; hard vs medium **59–31**; intercepts 1.6 per side, bases killed
  0.38. Record seeds 7 and 11 too. Use `SOAK_MATCHES=100` when a result is close.
- The design case for all three rules is `docs/v2-gameplay-analysis.md`. **It was
  written before the interceptor redesign and flight time**, so it still says "two
  bases", "Armistice 33%" and "hard vs medium 38–30". The rules still stand. The
  interactions called out below are what has changed since.

## The work: three rules, one session each, in this order

Each rule builds on the one before it: mountains create firing lanes, repair makes
kills need massed fire down those lanes, and digging in lets a defender wait on a lane
unseen. Each session follows the same pattern: types first for approval (sim-work
rule), then the rule, tests with at least one illegal case, mutation checks, spec
amendments, CPU updates, and a before/after soak.

### Session A: mountains block line of fire

> **DONE 2026-09-28** (`feature/mountains-block-fire`; CLAUDE.md entry of that date). Two corrections to
> the plan below: `launchTargets` did *not* get the rule free (it never called `validateLaunch`),
> and the `LINE_BLOCKED` soak line always reads 0 because the CPU pre-validates — the lane-blindness
> signal is the new "site in range, but no clear line" line. Hard mirror Armistice ended at 13–15%.

**Rule:** a LAUNCH is illegal if any hex *strictly between* origin and target is a
mountain. The target hex is exempt, so a mountain bunker stays hittable (§10's
invulnerability trap). Launchers can't stand on mountains, so the origin never blocks.

- **Where:** `validateLaunch` in `missiles.ts`, with a new reason `LINE_BLOCKED`. Don't
  put it in `flyMissiles`. Terrain is public, so the rejection is silent like every
  other rejected launch (§10). `launchTargets` (UI) and every CPU tier get the rule's
  legality for free because they already call `validateLaunch`.
- **The line is `hexLine(origin, target)`**, the spec'd primitive with its epsilon
  (gotcha 12). Never re-derive it.
- **Flight time:** line of fire is checked at launch only. A missile in flight has a
  fixed path, so nothing re-checks it.
- **Map generator:** add a validation rule to `validateMap` (with its re-roll loop). Every
  home-zone hex must have at least one clear range-6 line from a plains hex. The
  analysis measured 2.3% of home-zone hexes with none. Re-roll the map, never carve a
  path (gotcha 7c). Check that the re-roll rate doesn't blow `TERRAIN_GEN.maxAttempts`.
- **CPU:** legality comes free, but the heuristics must learn about lanes, or HARD
  parks at range 6 behind a ridge forever and Armistice spikes. `advanceScore` for a
  `site` goal should count a hex as "in range" only if it has a clear line. HARD's
  placer (`approachLanes` in `cpuSetup.ts`) should drop blocked lanes too.
- **Spec:** §10 (the "missiles ignore terrain" rule gets its interior-only exception;
  keep the old reasoning as the justification), §7 (the new generator rule), §2's
  terrain table. **Also fold in the one-line §3 note** left over from the flight-time CPU
  session: the impact warning arrives too late to dodge.
- **Gotcha 7b must be rewritten**, not deleted. The mountain-bunker invulnerability
  argument is now the reason the exemption is interior-only.
- **Expect:** missiles fired ↓, match length ↑, Armistice ↑ (watch it).

### Session B: the bunker repairs between strikes

**Rule:** at the end of any round in which a bunker **or decoy** took no hits, it
returns to full HP. The rule names both kinds, like `BUNKER_HIT` does (§6, §12). At
1 HP the decoy can never be damaged and survive, so the decoy clause does nothing
today. It is there to keep the "decoy to 2 HP" lever symmetric.

- **Where:** end of `resolve()`, after phase 4, not inside phase 3. Put it as a data knob
  in `defs.ts` (the analysis suggests `repairsAfter: 1` quiet round), never a hardcoded
  branch. If Armistice runs away, the softer setting is 2.
- **Repair must never be public.** A public repair would be a bunker detector, since the
  decoy never repairs. Recommended: no event at all, or an owner-only one for the
  defender's log. Decide at session start and pin it with a negative test, in the style
  of gotcha 60.
- **Flight time creates a new tactic, time-on-target.** A 5–6 shot fired last round and a
  ≤4 shot fired this round both land in the same phase 3. That counts as two hits in
  one round, so the combined strike kills. Test it explicitly. It is the most
  interesting thing this rule creates.
- **Interceptor math:** one base stops one missile per round, so killing a bunker
  inside a bubble takes three missiles landing together. Killing one outside a bubble
  takes two.
- **CPU:** this is the untried "2-missile alpha strike" lever. HARD should hold fire on
  a known *real* bunker until two launchers can land hits together (three if a
  known base covers the lane). `baseVolley` already coordinates for bases and is the
  pattern to copy. The one-missile decoy test stays as it is (§12's bluff is
  unchanged).
- **Spec:** §2 (bunker row), §3 (end-of-round step), §12 (the bluff-resolution
  paragraph: the information is the same, the damage model is not).
- **Expect:** decapitations ↓, Armistice ↑ (the main risk), intercepts matter more.

### Session C: dug-in launchers

**Rule:** a launcher that receives **no order** for a full round is dug in and not
revealed by an enemy recon swath. Moving, marching or firing un-digs it immediately.
Emission detection (`LAUNCH_DETECTED`, `MARCH_DETECTED`) is untouched.

- **Where:** a flag on `Unit` (`types.ts`), a filter in the recon reveal (`recon.ts`), set
  and cleared in `resolve.ts`. Launchers only, so §12 is untouched.
- **Decide at session start:**
  1. Does a *rejected* order count as acting? Recommend no: an illegal or blocked order
     means the launcher held, same as "no order".
  2. Do launchers start the match dug in? Recommend no. Spawns are public anyway, and
     round 1 should not open invisible.
  3. Does a human's HOLD dig in? Yes: `draftOrders` already strips HOLD, so it already
     counts as "no order".
- **Visibility:** the flag is on your own units only. The filtered state never holds
  enemy units (gotcha 31), so nothing can leak. Check it anyway with a test.
- **CPU:** mostly emergent, because HARD already stops moving once in position.
  EASY's habit of holding will now make its launchers invisible, so re-check
  medium-vs-easy.
- **Spec:** §3 (holding now does something), §11 (the swath gains one exclusion; rule 2's
  detector list is unchanged), §9.
- **Expect:** launchers killed ↓, first-site round unchanged, hard-vs-medium gap ↑.

### Session D (only if needed): tuning knobs, `defs.ts` only

Only if A–C leave hard mirror Armistice ≥ 15%. One knob per soak: repair softness,
`roundCap`, `droneRespawnDelay`, and the analysis's "cheaper knobs" table. Note that the
analysis aims Armistice at 20–25%, but the CLAUDE.md exit criterion (< 15%) is the later
decision and wins.

## Soak harness additions (make them in the session that needs them)

- A (done): `LINE_BLOCKED` launches sent (an honesty check, 0 by construction) and
  launcher-rounds with a known site in range but no clear line, per tier.
- B: bunkers repaired per side, and kills by a same-round double hit vs. anything else.
  Time-on-target kills get their own line.
- C: recon passes that went over a dug-in launcher without revealing it.

## Out of scope for the freeze (decided, don't drift into them)

DEFCON, convoy, decoy emissions, dead-hand buffs, doctrines, a fourth asset type,
splash damage, randomness of any kind. **Open for the designer to rule on:** the
defender's "hold fire" order (in the freeze, or deferred?). Narrowing the validators to
`(units, map)` is housekeeping, not rules. It can happen any time.

## When the freeze is done

Update CLAUDE.md "Next up" to the pre-V1.5 polish list: animation from the event log,
in-flight missile and inbound warnings, candidate-hex shading after `DRONE_DOWNED` and
`MISSILE_INTERCEPTED`, and a how-to-play screen. Then run the 2–3 hotseat games.
