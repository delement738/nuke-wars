# Nuke Wars — network protocol

*Skeleton from V1.5 Session 1. Designed and filled in Session 6 (server, protocol and rooms).*

## Principles (fixed now)
- **The server is the only holder of the unfiltered `GameState`.** It runs the same `resolve()` from `src/sim/` and sends each player only `filterForPlayer` / `filterEventsForPlayer` output. A client never receives the enemy's hidden positions, so cheating by reading network traffic is impossible by construction (spec §6).
- Orders are collected from both players, then resolved simultaneously; neither sees the other's orders first.
- No accounts: a room is a link, and a reconnect token held by the browser identifies a seat.

## The seam (from Session 5)
The client already talks to the match through `MatchAuthority` in `src/state/authority.ts`, and the protocol should be that interface on a wire:
- **Client → server:** `submitSetup(player, setup)`, `submitOrders(player, orders)`, `resign(player)`. Each client speaks only for its own seat; the server ignores a submission for another seat or at the wrong time.
- **Server → client:** a `MatchUpdate` for that client's seat only: `{ round, view, events, finalReveal }`, all already filtered. The opening update has no events; `finalReveal` is null until `GAME_OVER`.
- A round resolves once every seat has submitted. Things Session 6/7 must add that the local authority never needed: updates arrive asynchronously; the store's `views` is already `Partial` so it can hold one seat; a seat with nothing to order (the opponent's dead-hand round) must still submit, or the server must not wait for it; and the timer's "time ran out" becomes a submission of whatever is drafted.

## Rooms and seats
<!-- Create, join by link, seat assignment, what happens to a full room. -->

## Messages
<!-- Client → server and server → client message types, with example payloads. -->

## Round timing
<!-- 25 s order timer + ~5 s replay; ready-up; what happens when time runs out. -->

## Reconnect
<!-- Token lifetime, how a returning player gets their view and event log back. -->

## Errors and limits
<!-- Invalid orders, rate limits, room expiry. -->
