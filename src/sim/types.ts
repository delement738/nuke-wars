// PURE SIMULATION CODE — no React or Pixi imports allowed in src/sim/, ever.
//
// Core data shapes for the simulation engine (docs/nuke-wars-v1-spec.md §6-8,
// build-order step 2). These are the vocabulary resolve() will operate on:
//   resolve(state: GameState, ordersP1: Order[], ordersP2: Order[], seed: number)
//     -> { state: GameState, events: GameEvent[] }
//
// Positions use axial hex coordinates (Hex, from ./hex) — not the map's
// render-side col/row offset coordinates (TileData, from ./map). The sim
// reasons in the coordinate system distance()/neighbors()/hexesInRange()
// already understand. Converting a tile's col/row into a Hex is logic we'll
// add in the movement session, not a type.

import type { Hex } from './hex';
import type { MapData } from './map';

export type PlayerId = 'p1' | 'p2';

export type UnitId = string;

/** The four unit kinds in V1's roster (spec §2). */
export type UnitKind = 'launcher' | 'radar' | 'interceptor' | 'leader';

export type MissileType = 'SRM' | 'MRM';

/**
 * A single piece on the board. Deliberately one generic shape rather than a
 * subtype per kind — per-kind stats (movement points, ammo, detection
 * radius...) belong in a data table keyed by `kind`, not hardcoded fields
 * here (CLAUDE.md's data-table rule). That table arrives with the logic
 * that reads it (movement/launch/interception sessions).
 *
 * OPEN QUESTION: the spec gives the Leader bunker maxHp = 2 ("2 penetrating
 * hits"), but doesn't state hp for launcher/radar/interceptor. Modeling hp
 * generically here so it works either way; we'll pin the actual numbers down
 * (probably 1 = destroyed by any impact) when we build the damage table.
 */
export interface Unit {
  id: UnitId;
  owner: PlayerId;
  kind: UnitKind;
  position: Hex;
  hp: number;
  maxHp: number;
  destroyed: boolean;
}

export interface MissileStock {
  SRM: number;
  MRM: number;
}

/**
 * A player's queued intent for one round. Up to 4 per round (spec §7) — that
 * cap is a runtime rule to enforce, not something the type itself encodes.
 */
export type Order =
  | { type: 'MOVE'; unitId: UnitId; destination: Hex }
  | { type: 'LAUNCH'; unitId: UnitId; missile: MissileType; target: Hex }
  | { type: 'RECON'; center: Hex };

export type GamePhase =
  | 'ORDER_PHASE'
  | 'RESOLUTION'
  | 'DEAD_HAND_PHASE'
  | 'GAME_OVER';

/** Mirrors spec §4's outcome table, in priority order. Provisional — likely
 * to be revised once we implement win-condition checks. */
export type Outcome =
  | { type: 'DECAPITATION'; winner: PlayerId }
  | { type: 'DISARMAMENT'; winner: PlayerId }
  | { type: 'CAPITULATION'; winner: PlayerId }
  | { type: 'MUTUAL_ANNIHILATION' }
  | { type: 'ARMISTICE' };

/**
 * The single source of truth resolve() operates on — the *full* state, both
 * players' true positions, no fog applied. filterForPlayer() (a later,
 * separate step) derives what each player is allowed to see from this.
 */
export interface GameState {
  round: number;
  phase: GamePhase;
  map: MapData;
  units: Unit[];
  missileStock: Record<PlayerId, MissileStock>;
  reconSweepsRemaining: Record<PlayerId, number>;
  outcome: Outcome | null;
}

/**
 * Ordered log resolve() emits alongside the new GameState. Clients animate
 * from this, never by diffing before/after state (CLAUDE.md's event-log
 * rule). Also doubles as the future replay format.
 */
export type GameEvent =
  | { type: 'UNIT_MOVED'; unitId: UnitId; from: Hex; to: Hex }
  | {
      type: 'LAUNCH_DETECTED';
      unitId: UnitId;
      origin: Hex;
      missile: MissileType;
      target: Hex;
    }
  | {
      type: 'INTERCEPT_ATTEMPT';
      unitId: UnitId;
      target: Hex;
      interceptorId: UnitId;
      success: boolean;
    }
  | { type: 'IMPACT'; target: Hex; unitId: UnitId | null; damage: number }
  | { type: 'UNIT_DESTROYED'; unitId: UnitId }
  | { type: 'LEADER_KILLED'; playerId: PlayerId }
  | { type: 'RECON_SWEEP'; playerId: PlayerId; center: Hex }
  | { type: 'GAME_OVER'; outcome: Outcome };
