# V2 Gameplay Analysis — why V1 plays as a race, and the three rules that fix it

*Written 2026-08-15, after the first two-human playtest. Measured against commit `88ff6ad` (end of build-order step 10c).*

**This is a design study, not a backlog.** `docs/v2-backlog.md` is deferred-feature reference and must never be implemented from; this file is the opposite — it is a set of proposals meant to be built, one per session, with a `npm run soak` before and after each. Nothing here is implemented yet.

---

## The complaint, and the measurement that confirms it

The playtest report: *"it feels too much like luck with the recon drone. Once you detect the enemy base the game is just a race to get in range and hope their drone can't find you. There's one meta — push the drone and launchers up and decapitate."* Won in 4–5 rounds on the first attempt.

That is correct, and it is arithmetic rather than taste.

A home zone is **96 hexes** (16 cols × 6 rows, §7). It contains **two** sites — bunker and decoy. A drone flight photographs **25 hexes** — a 7-hex `hexLine` plus `reconSwathRadius` 1 — which is **26% of the entire enemy home zone in one round**, and the reveal is **permanent, free, and unaffected by anything the defender does** (§11 rule 3).

So each sweeping round carries roughly a 45% chance of finding at least one site, and the drone reaches the zone on round 2. The harness agrees precisely:

```
mean round of first site found   3.6
enemy home zone photographed     26%
sides that ever found a site     48%
```

**The bunker hunt — which §11 calls "the intel race is the game clock" — runs for about two rounds.** After that the match is execution.

### Why a game with no randomness feels lucky

This is the important reframe. V1 has no dice anywhere (design pillar 2 is intact). It feels lucky because **a single binary event that neither player can influence decides the match**: did the swath happen to cross the site. Determinism is not the same as agency. A coin flip is still a coin flip when you compute it deterministically from where the drone was pointed.

---

## Evidence

`npm run soak`, 60 matches per pairing, seeds 3–62, through the real `resolve()` loop.

| Measurement (per side, per match) | Medium | Hard | Reading |
|---|---:|---:|---|
| Round of first site found | 3.6 | 3.6 | The hunt lasts ~2 rounds |
| Enemy home zone photographed | 26.3% | 25.7% | One swath ≈ 26% of it |
| Sides that ever find a site | 48% | 48% | A coin flip, resolved by round 4 |
| Missiles fired (over ~13 rounds) | 3.4 | 3.6 | 91% of launcher-rounds are driving |
| ...intercepted | 0.4 | 0.3 | Interceptors barely fire |
| Interceptor bases destroyed | 0.01 | 0.01 | Saturation never happens |
| Hits on the real bunker | 0.42 | 0.48 | Feast or famine |
| Decoys destroyed | 0.21 | 0.23 | The bluff rarely gets tested |
| Forced marches ordered | 0.00 | 0.25 | Newest rule, near-unused |
| Mean match length | 15.2 | 13.0 | Armistice still 33% at hard |

**Head-to-head: hard beats medium 38–30 with 52 draws.** The strongest tier is barely distinguishable from the middle one. When better play cannot separate itself from worse play, the game is not yet asking hard enough questions.

Geometry probes (25 generated maps, 21,775 sampled firing lines):

| Probe | Value |
|---|---|
| Home zone | 96 hexes |
| Drone reveal per round | 25 hexes = 26% of a home zone |
| 2 interceptor bases cover | 14 hexes = 15% of a home zone |
| Range-6 firing lines crossing a mountain | **50%** (10,996 / 21,775) — all ignored today |
| Home-zone hexes with no clear range-6 line | 27 of ~1,200 (2.3%) |
| Max approach cost mountains can impose | 1.3 extra rounds (`maxApproachCost` 12 vs 8 open, at movement 3) |

---

## Five causes

Keyed, not numbered — these are simultaneous findings, not a sequence.

### SEARCH — the search is over in two rounds
96 hexes, 2 sites, 25 photographed per round, permanent reveal. There is no skill in the search because sweeping systematically is optimal and nothing you learn changes where you look next. Note what this does to the defender: they place four assets and then watch. They cannot re-hide, relocate, or react to being found.

### NO TRADE-OFF — nothing competes for a launcher's round
Move-XOR-launch is billed as the core tension (§3, §9). In practice a side fires 3.6 missiles across roughly 39 launcher-rounds — **91% of all launcher activity is driving**. For most of the match there is nothing worth shooting at, so the "choice" has one obvious answer. A trade-off only exists when both options have value.

### TEMPO — patience is strictly dominated
The formal reason there is one meta. **Time confers nothing on the patient player.** Both drones search at the same rate regardless of what the launchers do; no defensive action slows the enemy's search; a launcher that holds position gains literally nothing.

Meanwhile the game charges you for the two things you rarely do — launching and marching are the two loud actions (§3) — and charges **nothing at all for ordinary advancing**, which you do every round. "Advance everything, every round" is therefore dominant. It was found in a single playtest, which is the strongest possible evidence.

