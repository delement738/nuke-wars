// DEVELOPMENT TOOL — not shipped, not part of the game, not a unit test.
//
// The balance harness. Plays whole CPU-vs-CPU matches through the real
// `resolve()` loop and reports what actually happened, so that spec §7's
// standing caveat — "all numbers are untested first drafts" — becomes something
// you can put a number against instead of a guess.
//
//   npm run soak                    # default: 20 matches per pairing
//   SOAK_MATCHES=100 npm run soak   # more matches, slower, tighter numbers
//   SOAK_SEED=7 npm run soak        # a different family of boards
//
// It runs under Vitest because Vitest is already a dependency and the project
// has no TypeScript script runner; adding one would be a new dependency for a
// tool that needs none. `vitest.soak.config.ts` points at this file alone, which
// is also why this file is NOT named `*.test.ts` — `npm test` must stay fast and
// must never depend on a hundred simulated matches.
//
// **Why this file is allowed to hold an unfiltered `GameState` when
// `src/state/match.ts` is not** (CLAUDE.md gotchas 34/35). Measuring the game
// requires ground truth: "did anyone ever find the real bunker" is not a
// question any redacted view can answer. This is a measuring instrument outside
// `src/`, it renders nothing and returns nothing to the client, and — the part
// that matters — **the CPU players are still handed `filterForPlayer` output and
// nothing else**, exactly as the store hands it to them. The instrument sees
// through the fog; the players never do. Nothing here is a licence for anything
// under `src/` to do the same.

import { describe, it } from 'vitest';

import { RULES } from '../src/sim/defs';
import { hexKey, offsetToAxial } from '../src/sim/hex';
import { generateMap, makeRng, type MapData } from '../src/sim/map';
import { reconSwath } from '../src/sim/recon';
import { resolve } from '../src/sim/resolve';
import {
  PLACEMENT_ORDER,
  legalPlacementHexes,
  startMatch,
  type Placement,
  type PlayerSetup,
} from '../src/sim/setup';
import {
  PLAYERS,
  opponentOf,
  type GameEvent,
  type GameState,
  type Outcome,
  type PlayerId,
  type UnitId,
} from '../src/sim/types';
import { filterForPlayer } from '../src/sim/visibility';
import { cpuOrders, type CpuDifficulty } from '../src/state/cpu';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MATCHES = Number(process.env.SOAK_MATCHES ?? 20);
const BASE_SEED = Number(process.env.SOAK_SEED ?? 1);

/**
 * Which difficulty pairings to measure. Mirror matches only: the point is to
 * characterise how a tier *plays the game*, and a cross-tier match measures the
 * gap between two heuristics instead.
 */
const PAIRINGS: readonly CpuDifficulty[] = ['easy', 'medium', 'hard'];

/**
 * A match that somehow never terminates is a harness bug or an engine bug, and
 * either way an infinite loop is the worst way to find out. `RULES.roundCap`
 * plus the dead-hand round is the true maximum; this is comfortably above it.
 */
const ROUND_GUARD = RULES.roundCap * 4;

// ---------------------------------------------------------------------------
// Placement — deliberately randomised, unlike the sandbox fixture
// ---------------------------------------------------------------------------

/**
 * A legal secret setup with the assets placed at random, mirroring the walk in
 * `src/state/sandbox.ts` but choosing each hex with `rng` instead of a fixed
 * fraction of the legal list.
 *
 * The duplication is on purpose. `sandboxSetup` is deterministic by design — a
 * sandbox you cannot re-run twice is a bad debugging tool — but that makes the
 * bunker land in the *same relative spot* on every board, and a harness built on
 * it would measure how well the CPU finds that one spot rather than how well it
 * searches. Randomising placement is the difference between measuring the game
 * and measuring the fixture.
 *
 * What it does NOT do is invent its own idea of legality: every hex comes out of
 * `legalPlacementHexes`, the same §12 validator the setup UI will highlight
 * with, so this cannot drift from the rules.
 */
function randomSetup(map: MapData, player: PlayerId, rng: () => number): PlayerSetup {
  const placed: Placement[] = [];

  for (const kind of PLACEMENT_ORDER) {
    for (let i = 0; i < RULES.placementCounts[kind]; i++) {
      const legal = legalPlacementHexes(map, player, kind, placed);
      if (legal.length === 0) {
        throw new Error(`soak: no legal hex for ${player}'s ${kind} #${i + 1}`);
      }
      placed.push({ kind, hex: legal[Math.floor(rng() * legal.length)] });
    }
  }

  return placed;
}

