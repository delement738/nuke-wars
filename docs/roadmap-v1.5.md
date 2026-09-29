# Nuke Wars — V1.5 roadmap

**Agreed 2026-09-29.** Nine sessions, one system each, in this order. This file expands spec §8's V1.5 steps 11–13 (server, timer/reconnect, deploy) into sessions, and puts a cosmetics pass in front of them at the designer's request.

**The rules stay frozen for all of V1.5** (spec §8). No session here touches `src/sim/` except to fix a bug. The server in Sessions 6–8 runs the *same* `resolve()` and visibility filter the client runs today; that is what the four-layer architecture was built for.

When a session finishes: tick it here, add its dated entry to `docs/history.md`, and update "Current status" in `CLAUDE.md`.

## Decisions (designer's rulings, 2026-09-29)

| Question | Ruling |
|---|---|
| Hosting | **Vercel** for the static client; **Railway** for the Node WebSocket server (picked over Fly.io for simplicity). |
| Order of work | **Cosmetics first**, then networking. The game should look finished before strangers play it. |
| Round length | **25 s order timer + ~5 s replay ≈ 30 s a round.** |
| Devices | **Desktop and tablet only.** A phone gets a polite notice, not a squeezed board. |
| Accounts | **None.** A room is a link; a reconnect token in the browser gets you back into your seat. |
| Title art | The designer supplies the title-screen artwork (Session 2). |
| Match length | **`roundCap` stays 25** (≈12.5 min); real games have run up to ~20 rounds. |

## Open questions

- None.

**Settled 2026-09-29: match length stays at `RULES.roundCap` = 25** (≈12.5 minutes at ~30 s a round). The designer's "20" was how long their longest playtest games actually ran, not a different cap. No rules change; Session 7 builds the timer around 25.

## Sessions

### Part 1 — cosmetics (the game as it is today, looking finished)

1. ✅ **Live on Vercel + CI + docs skeleton** (2026-09-29). The current game (CPU + hotseat) deployed from `main`, with a preview link on every pull request. GitHub Actions runs lint, test and build on every PR. This roadmap, `docs/history.md` (the build history moved out of `CLAUDE.md`), and skeletons for `deploy.md`, `art-direction.md`, `protocol.md` and `playtests.md`.
2. **Identity: title screen and art direction.** Name treatment, palette, type, the title screen built around the designer's artwork. Writes `docs/art-direction.md`, which Sessions 3–4 follow.
3. **Board art, event log and end screen.** Terrain and piece styling to the art direction; the event log restyled; a proper end-of-match screen on top of the existing final reveal (gotcha 73). Presentation only; nothing new may leak (gotchas 20, 31, 60).
4. **Sound and settings.** Launch, intercept, impact and UI sounds; a settings panel (volume, mute, replay speed if wanted). Settings are per-browser, no accounts.

> **Gate: the designer's hotseat playtests** on the live Vercel build. Networking starts only after them. A real rules problem found here reopens the freeze on purpose, before the server is built on top of the rules.

### Part 2 — networking (spec §8 steps 11–13)

5. **Authority split refactor.** Separate "who resolves the match" from "who draws it", so the client can be fed by either the local store (CPU, hotseat) or a server. No behaviour change: CPU and hotseat play exactly as before, and the test suite proves it.
6. **Server, protocol and rooms** (spec step 11). A Node WebSocket server: create/join a room by link, collect both players' orders, run `resolve()` authoritatively, send each player only their filtered view. Writes `docs/protocol.md`.
7. **Order timer, reconnect and lobby UI** (spec step 12). The 25 s timer and ready-up, reconnect by token after a dropped connection, the lobby and "waiting for opponent" screens, the phone notice.
8. **Railway deploy and hardening** (spec step 13). The server live on Railway, the Vercel client pointed at it; message validation, rate limits, room cleanup, basic logging. Extends `docs/deploy.md`.
9. **Beta and launch.** Play with invited testers, fix what they find, write it up in `docs/playtests.md`, tag `v1.5`.
