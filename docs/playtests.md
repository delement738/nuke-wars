# Nuke Wars — playtest log

*Skeleton from V1.5 Session 1.* One entry per human game: hotseat playtests before networking (the gate after Session 4), then beta games in Session 9.

A playtest that shows a real rules problem reopens the freeze **on purpose** (spec §8). The "Considered and set aside" table in `docs/v2-backlog.md` says which set-aside idea answers which symptom.

## Template

```
### YYYY-MM-DD — hotseat | online — who played
- Build: <Vercel link or commit>
- Result: <who won, how, round number>
- Felt like a race? <yes / no / why>
- Confusing: <anything a player didn't understand>
- Bugs: <anything broken>
- Rules concern: <none, or what and why>
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
- Note: **the 25 s order clock felt tight** ("hard to input all my orders in the allotted time"). Partly because one person was ordering for both seats; worth asking beta testers before changing `DEFAULT_TIMING.orderMs` in `server/lobby.ts`. The clock is a server setting, not a sim rule, so changing it does not reopen the freeze.
