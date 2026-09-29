# Nuke Wars — network protocol

*Skeleton from V1.5 Session 1. Designed and filled in Session 6 (server, protocol and rooms).*

## Principles (fixed now)
- **The server is the only holder of the unfiltered `GameState`.** It runs the same `resolve()` from `src/sim/` and sends each player only `filterForPlayer` / `filterEventsForPlayer` output. A client never receives the enemy's hidden positions, so cheating by reading network traffic is impossible by construction (spec §6).
- Orders are collected from both players, then resolved simultaneously; neither sees the other's orders first.
- No accounts: a room is a link, and a reconnect token held by the browser identifies a seat.

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