### DEFENSE — the defensive half of the game is inert
Two bases cover 14 of 96 hexes (15% of your own home zone), destroy 0.3 missiles and lose 0.01 bases per match. §10 describes the per-round intercept cap as "the stalemate-breaker for the whole design," with saturation as its counter. Saturation has essentially never occurred in 360 measured matches, because nobody fires enough missiles for a cap to bind.

### TERRAIN — the map is decoration
Mountains touch exactly one of four systems, weakly. Missiles ignore terrain *by explicit rule* (§10). Drones ignore terrain (§2). The generator caps the movement detour at 1.3 rounds by construction (§7).

**50% of all range-6 firing lines into a home zone cross a mountain, and every one is ignored.** Half the tactical information already on the board is thrown away.

---

## The three fixes, in order

Ordered because they build: **01 creates geography, 02 turns the bunker into a problem you must solve on that geography, 03 gives you a reason to wait once waiting finally pays.**

All three are sim-layer rules of a few lines. None adds an asset type (§2 roster discipline), none adds randomness (pillar 2), and all three apply to bunker and decoy identically (§12).

### 01 — Mountains block line of fire

**Rule:** a LAUNCH is illegal if any hex *strictly between* origin and target is a mountain. Interior only.

**Being in range stops meaning you can fire.** Driving a launcher within 6 of a known site is no longer sufficient — you need range *and* a clear lane, and half of all lanes are blocked. Firing positions become terrain you maneuver for; ridges become shields; placing your bunker *behind* a ridge becomes genuine geographic defense, the first defensive decision in the game that is not just hope. Recon acquires a second job: scouting for lanes, not only for sites.

**The invulnerability trap §10 warns about is real, and interior-only solves it.** A bunker built on a mountain must stay hittable; excluding the target hex (and the origin, which would otherwise self-block) guarantees a mountain site is reachable from any direction with a clear approach. Measured residual: 27 of ~1,200 home-zone hexes (2.3%) currently have no clear range-6 line at all. That is a **fourth rule for `generateMap`'s existing generate-validate-reroll loop** (§7), not a redesign — and re-roll rather than carve, for the reasons §7 already gives.

**Put the check in `validateLaunch`, not in `flyMissiles`.** Terrain is public (§11), so a blocked shot is a fact the player can already see, and §9's principle rejects those at order entry rather than wasting a round. A rejected LAUNCH is silent (§10), which stays consistent. And because `launchTargets` in `src/state/orders.ts` and all three CPU tiers in `cpu.ts` already defer to `validateLaunch`, the UI highlighting and CPU legality inherit the rule for free.

Cost: ~10 lines in `missiles.ts`, one validator rule in `map.ts`, one `TERRAIN_GEN` constant.

### 02 — The bunker repairs between strikes

**Rule:** at the end of any round in which a bunker **or decoy** took no hits, it returns to full HP. Written to name both kinds, exactly as `BUNKER_HIT` already is (§6) — free at 1 HP, and it keeps §12's "raise the decoy to 2 HP" lever symmetric by construction.

To kill, you must land **two hits in one round**: two launchers within range 6 of the same hex, both with a clear lane after 01, both firing simultaneously, both publishing their position via `LAUNCH_DETECTED`, neither able to move that round (§3).

Four consequences:

1. **It makes the interceptor cap decisive for the first time.** Stopping *one* of two missiles now saves the bunker completely and resets the attacker's whole setup. Two bases become a real defense, and a defended lane demands a three-missile volley — every launcher committed at once. That is the saturation §10 always claimed was the point and which the harness shows never happens.
2. **Finding the bunker early stops being decisive.** You know where it is and still have to solve massing. That is the strategic middle game the match currently skips.
3. **It sharpens the decoy test rather than blunting it.** One missile at a site still resolves the bluff perfectly — destroyed means fake, silence means real (§12). Only the *damage* stops carrying over, so the probing shot becomes a pure purchase of information and the kill becomes a separate coordinated act. Commit → dread → reveal runs twice instead of once.
4. **It rewards surviving.** A defender who weathers a round is genuinely reset.

This promotes a tactic the spec **already describes** — the two-missile alpha strike in §3 and §12 — from optional shortcut to the only route to decapitation. Not a new mechanic; an existing one made load-bearing.

**Soak this one carefully.** It is the change most likely to push matches toward Armistice, already 33% at hard. Softer version if it over-defends: repair only after two consecutive quiet rounds. Keep it as a knob in `defs.ts` (`UNIT_DEFS.bunker.repairsAfter`), never a hardcoded branch — data-table rule (§6).

Cost: ~6 lines in `resolve.ts` phase 3, one `defs.ts` field.

### 03 — Dug-in launchers

**Rule:** a launcher that receives **no order** for a full round is dug in, and is not revealed by an enemy recon swath. Moving, marching or firing un-digs it immediately. **Emission detection is untouched** — going loud still finds you.

The direct answer to "reward patience as much as aggression," and the cheapest of the three. It is the first time in the game that doing nothing is productive.

What it creates is **ambush**: park a launcher covering a clear firing lane, invisible to recon, and let the enemy drive into it. After 01, clear lanes are scarce and predictable enough that guarding one is a real read on your opponent rather than a guess. It also taxes the winning line directly — push all three launchers forward every round and all three are photographable every round. And it turns *absence* into information: no contacts this sweep starts to mean "they are dug in somewhere."

