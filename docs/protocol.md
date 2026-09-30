# Nuke Wars — network protocol

*Designed and built in V1.5 Session 6 (server, protocol and rooms); Session 7 added the order clock, reconnect and the waiting room. Session 8 adds hardening; its section below says what is still to come.*

## Principles
- **The server is the only holder of the unfiltered `GameState`.** It runs the same `resolve()` from `src/sim/` and sends each player only `filterForPlayer` / `filterEventsForPlayer` output. A client never receives the enemy's hidden positions, so cheating by reading network traffic is impossible by construction (spec §6). `server/lobby.test.ts` checks this on the actual bytes: across a whole match, no enemy unit id reaches a browser except inside the two public events that name a unit (`UNIT_DESTROYED`, `DRONE_DOWNED`) or the end-of-match reveal.
- Orders are collected from both players, then resolved simultaneously; neither sees the other's orders first.
- No accounts: a room is a link, and a reconnect token held by the browser identifies a seat.

## How it fits together

```
browser (store)  ──  src/net/connection.ts  ══ WebSocket ══  server/server.ts  ──  server/lobby.ts  ──  createLocalAuthority
   match.ts            (a MatchAuthority)                     (bytes only)          (rooms, routing)     (the same code solo uses)
```

- **The protocol is `MatchAuthority` on a wire** (gotcha 77). The store's three calls (`submitSetup`, `submitOrders`, `resign`) become three client messages; the authority's `MatchUpdate` becomes the `update` message.
- **The server hosts the match; it does not re-implement it.** Each room runs `createLocalAuthority` with both seats `'human'`, and `lobby.ts` sends `updates.p1` to seat p1's connection and `updates.p2` to seat p2's. That one routing line is where "each player gets only their own view" happens.
- **In the browser**, an online match is the seating `onlineSeats(seat)`: this browser's seat is `'human'`, the other is `'remote'`. Every store rule about "humans at this screen" (drafting, handoff) therefore applies to this browser's player only.
- Shared code: `src/net/protocol.ts` holds the message types and the parser both ends use. It imports only types from the game.

## Rooms and seats
- **Create:** the browser sends `create`. The server picks a map seed, opens a room with a 6-character code (letters and digits without 0/O/1/I), and seats the creator as **p1** (south).
- **Join:** the link is the site's address plus `?room=CODE`. Opening it skips the title screen and sends `join`. The free seat (p2) is taken; codes are matched case-insensitively.
- **Full room:** a third browser gets `ROOM_FULL`. **A seat stays reserved after its browser leaves** — it belongs to whoever holds that seat's token, not to the next person with the link.
- **Closing:** when both seats are empty the room is kept for a **grace period (2 minutes)** and then deleted; anyone coming back with a token inside it saves the room. No order clock runs in an empty room, so nobody plays a match out alone.
- The server tells each side `opponent { present }` whenever the other seat fills or empties.

## Messages
All messages are JSON text frames. `PROTOCOL_VERSION` is currently **3** (Session 7 added `token` to `join`, and `snapshot`, `timer` and two fields on `joined`; Session 8 added the `RATE_LIMITED` and `SERVER_FULL` errors).

### Browser → server

| Message | When | Example |
|---|---|---|
| `create` | open a room, take p1 | `{"type":"create","version":3}` |
| `join` | take the free seat in a room — or, with `token`, take back the seat that token belongs to | `{"type":"join","version":3,"room":"WKXKBK","token":"…"}` |
| `setup` | this seat's secret placements (spec §12) | `{"type":"setup","setup":[{"kind":"bunker","hex":{"q":12,"r":10}}, …]}` |
| `orders` | this seat's orders for the round (spec §3); `[]` holds everything | `{"type":"orders","orders":[{"type":"LAUNCH","unitId":"p1-launcher-2","target":{"q":6,"r":2}}]}` |
| `resign` | this seat capitulates (spec §4) | `{"type":"resign"}` |

**No message names a player.** A connection speaks for the seat the server gave it, so "act for the other seat" is not something the protocol can express.

### Server → browser

