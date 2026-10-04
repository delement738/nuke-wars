// UI LAYER — the numbers behind the stat tab (2026-10-03).
//
// Pure functions, no React, so they can be tested on plain objects. Both read
// only what the viewer already has:
//
//   - **Your assets** come from your own units in your `VisibleGameState`.
//     Your own pieces are always visible to you (spec §11), destroyed ones
//     included — they stay in `units` flagged `destroyed`.
//   - **Confirmed kills** come from your own event log. `UNIT_DESTROYED` and
//     `DRONE_DOWNED` are public (spec §6), so every kill here is one the log
//     already shows. A hit that damages the enemy bunker without killing it is
//     NOT a kill and is not in your log at all — to the attacker it looks like
//     a miss, and this tally must not know better.
//
// Whose unit died is decided by looking the id up among YOUR units, never by
// reading the id string (see the header of `./eventText`).

import { UNIT_DEFS } from '../sim/defs';
import type { Hex } from '../sim/hex';
import type { PlayerId, Unit, UnitKind } from '../sim/types';
import type { LogEntry } from '../state/match';

/** Your side, as of the board on screen. */
export interface AssetTally {
  launchers: { alive: number; total: number };
  /** Hits the command bunker can still take; 0 once destroyed. */
  bunker: { hp: number; max: number };
  decoyAlive: boolean;
  baseAlive: boolean;
}

/** One enemy unit your side has destroyed, as the log reports it. */
export interface Kill {
  round: number;
  kind: UnitKind;
  hex: Hex;
}

export function tallyAssets(units: readonly Unit[], viewer: PlayerId): AssetTally {
  const own = units.filter((unit) => unit.owner === viewer);
  const launchers = own.filter((unit) => unit.kind === 'launcher');
  const bunker = own.find((unit) => unit.kind === 'bunker');
  const alive = (kind: UnitKind) =>
    own.some((unit) => unit.kind === kind && !unit.destroyed);

  return {
    launchers: {
      alive: launchers.filter((unit) => !unit.destroyed).length,
      total: launchers.length,
    },
    bunker: {
      hp: bunker && !bunker.destroyed ? bunker.hp : 0,
      max: UNIT_DEFS.bunker.hp,
    },
    decoyAlive: alive('decoy'),
    baseAlive: alive('interceptor'),
  };
}

/**
 * Every enemy unit the viewer's log reports destroyed, oldest first.
 *
 * `ownUnits` is how a wreck is told apart from an enemy one: any id that is not
 * yours is theirs. A drone shot down by your interceptor base counts — it
 * arrives as `DRONE_DOWNED` rather than `UNIT_DESTROYED`.
 */
export function confirmedKills(
  log: readonly LogEntry[],
  ownUnits: readonly Unit[],
  viewer: PlayerId,
): Kill[] {
  const mine = new Set(ownUnits.filter((unit) => unit.owner === viewer).map((unit) => unit.id));
  const kills: Kill[] = [];

  for (const { round, event } of log) {
    if (event.type === 'UNIT_DESTROYED' && !mine.has(event.unitId)) {
      kills.push({ round, kind: event.kind, hex: event.hex });
    } else if (event.type === 'DRONE_DOWNED' && event.owner !== viewer) {
      kills.push({ round, kind: 'drone', hex: event.hex });
    }
  }

  return kills;
}