It costs the drone nothing that matters. Its primary job is hunting sites, which are static and cannot dig in; what it loses is the free launcher intel it currently gets as a bonus.

**§11 rule 2 stays intact** — the detector still exists, it simply does not see a unit that has not moved. Launchers only, so §12 is untouched entirely.

Cost: one flag on `Unit`, one filter in the recon reveal, one clear in `resolve.ts` when a launcher acts.

### How the three interlock

Mountains make firing lanes scarce. Repair means the bunker can only be killed by massing two or three launchers on one of those scarce lanes simultaneously. Digging in means the defender can be sitting on that lane, invisible, waiting. **Three small rules, and the endgame becomes a conversation instead of a race.**

---

## Cheaper knobs, once those land

One per soak run.

| Knob | Change | Effect |
|---|---|---|
| **More decoys** | `RULES.placementCounts.decoy: 2` | Verified nearly free — the roster is fully count-driven, down to the `-1`/`-2` id suffixes in `startingUnits`. Finding "a site" gets easier; *identifying* the real one costs more missiles and more exposure. The bluff fires in 23% of matches today; this makes it routine. |
| **Deep ground is loud** | end of `resolve.ts` | An enemy launcher standing in your home zone at round end files a one-round contact. Kills camping without forbidding the strike — the geometry already lets you hit row 0 from row 6, outside the zone. Frame as §11 rule 2 generalising again, exactly as the forced march did. |
| **Elevated interceptors** | `coverage.ts` terrain lookup | A base on a mountain covers radius 2. Gives terrain a say in *defensive* placement, which after 01 is the half of the map that matters most. Not a §12 concern — bases are not sites. |
| **Slow the clock** | `UNIT_DEFS.drone.movement: 6 → 4` | Sweep drops 25 → ~19 hexes and arrival is delayed. Cheapest change available and the least interesting: longer, not better. Fine-tuning only. |

---

## What not to do

| Tempting | Why not |
|---|---|
| **Add randomness to recon** | Breaks design pillar 2 outright. The game does not feel lucky for lack of dice — it feels lucky because one uninfluenceable event decides it. Adding real luck fixes nothing and costs determinism, replays, and the V1.5 authoritative server. |
| **Make the bunker mobile** | The obvious answer to "the defender can't react," and it detonates §11's mobile/static split, permanent static reveals, and much of the visibility filter. Fix 02 buys the same counterplay for six lines. |
| **Add a fourth asset type** | §2's roster discipline is correct. The missing depth is in interactions, not roster size. |
| **Splash damage** | Turns blind fire into a search tool, i.e. a second detector, undercutting "only drones find bunkers" (§11) and the whole intel economy. |
| **A two-stage commit window** | Already considered and rejected in §3 — doubles the hotseat handoffs and the order-phase machinery. Nothing in this diagnosis needs it. |

---

## Session plan

Project workflow already has the right shape: one system per session, `npm run soak` before and after anything touching `defs.ts` or `cpu.ts`. All three fixes touch balance, so all three need it. Use `SOAK_MATCHES=100` for numbers tight enough to trust.

| Session | Touches | Expect to move |
|---|---|---|
| 01 · Mountains block fire | `missiles.ts`, `map.ts`, `defs.ts` | Missiles fired ↓, match length ↑, hard-vs-medium gap ↑ |
| 02 · Bunker repairs | `resolve.ts`, `defs.ts` | Intercepts ↑↑, decapitations ↓, Armistice ↑ (watch it) |
| 03 · Dug-in launchers | `types.ts`, `recon.ts`, `resolve.ts` | Launchers killed ↓, first-site round unchanged, hard-vs-medium gap ↑↑ |
| 04 · Knobs | `defs.ts` only | Tune Armistice back toward 20–25% |

Two things to expect:

- **The CPU needs work in each session.** All three tiers currently assume range equals ability to fire; after 01 that is false. `cpu.ts` inherits *legality* free from `validateLaunch`, but its *targeting heuristics* (`selectTarget`, `AdvanceGoal`) must learn about lanes.
- **Hard-versus-medium is the metric that matters most.** It sits at 38–30 with 52 draws. If these changes do what this document claims, that gap should widen — because the game will finally be asking a question that better play can answer.

**Start with 01.** It is the smallest diff here, it addresses the terrain problem noticed unprompted in playtest, and it makes half the board's existing information matter for the first time.

---

## Spec impact, if these are adopted

Each fix is a genuine rules change and must be written into `docs/nuke-wars-v1-spec.md` as part of the session that implements it, per CLAUDE.md:

- **01** amends §10 (the "missiles ignore terrain" rule gains its interior-only exception, and the reasoning behind the old rule is preserved as the justification for interior-only), §7 (fourth generator validation rule), §2's terrain table.
- **02** amends §2 (bunker row), §3 (phase 3), §12 (the bluff-resolution paragraph — the information is unchanged, the damage model is not).
- **03** amends §3 (a launcher with no order now *does* something), §11 (rule 2's detector list is unchanged; the swath gains one exclusion), and §9.
