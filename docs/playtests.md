# Nuke Wars — playtest log

*Skeleton from V1.5 Session 1; beta section added in Session 9.* One entry per human game: hotseat playtests before networking (the gate after Session 4), then beta games in Session 9.

A playtest that shows a real rules problem reopens the freeze **on purpose** (spec §8). The "Considered and set aside" table in `docs/v2-backlog.md` says which set-aside idea answers which symptom.

## Beta (V1.5 Session 9)

Invited testers play each other online at https://nuke-wars.vercel.app/ → **Play online**. Order clock: **35 s** (+5 s after a round with a replay; raised from 25 s on 2026-09-30). A round resolves as soon as both seats send, so the clock is only a ceiling.

**Before inviting anyone:** the server must already be running the build you want tested. A Railway redeploy (any merge to `main` that touches the server) **ends every match in progress**, so merge fixes between games, not during them.

### What to watch for

During the game (yours, or ask testers to tell you):
- [ ] **Joining:** did the link open straight into the waiting room, and the match start once both were in?
- [ ] **Setup:** did both players understand what to place and that they had to press **Send setup**?
- [ ] **The clock:** did anyone run out of time? Did 35 s feel rushed, right, or slow? Which rounds were hardest to finish?
- [ ] **Waiting:** did the faster player get bored waiting for the slower one?
- [ ] **Replays:** could players follow what happened each round (launches, intercepts, hits)?
- [ ] **Hidden information:** did anyone ever see something they shouldn't (enemy units without a drone sighting or launch, the decoy marked as a decoy)? *Treat any of these as a top-priority bug.*
- [ ] **Disconnects:** did anyone drop out or reload? Did they get back into their seat?
- [ ] **The ending:** was it clear who won and why? Did **Play again** / back to title work?

After the game, ask:
- [ ] What was confusing?
- [ ] Did it feel like a race to find the bunker, or like a stalemate?
- [ ] Would you play again?

From the server (Railway → project `nuke-wars` → the service → **Deployments** → **View logs**):
- [ ] Count lines like `room K7QX2M: p1 timed out`. Each is one round where a player hit zero without sending, which is the clock's hardest evidence.
- [ ] Look for anything with `Error` in it.

### Bug queue

Every bug a tester finds gets a row here; game entries link to it by number. Status is `open`, `fixed (<commit>)`, or `won't fix: <why>`.

| # | Found | What happened | How bad | Status |
|---|---|---|---|---|
| | | | | |

## Template

Copy this for each game. One or two words per line is enough; write more only where something happened.

```
### YYYY-MM-DD — online | hotseat — who played
- Build: <commit> (clock 35 s)
- Result: <winner>, <how: bunker destroyed / round cap / resigned / other>, round <N>
- Clock: <too short / about right / too long>; timeouts in the log: <N>
- Connection: <fine / dropped, rejoined / dropped, lost the game>
- Felt like a race? <yes / no / why>
- Confusing: <anything a player didn't understand>
- Bugs: <none, or bug queue #s>
- Rules concern: <none, or what and why>
- Quote: <anything a tester said worth keeping>
```

## Games
<!-- Newest at the bottom. -->

### 2026-09-29 — vs CPU — the designer (several games, the gate)
- Build: https://nuke-wars.vercel.app/ after Session 4 (ac8b59f)
- Result: not recorded game by game
- Felt like a race? not recorded
- Confusing: nothing reported
- Bugs: none reported
- Rules concern: none ("I have play tested that version of the game and it's good")
- Note: the gate asked for hotseat games; the designer played only against the CPU and judged that enough to start networking. Hotseat itself was last exercised in headless Chrome during Session 5.

### 2026-09-30 — online — the designer, against themself in two browsers
- Build: https://nuke-wars.vercel.app/ after Session 8 (6865cc8), server on Railway
- Result: not recorded
- Felt like a race? not recorded
- Confusing: nothing reported
- Bugs: none reported ("it worked well and was cool to play")
- Rules concern: none
- Note: **the 25 s order clock felt tight** ("hard to input all my orders in the allotted time"). Partly because one person was ordering for both seats.
- **Outcome (2026-09-30, Session 9):** the designer raised the clock to **35 s** for the beta (`DEFAULT_TIMING.orderMs` in `server/lobby.ts`), over keeping 25 s or a longer clock only for the first rounds. Simplest change, and since a round resolves once both seats send, a too-long clock costs little. Beta games decide whether it stays.
