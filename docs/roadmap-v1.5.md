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
2. ✅ **Identity: title screen and art direction** (2026-09-29). A title screen with the stencilled name and tagline over a war map that slides left at 20 px/s, drawn from the game's own emblems in the style of the designer's reference art; favicon and page title; `docs/art-direction.md` written for Sessions 3–4. The phone notice was pulled forward from Session 7 onto the title screen.
3. ✅ **Board art, event log and end screen** (2026-09-29). The board is the paper plotting table (designer's pick over a dark board): paper plains, khaki hills with peak symbols, colours retuned for a light map in one shared `src/render/palette.ts`; panels and the log restyled as bunker consoles; the game-over report drawn as a full end screen (verdict, reveal, play again, title). Presentation only; no new information on screen.
4. ✅ **Sound and settings** (2026-09-29). Sounds generated in code with Web Audio (designer's pick over sound files): teletype clicks for the UI, a klaxon sting for launches, a muffled thump for impacts, a relay click for intercepts, all timed from the replay. A speaker button beside every `?` and on the title screen opens volume and mute (`M` mutes anywhere); saved per browser. Replay speed was not wanted.

> **Gate: the designer's hotseat playtests** on the live Vercel build. Networking starts only after them. A real rules problem found here reopens the freeze on purpose, before the server is built on top of the rules.
>
> ✅ **Passed 2026-09-29** on the designer's games against the CPU on the live build ("it's good"); no hotseat games were played, and no rules problem was found. See `docs/playtests.md`.

### Part 2 — networking (spec §8 steps 11–13)

5. ✅ **Authority split refactor** (2026-09-29). The match now lives in `src/state/authority.ts`: a `MatchAuthority` takes each seat's setup, orders and resignation, runs `startMatch`/`resolve()`/the CPU, and sends each player a filtered `MatchUpdate`. The store only drafts, draws and passes the screen. `createLocalAuthority` serves solo and hotseat today; Session 6 swaps in a server behind the same three calls. No behaviour change: a whole CPU match through the store matches the engine driven directly (and did before the split too).
6. ✅ **Server, protocol and rooms** (2026-09-29; spec step 11). A Node WebSocket server (`server/`, run with `npm run server`) hosts each room with the same `createLocalAuthority` solo uses, both seats human, and routes each seat's filtered update to that seat's connection only. Create a room, share the `?room=CODE` link, play. The browser side is `src/net/connection.ts`, a `MatchAuthority` over the socket; the protocol is `src/net/protocol.ts` and `docs/protocol.md`. A bare-bones "Play online (test)" button appears in development only; the live site is unchanged until Session 8. New dependencies (designer approved): `ws`, `@types/ws`, `tsx`.
7. ✅ **Order timer, reconnect and lobby UI** (2026-09-30; spec step 12). The server runs a 25 s order clock (+5 s when the last round had a replay) and sends an empty turn for a seat that never orders, so nobody can stall a match; the browser counts the deadline down and sends its draft at zero. A seat belongs to its token: a dropped connection retries by itself and a reloaded tab rejoins from `sessionStorage`, both rebuilt from a filtered `snapshot`; an empty room is kept for 2 minutes. A waiting-room screen (room code, link, copy) replaces the bare test panel. Protocol version 2. (The phone notice was done early, in Session 2.)
8. ✅ **Railway deploy and hardening** (2026-09-30; spec step 13). The server live on Railway, the Vercel client pointed at it; message validation, rate limits, room cleanup, basic logging. Extends `docs/deploy.md`.
9. **Beta and launch.** Play with invited testers, fix what they find, write it up in `docs/playtests.md`, tag `v1.5`.