// ---------------------------------------------------------------------------
// What one match tells us
// ---------------------------------------------------------------------------

interface PlayerStats {
  /** Share of the ENEMY home zone this player's drone ever photographed. */
  sweptFraction: number;
  /** Round a bunker-or-decoy site first entered their intel, or null. */
  firstSiteRound: number | null;
  droneDeaths: number;
  missilesFired: number;
  missilesIntercepted: number;
  /**
   * Missiles aimed at a hex this player already knew held a bunker or decoy.
   *
   * The single most diagnostic number here: it separates "the CPU never finds
   * the bunker" from "the CPU finds it and never shoots at it", which are
   * completely different defects with completely different fixes.
   */
  missilesAtSites: number;
  /** Hits landed on the enemy's REAL bunker (§12: the decoy never emits one). */
  bunkerHits: number;
  decoysKilled: number;
  launchersKilled: number;
  basesKilled: number;
}

interface MatchStats {
  outcome: Outcome['type'] | 'UNFINISHED';
  /** Who won, or null for any of the four draws (spec §4). */
  winner: PlayerId | null;
  rounds: number;
  players: Record<PlayerId, PlayerStats>;
}

function emptyStats(): PlayerStats {
  return {
    sweptFraction: 0,
    firstSiteRound: null,
    droneDeaths: 0,
    missilesFired: 0,
    missilesIntercepted: 0,
    missilesAtSites: 0,
    bunkerHits: 0,
    decoysKilled: 0,
    launchersKilled: 0,
    basesKilled: 0,
  };
}

/** Every hex of `player`'s home zone (spec §7) — the ground their drone must search. */
function homeZoneKeys(player: PlayerId, width: number): Set<string> {
  const zone = RULES.homeZoneRows[player];
  const keys = new Set<string>();
  for (let col = 0; col < width; col++) {
    for (let row = zone.min; row <= zone.max; row++) {
      keys.add(hexKey(offsetToAxial({ col, row })));
    }
  }
  return keys;
}

/** Hexes a player currently knows hold a bunker or a decoy (spec §11 static reveals). */
function knownSiteKeys(state: GameState, player: PlayerId): Set<string> {
  return new Set(
    state.intel[player].staticReveals
      .filter((r) => r.kind === 'bunker' || r.kind === 'decoy')
      .map((r) => hexKey(r.hex)),
  );
}

// ---------------------------------------------------------------------------
// One match
// ---------------------------------------------------------------------------

function playMatch(seed: number, difficulty: Record<PlayerId, CpuDifficulty>): MatchStats {
  const map = generateMap(undefined, undefined, seed);
  const setupRng = makeRng(seed);

  let state: GameState = startMatch(map, {
    p1: randomSetup(map, 'p1', setupRng),
    p2: randomSetup(map, 'p2', setupRng),
  });

  // Fixed for the whole match: units are never added or removed, only flagged
  // destroyed, so one snapshot answers "whose unit is this?" for every event.
  const ownerOf = new Map<UnitId, PlayerId>(state.units.map((u) => [u.id, u.owner]));

  const enemyZone: Record<PlayerId, Set<string>> = {
    p1: homeZoneKeys('p2', map.width),
    p2: homeZoneKeys('p1', map.width),
  };
  const swept: Record<PlayerId, Set<string>> = { p1: new Set(), p2: new Set() };
  const stats: Record<PlayerId, PlayerStats> = { p1: emptyStats(), p2: emptyStats() };

  let rounds = 0;
  let guard = 0;

  while (state.phase !== 'GAME_OVER' && guard++ < ROUND_GUARD) {
    const round = state.round;
    rounds = round;

    // Snapshots taken BEFORE resolution, because both answer questions about
    // what the firing player knew at the moment they committed the order.
    const sitesKnown: Record<PlayerId, Set<string>> = {
      p1: knownSiteKeys(state, 'p1'),
      p2: knownSiteKeys(state, 'p2'),
    };
    // A ground hex holds at most one unit (spec §9), so a launcher's hex
    // identifies it uniquely — which is how a LAUNCH_DETECTED event, that
    // deliberately carries no owner and no unit id (§6), gets attributed here.
    const launcherAt = new Map<string, PlayerId>();
    for (const unit of state.units) {
      if (unit.kind === 'launcher' && !unit.destroyed) {
        launcherAt.set(hexKey(unit.position), unit.owner);
      }
    }

    const orders: Record<PlayerId, ReturnType<typeof cpuOrders>> = { p1: [], p2: [] };
    for (const player of PLAYERS) {
      // The players get the redacted view and nothing else — see the header.
      //
      // The two sides get DIFFERENT rng streams. Seeding both from
      // `seed + round` alone (as the store does for its single CPU) hands them
      // identical random sequences, which for EASY — the one tier that actually
      // rolls dice — makes the two players mirror each other's coin flips and
      // quietly halves the sample.
      orders[player] = cpuOrders(
        filterForPlayer(state, player),
        difficulty[player],
        player,
        makeRng(seed * 100000 + round * 2 + (player === 'p1' ? 0 : 1)),
      );
    }

    const result = resolve(state, orders.p1, orders.p2, seed);
    tally(result.events, stats, swept, enemyZone, sitesKnown, launcherAt, ownerOf);

    state = result.state;

    for (const player of PLAYERS) {
      if (stats[player].firstSiteRound === null && knownSiteKeys(state, player).size > 0) {
        stats[player].firstSiteRound = round;
      }
    }
  }

  for (const player of PLAYERS) {
    stats[player].sweptFraction = swept[player].size / enemyZone[player].size;
  }

  const outcome = state.outcome;
  return {
    outcome: outcome?.type ?? 'UNFINISHED',
    // Only three of §4's outcomes name a winner; the rest are draws. Reading the
    // field off the union rather than listing the winning types means a new
    // outcome cannot be silently miscounted as a draw.
    winner: outcome && 'winner' in outcome ? outcome.winner : null,
    rounds,
    players: stats,
  };
}

