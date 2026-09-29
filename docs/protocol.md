# Nuke Wars — network protocol

*Designed and built in V1.5 Session 6 (server, protocol and rooms). Sessions 7–8 add the timer, reconnect and hardening; their sections below say what is still to come.*

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
- **Closing:** when both seats are empty the room is deleted. (Session 7 keeps an empty room alive for a grace period so a player can reconnect.)
- The server tells each side `opponent { present }` whenever the other seat fills or empties.

## Messages
All messages are JSON text frames. `PROTOCOL_VERSION` is currently **1**.

### Browser → server

| Message | When | Example |
|---|---|---|
| `create` | open a room, take p1 | `{"type":"create","version":1}` |
| `join` | take the free seat in a room | `{"type":"join","version":1,"room":"WKXKBK"}` |
| `setup` | this seat's secret placements (spec §12) | `{"type":"setup","setup":[{"kind":"bunker","hex":{"q":12,"r":10}}, …]}` |
| `orders` | this seat's orders for the round (spec §3); `[]` holds everything | `{"type":"orders","orders":[{"type":"LAUNCH","unitId":"p1-launcher-2","target":{"q":6,"r":2}}]}` |
| `resign` | this seat capitulates (spec §4) | `{"type":"resign"}` |

**No message names a player.** A connection speaks for the seat the server gave it, so "act for the other seat" is not something the protocol can express.

### Server → browser

| Message | Meaning |
|---|---|
| `joined { room, seat, token, seed, map }` | You are in. The map is public (spec §11) and the same for both seats; `token` is kept for Session 7's reconnect. |
| `opponent { present }` | The other seat just filled (`true`) or emptied (`false`). |
| `update { update }` | A `MatchUpdate` for your seat only: `{ round, view, events, finalReveal }`, all already filtered. Sent when the match starts (no events), after every round, and on a resignation. `finalReveal` is null until `GAME_OVER`. |
| `error { code }` | See below. |

## Round timing
- A round resolves the moment **both** seats have sent `orders`. Until then the server just holds what arrived, which is what keeps orders simultaneous.
- In the browser, sending orders (or a setup) locks the board, and the button reads "waiting for your opponent", until the next `update` arrives.
- A seat with nothing to order (the opponent's dead-hand round, spec §3) sends `[]` automatically on receiving the update, or the round would wait on it forever.
- **Still to come (Session 7):** the 25 s order timer (time running out submits whatever is drafted) and ready-up.

## Reconnect
- **Session 6:** a token is issued per seat but not yet used. A browser that drops loses its seat for the rest of that match; the other side is told `opponent { present: false }`, and updates for the missing seat are dropped.
- **Still to come (Session 7):** the browser keeps the token; on reconnect it presents it and gets its view and whole event log back, and the room survives a short grace period with nobody in it.

## Errors and limits
| Code | Meaning |
|---|---|
| `BAD_MESSAGE` | Not JSON, or not a shape this protocol has (or an unexpected server fault, which is logged). |
| `VERSION_MISMATCH` | The page and the server were built from different protocol versions: reload. |
| `NO_SUCH_ROOM` | The link's room doesn't exist or has closed. |
| `ROOM_FULL` | Both seats are taken. |
| `NOT_IN_ROOM` / `ALREADY_IN_ROOM` | A game message before joining, or a second join. |
| `ILLEGAL_SETUP` | The setup broke a §12 placement rule for **this** seat. The browser unlocks and the player can try again. |

- **Shape vs rules.** `parseClientMessage` checks shape only (field types, integer hex coordinates, list sizes, id lengths) and rebuilds each message from its known fields, so extra fields never reach the game. Rules are checked by the sim's own validators: a setup by `validateSetup` for the sending seat, orders by `resolve()`, which silently drops illegal ones (an order naming the enemy's unit does nothing, gotcha 13).
- **Sizes:** 8 KB per message (enforced by `ws` before parsing), 8 placements, 16 orders, 32-character ids.
- **Crashes:** a thrown error inside one room is caught and logged, never allowed to take the process down; a socket `error` (such as an oversized frame) has a listener for the same reason.
- **Still to come (Session 8):** rate limits, idle-room expiry, origin checks, structured logging.

## Running it locally
1. `npm run server` — the match server on port 8787 (`npm run server:watch` restarts on file changes).
2. `npm run dev` in a second terminal — the site. In development it finds the server at port 8787 of the same machine automatically, and the title screen shows **Play online (test)**.
3. Click it, press **Copy link**, and open the link in a second browser window (or on another computer on the same Wi-Fi, using the Network address Vite prints — start Vite with `npm run dev -- --host`).

A production build has no online button until `VITE_SERVER_URL` is set (Session 8).