| Message | Meaning |
|---|---|
| `joined { room, seat, token, seed, map, resumed, submitted }` | You are in. The map is public (spec §11) and the same for both seats; `token` is kept by the browser to take the seat back. `resumed` is true when a presented token brought you back into your seat; `submitted` is whether the seat has already handed in what is owed now (its setup, or this round's orders). |
| `snapshot { view, log, finalReveal }` | Sent right after `joined` to a **resumed** seat once a match is running: the board as this seat may see it now, this seat's whole event log (`[{round, events}]`), and the reveal if the match is over. Rebuilt from the very updates the seat was sent live, so a reconnect can never show more than playing on would have. |
| `timer { msLeft }` | The order clock: milliseconds left to send this round's orders, or `null` when no clock runs (setup, match over). A duration, not a wall-clock time, so a wrong computer clock cannot skew it. Sent with every update, and on (re)joining. |
| `opponent { present }` | The other seat just filled (`true`) or emptied (`false`). |
| `update { update }` | A `MatchUpdate` for your seat only: `{ round, view, events, finalReveal }`, all already filtered. Sent when the match starts (no events), after every round, and on a resignation. `finalReveal` is null until `GAME_OVER`. |
| `error { code }` | See below. |

## Round timing
- A round resolves the moment **both** seats have sent `orders`. Until then the server just holds what arrived, which is what keeps orders simultaneous.
- In the browser, sending orders (or a setup) locks the board, and the button reads "waiting for your opponent", until the next `update` arrives.
- A seat with nothing to order (the opponent's dead-hand round, spec §3) sends `[]` automatically on receiving the update, or the round would wait on it forever.

## The order clock (Session 7)
- **25 s to order, plus 5 s for the replay** when the last round had anything in it, so a busy round gives 30 s and a silent one 25 s. It starts when the match starts and after every resolution; there is none in setup (a setup is the ready-up: "Send setup", then wait) and it stops at game over.
- **The browser sends first.** At zero the browser sends whatever is drafted, exactly as "Send orders" would (unordered units hold). The server's own clock runs **3 s longer** (`graceMs`), so that message normally arrives first; if the browser is closed or cut off, the server then submits an **empty turn** for each seat that still owes one, and the round resolves. A player who has gone therefore cannot stall the other.
- **Timings are data** (`Timing` in `server/lobby.ts`: `orderMs`, `replayMs`, `graceMs`, `roomGraceMs`) and tests inject short ones.

## Reconnect (Session 7)
- **The seat belongs to its token.** The browser keeps `{room, token}` in `sessionStorage` (one tab's worth: two tabs on one computer hold two seats). Presenting the token in `join` takes the seat back even if the server has not yet noticed the old connection die; the old connection is replaced, and its later `close` cannot unseat the new one.
- **Two ways back.** A dropped link is retried by the connection itself (0.5 s, doubling to 5 s, for up to 100 s — inside the server's 2-minute grace) while the board is locked and says so; drafts survive. A reloaded tab reads the saved seat on load and rejoins without the title screen. Either way the server sends `joined { resumed: true }` then `snapshot`; a brief wobble that missed no round changes nothing on screen, and one that missed rounds replaces the view and log outright (no replay for a round you were not there to watch; a match that ended meanwhile still gets its end screen).
- **What is not restored:** a half-drafted order after a *reload* (the draft lives only in the tab). The server tracks only whether the seat had already *submitted*, and `joined.submitted` says so.
- **Gives up when** the server answers a rejoin with an error (room gone, protocol changed) or the retries run out; the saved seat is then dropped. Leaving the room, or a finished match, also drops it.
- **Half-open connections (Session 8).** The server pings every connection every 30 s; a browser answers by itself, and one that has not answered by the next ping (a laptop that slept, a phone that lost signal) is cut. Its seat is then empty like any other dropped seat, so the order clock and the room's grace period take over. The pings also keep the host's proxy from closing a connection that has gone quiet between rounds.

## Errors and limits
| Code | Meaning |
|---|---|
| `BAD_MESSAGE` | Not JSON, or not a shape this protocol has (or an unexpected server fault, which is logged). |
| `VERSION_MISMATCH` | The page and the server were built from different protocol versions: reload. |
| `NO_SUCH_ROOM` | The link's room doesn't exist or has closed. |
| `ROOM_FULL` | Both seats are taken (and the token, if any, matched neither). |
| `NOT_IN_ROOM` / `ALREADY_IN_ROOM` | A game message before joining, or a second join. |
| `ILLEGAL_SETUP` | The setup broke a §12 placement rule for **this** seat. The browser unlocks and the player can try again. |
| `RATE_LIMITED` | Too many messages too fast on this connection, or too many new rooms from this address (Session 8). |
| `SERVER_FULL` | The server already holds its maximum number of rooms; joining an existing room still works (Session 8). |

- **Shape vs rules.** `parseClientMessage` checks shape only (field types, integer hex coordinates, list sizes, id lengths) and rebuilds each message from its known fields, so extra fields never reach the game. Rules are checked by the sim's own validators: a setup by `validateSetup` for the sending seat, orders by `resolve()`, which silently drops illegal ones (an order naming the enemy's unit does nothing, gotcha 13).
- **Sizes:** 8 KB per message (enforced by `ws` before parsing), 8 placements, 16 orders, 32-character ids.
- **Crashes:** a thrown error inside one room is caught and logged, never allowed to take the process down; a socket `error` (such as an oversized frame) has a listener for the same reason.

### Limits for a public server (Session 8)
The rules live in `server/guard.ts` (pure, tested with plain numbers) and are applied in two places: `server/server.ts` at the door, before a WebSocket exists, and `server/lobby.ts` per message. The numbers are `DEFAULT_LIMITS` and `DEFAULT_TIMING` (designer's approval, 2026-09-30); an honest match sends a message every few seconds at most, so none of them is ever near.

| Limit | Value | What happens |
|---|---|---|
| **Origin** | the sites in `ALLOWED_ORIGINS` (`*` matches any run of characters, never a `/`) | Any other page is refused with HTTP 403 before the handshake completes. Unset means no check (local development). A browser cannot fake its page's origin, so this stops another website from opening games from its visitors' browsers; a script outside a browser can send any origin, which is what the limits below are for. |
| **Connections per address** | 8 open at once | HTTP 429. Behind Railway the address is the **last** entry of `X-Forwarded-For` (the one the proxy wrote; earlier ones could be made up), and only when `TRUST_PROXY=1`. |
| **Messages per connection** | a burst of 20, refilling at 5 per second | Past it, messages are dropped and `RATE_LIMITED` is sent once; 20 more dropped and the connection is cut. Counted before parsing, so junk costs its sender too. |
| **New rooms per address** | 10 per minute | `RATE_LIMITED`. |
| **Rooms on the server** | 500 | `SERVER_FULL` on `create`; `join` still works. |
| **A finished match's room** | kept 5 min after the end | Then it leaves the room list (a late `join` gets `NO_SUCH_ROOM`) **without** cutting anyone, so the end screen stays up. |
| **Any room** | 2 hours | Closed and its connections cut; their retries get `NO_SUCH_ROOM`. A match with the order clock lasts well under an hour, so this only catches rooms left in setup, which has no clock. |

- **Logging.** One line per event, stamped with the time (`server/main.ts`): rooms opening and closing (and why), seats timing out, connections cut for flooding (with their address), socket errors. Refusals are **counted, not logged one by one** (a flood of refusals must not become a flood of log lines), and a `stats:` line every 5 minutes reports rooms, connections and every refusal count since start.
- **Shutting down.** On `SIGTERM` (Railway sends it during a redeploy) the server closes every room and connection and exits within 5 seconds. **Matches live only in the server's memory, so a redeploy ends every match in progress**; browsers retry, get `NO_SUCH_ROOM` from the new server, and say the room has closed. Railway only redeploys when a file the server uses changes (`watchPatterns` in `railway.json`), not for client-only changes.

## Running it locally
1. `npm run server` — the match server on port 8787 (`npm run server:watch` restarts on file changes).
2. `npm run dev` in a second terminal — the site. In development it finds the server at port 8787 of the same machine automatically, and the title screen shows **Play online (test)**.
3. Click it, press **Copy link**, and open the link in a second browser window (or on another computer on the same Wi-Fi, using the Network address Vite prints — start Vite with `npm run dev -- --host`).

A production build has no online button unless `VITE_SERVER_URL` is set; on Vercel it points at the Railway server (`docs/deploy.md`, Part 2). Locally, no origin list is set, so any page may connect.