/** Fold one resolution's event log into the running per-player counters. */
function tally(
  events: readonly GameEvent[],
  stats: Record<PlayerId, PlayerStats>,
  swept: Record<PlayerId, Set<string>>,
  enemyZone: Record<PlayerId, Set<string>>,
  sitesKnown: Record<PlayerId, Set<string>>,
  launcherAt: ReadonlyMap<string, PlayerId>,
  ownerOf: ReadonlyMap<UnitId, PlayerId>,
): void {
  // Missiles carry no owner (§6 withholds it deliberately), so attribution runs
  // origin hex -> firing player for the launch, then missile id -> player for
  // everything that happens to it afterwards.
  const firedBy = new Map<string, PlayerId>();

  for (const event of events) {
    switch (event.type) {
      case 'DRONE_MOVED': {
        for (const key of reconSwath(event.path)) {
          if (enemyZone[event.owner].has(key)) swept[event.owner].add(key);
        }
        break;
      }

      case 'DRONE_DOWNED':
        stats[event.owner].droneDeaths += 1;
        break;

      case 'LAUNCH_DETECTED': {
        const firer = launcherAt.get(hexKey(event.origin));
        if (!firer) break; // unreachable: something fired from an empty hex
        firedBy.set(event.missileId, firer);
        stats[firer].missilesFired += 1;
        if (sitesKnown[firer].has(hexKey(event.target))) {
          stats[firer].missilesAtSites += 1;
        }
        break;
      }

      case 'MISSILE_INTERCEPTED': {
        const firer = firedBy.get(event.missileId);
        if (firer) stats[firer].missilesIntercepted += 1;
        break;
      }

      case 'BUNKER_HIT':
        // `owner` is the victim; the hit is the ATTACKER's achievement.
        stats[opponentOf(event.owner)].bunkerHits += 1;
        break;

      case 'UNIT_DESTROYED': {
        const victim = ownerOf.get(event.unitId);
        if (!victim) break;
        const killer = opponentOf(victim);
        if (event.kind === 'decoy') stats[killer].decoysKilled += 1;
        if (event.kind === 'launcher') stats[killer].launchersKilled += 1;
        if (event.kind === 'interceptor') stats[killer].basesKilled += 1;
        // A destroyed real bunker also produced the second BUNKER_HIT... no: the
        // killing hit destroys rather than damages, so it emits UNIT_DESTROYED
        // and no BUNKER_HIT. `bunkerHits` therefore counts survivable hits only,
        // which is exactly what "did anyone ever damage the real thing" means.
        if (event.kind === 'bunker') stats[killer].bunkerHits += 1;
        break;
      }

      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function report(difficulty: CpuDifficulty, matches: readonly MatchStats[]): string {
  const outcomes = new Map<string, number>();
  for (const m of matches) outcomes.set(m.outcome, (outcomes.get(m.outcome) ?? 0) + 1);

  // Both sides of a mirror match are independent samples of the same heuristic,
  // so per-player stats are pooled rather than averaged per match.
  const sides = matches.flatMap((m) => PLAYERS.map((p) => m.players[p]));
  const sawSite = sides.filter((s) => s.firstSiteRound !== null);

  const lines = [
    ``,
    `=== ${difficulty} vs ${difficulty} — ${matches.length} matches, seeds ${BASE_SEED}..${BASE_SEED + matches.length - 1} ===`,
    `  outcomes            ${[...outcomes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  ')}`,
    `  mean rounds         ${mean(matches.map((m) => m.rounds)).toFixed(1)} / ${RULES.roundCap} cap`,
    ``,
    `  RECON`,
    `    enemy home zone photographed   ${pct(mean(sides.map((s) => s.sweptFraction)))}`,
    `    sides that ever found a site   ${sawSite.length}/${sides.length}`,
    `    mean round of first site       ${sawSite.length ? mean(sawSite.map((s) => s.firstSiteRound!)).toFixed(1) : '—'}`,
    `    drone deaths per side          ${mean(sides.map((s) => s.droneDeaths)).toFixed(1)}`,
    ``,
    `  OFFENSE (per side, per match)`,
    `    missiles fired                 ${mean(sides.map((s) => s.missilesFired)).toFixed(1)}`,
    `    ... intercepted                ${mean(sides.map((s) => s.missilesIntercepted)).toFixed(1)}`,
    `    ... aimed at a known site      ${mean(sides.map((s) => s.missilesAtSites)).toFixed(1)}`,
    `    hits on the real bunker        ${mean(sides.map((s) => s.bunkerHits)).toFixed(2)}`,
    `    decoys killed                  ${mean(sides.map((s) => s.decoysKilled)).toFixed(2)}`,
    `    launchers killed               ${mean(sides.map((s) => s.launchersKilled)).toFixed(2)}`,
    `    bases killed                   ${mean(sides.map((s) => s.basesKilled)).toFixed(2)}`,
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Are the difficulty tiers actually ordered? A mirror match cannot say — it
 * measures how a tier plays, not whether it beats another one — and the mirror
 * numbers alone are genuinely ambiguous, since a tier can convert its advantage
 * into a different §4 outcome rather than into more wins.
 *
 * Each pairing is played BOTH WAYS over the same seeds, so a seat advantage (or
 * a bug that gives one) cancels instead of being reported as skill.
 */
function headToHead(a: CpuDifficulty, b: CpuDifficulty): string {
  const wins: Record<CpuDifficulty, number> = { easy: 0, medium: 0, hard: 0 };
  let draws = 0;

  for (let i = 0; i < MATCHES; i++) {
    const seed = BASE_SEED + i;
    for (const [p1, p2] of [
      [a, b],
      [b, a],
    ] as const) {
      const match = playMatch(seed, { p1, p2 });
      if (match.winner === null) draws += 1;
      else wins[match.winner === 'p1' ? p1 : p2] += 1;
    }
  }

  const total = MATCHES * 2;
  return (
    `  ${a} vs ${b}`.padEnd(24) +
    `${a} ${wins[a]}`.padEnd(12) +
    `${b} ${wins[b]}`.padEnd(12) +
    `draw ${draws}`.padEnd(12) +
    `(${total} matches, both seats)`
  );
}

describe('soak', () => {
  it(`plays ${MATCHES} matches per difficulty and reports the balance picture`, () => {
    const out: string[] = [];

    for (const difficulty of PAIRINGS) {
      const matches: MatchStats[] = [];
      for (let i = 0; i < MATCHES; i++) {
        matches.push(playMatch(BASE_SEED + i, { p1: difficulty, p2: difficulty }));
      }
      out.push(report(difficulty, matches));
    }

    out.push('', '=== head to head — is each tier actually stronger than the one below? ===');
    for (let i = 0; i < PAIRINGS.length; i++) {
      for (let j = i + 1; j < PAIRINGS.length; j++) {
        out.push(headToHead(PAIRINGS[j], PAIRINGS[i]));
      }
    }

    console.log(`${out.join('\n')}\n`);
  });
});
