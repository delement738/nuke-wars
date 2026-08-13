import { beforeEach, describe, expect, it } from 'vitest';
import { axialToOffset, hexKey, offsetToAxial } from '../sim/hex';
import { PLAYERS, type Order, type PlayerId, type VisibleEvent } from '../sim/types';
import {
  DEFAULT_DIFFICULTY,
  SANDBOX_DUMMY,
  SANDBOX_PLAYER,
  clearDraft,
  clearOrder,
  holdUnit,
  logFor,
  matchStore,
  newMatch,
  pickHex,
  resign,
  resolveRound,
  selectHex,
  selectUnit,
  setDifficulty,
  setOrder,
  setOrderMode,
  setViewer,
  viewFor,
} from './match';
import {
  flyTargets,
  launchTargets,
  moveTargets,
  orderFor,
  orderableUnits,
} from './orders';

// Every test starts from a fresh deterministic match. The store is a singleton
// (a client has exactly one match), so this is the reset.
beforeEach(() => {
  newMatch();
});

/** Every event of one kind in a player's log, narrowed. */
function eventsOfKind<K extends VisibleEvent['type']>(
  player: PlayerId,
  type: K,
): Extract<VisibleEvent, { type: K }>[] {
  return logFor(player)
    .map((entry) => entry.event)
    .filter((event): event is Extract<VisibleEvent, { type: K }> => event.type === type);
}

describe('newMatch', () => {
  it('opens a playable match for both players', () => {
    for (const player of PLAYERS) {
      const view = viewFor(player);
      expect(view.round).toBe(1);
      expect(view.phase).toBe('ORDER_PHASE');
      expect(view.outcome).toBeNull();
      // The full roster: 3 launchers + 1 drone + bunker + decoy + 2 bases (§2).
      expect(view.units).toHaveLength(8);
      expect(logFor(player)).toHaveLength(0);
    }
  });

  it('clears the previous match', () => {
    resolveRound();
    selectHex({ q: 0, r: 0 });
    setViewer('p2');

    newMatch(7);

    expect(viewFor('p1').round).toBe(1);
    expect(logFor('p1')).toHaveLength(0);
    expect(matchStore.getState().selected).toBeNull();
    expect(matchStore.getState().viewer).toBe(SANDBOX_PLAYER);
    expect(matchStore.getState().seed).toBe(7);
  });
});

describe('the filter is the only way out of the store', () => {
  // The guarantee `visibility.ts` cannot enforce for itself: every leak it
  // prevents is prevented only for callers that call it (CLAUDE.md gotcha 34).
  it('never hands a player an enemy unit', () => {
    resolveRound();

    for (const player of PLAYERS) {
      for (const unit of viewFor(player).units) {
        expect(unit.owner).toBe(player);
      }
    }
  });

  it('still shows a player their OWN decoy as a decoy', () => {
    // The mask is for the enemy (§12). Over-filtering here would be its own
    // bug: a player who cannot tell their bunker from their decoy cannot play.
    const kinds = viewFor('p1').units.map((unit) => unit.kind);
    expect(kinds).toContain('decoy');
    expect(kinds).toContain('bunker');
  });

  it('gives each player only their own drone respawn counter', () => {
    expect(viewFor('p1').droneRespawnIn).toBe(0);
    expect(typeof viewFor('p2').droneRespawnIn).toBe('number');
  });
});

describe('resolveRound', () => {
  it('advances the round for both players', () => {
    resolveRound();

    for (const player of PLAYERS) {
      expect(viewFor(player).round).toBe(2);
      expect(viewFor(player).phase).toBe('ORDER_PHASE');
    }
  });

  it('routes owner-only events to their owner alone', () => {
    // No orders at all is a legal round: launchers hold, drones hover (§3), and
    // a hovering drone still emits DRONE_MOVED to its owner (§6).
    resolveRound();

    for (const player of PLAYERS) {
      const moves = eventsOfKind(player, 'DRONE_MOVED');
      expect(moves).toHaveLength(1);
      expect(moves[0].owner).toBe(player);
    }
  });

  it('stamps each entry with the round that was resolved, not the next one', () => {
    resolveRound();
    resolveRound();

    const rounds = new Set(logFor('p1').map((entry) => entry.round));
    expect([...rounds].sort()).toEqual([1, 2]);
    expect(viewFor('p1').round).toBe(3);
  });

  it('keeps the log append-only across rounds', () => {
    resolveRound();
    const first = [...logFor('p1')];
    resolveRound();

    expect(logFor('p1').slice(0, first.length)).toEqual(first);
  });

  it('files a detected launch on the DEFENDER’s map, and only theirs', () => {
    // End-to-end proof the pipeline is wired: an order goes in, the engine
    // resolves it, and the two players get different pictures out of one truth.
    const launcher = viewFor('p1').units.find((unit) => unit.kind === 'launcher');
    if (!launcher) throw new Error('p1 has no launcher');

    const origin = axialToOffset(launcher.position);
    const order: Order = {
      type: 'LAUNCH',
      unitId: launcher.id,
      // Three hexes north — well inside range 6, and on the map from row 16.
      target: offsetToAxial({ col: origin.col, row: origin.row - 3 }),
    };

    // Drafted through the real order builder, not handed straight to the round
    // loop — `setOrder` is the path a click takes, so this exercises the
    // validation the UI relies on as well as the resolution below.
    setOrder(order);
    resolveRound();

    // Launches are loud: both players log the detection (§6, §11).
    for (const player of PLAYERS) {
      expect(eventsOfKind(player, 'LAUNCH_DETECTED')).toHaveLength(1);
    }

    // But the *contact* marks the defender's map only. Filing it against the
    // firer would give each player a map of their own launches (gotcha 21b).
    expect(viewFor('p2').intel.contacts).toEqual([
      { hex: launcher.position, source: 'LAUNCH' },
    ]);
    expect(viewFor('p1').intel.contacts).toHaveLength(0);
  });

  it('expires a launcher contact after one order phase', () => {
    const launcher = viewFor('p1').units.find((unit) => unit.kind === 'launcher');
    if (!launcher) throw new Error('p1 has no launcher');
    const origin = axialToOffset(launcher.position);

    setOrder({
      type: 'LAUNCH',
      unitId: launcher.id,
      target: offsetToAxial({ col: origin.col, row: origin.row - 3 }),
    });
    resolveRound();
    expect(viewFor('p2').intel.contacts).toHaveLength(1);

    resolveRound();

    // The marker is gone (§11 rule 3) — but the history is not (§6).
    expect(viewFor('p2').intel.contacts).toHaveLength(0);
    expect(eventsOfKind('p2', 'LAUNCH_DETECTED')).toHaveLength(1);
    expect(
      eventsOfKind('p2', 'LAUNCH_DETECTED')[0].origin,
    ).toEqual(launcher.position);
  });

  it('the CPU (SANDBOX_DUMMY) actually plays, unlike the old static dummy', () => {
    // src/state/cpu.ts replaced the always-[] dummy (spec §8 step 9) with a
    // real opponent. At the default difficulty ('medium') and no intel yet on
    // round 1, every living launcher and the drone have nothing to fire at, so
    // they advance — p2's board should look different after a round resolves.
    // Difficulty-specific behaviour itself is covered exhaustively in
    // cpu.test.ts; this only pins that resolveRound() is actually wired to it.
    const before = viewFor('p2').units.map((unit) => hexKey(unit.position));

    resolveRound();
    resolveRound();

    expect(viewFor('p2').units.map((unit) => hexKey(unit.position))).not.toEqual(before);
  });

  it('is deterministic — the CPU plays identically across two fresh matches at the same seed', () => {
    resolveRound();
    const first = viewFor('p2').units.map((unit) => hexKey(unit.position));

    newMatch(matchStore.getState().seed);
    resolveRound();
    const second = viewFor('p2').units.map((unit) => hexKey(unit.position));

    expect(second).toEqual(first);
  });
});

describe('resign', () => {
  it('ends the match by capitulation, for both players', () => {
    resign('p1');

    for (const player of PLAYERS) {
      const view = viewFor(player);
      expect(view.phase).toBe('GAME_OVER');
      expect(view.outcome).toEqual({ type: 'CAPITULATION', winner: 'p2' });

      const over = eventsOfKind(player, 'GAME_OVER');
      expect(over).toHaveLength(1);
      expect(over[0].outcome).toEqual({ type: 'CAPITULATION', winner: 'p2' });
    }
  });

  it('is a no-op once the match is over, and so is another round', () => {
    resign('p2');
    const roundAfter = viewFor('p1').round;

    // The engine throws on a finished match and is right to; the store must not
    // pass a double-clicked button through to it.
    expect(() => resolveRound()).not.toThrow();
    expect(() => resign('p1')).not.toThrow();

    expect(viewFor('p1').round).toBe(roundAfter);
    expect(viewFor('p1').outcome).toEqual({ type: 'CAPITULATION', winner: 'p1' });
    expect(eventsOfKind('p1', 'GAME_OVER')).toHaveLength(1);
  });
});

describe('view controls', () => {
  it('switches which player the store reports as the viewer', () => {
    expect(matchStore.getState().viewer).toBe('p1');
    setViewer('p2');
    expect(matchStore.getState().viewer).toBe('p2');
  });

  it('drops the selection when the viewer changes', () => {
    selectHex({ q: 1, r: 1 });
    setViewer('p2');
    expect(matchStore.getState().selected).toBeNull();
  });
});

describe('setDifficulty', () => {
  it('defaults to DEFAULT_DIFFICULTY and can be changed', () => {
    expect(matchStore.getState().difficulty).toBe(DEFAULT_DIFFICULTY);
    setDifficulty('hard');
    expect(matchStore.getState().difficulty).toBe('hard');
  });

  it('survives a new match on a different map (a sandbox setting, not per-match state)', () => {
    setDifficulty('easy');
    newMatch(999);
    expect(matchStore.getState().difficulty).toBe('easy');
  });
});

// ---------------------------------------------------------------------------
// Order drafting (build-order step 10a)
// ---------------------------------------------------------------------------

/** The human's own units that may take an order this round. */
function mine() {
  return orderableUnits(viewFor(SANDBOX_PLAYER));
}

function launcher(index = 0) {
  const unit = mine().filter((u) => u.kind === 'launcher')[index];
  if (!unit) throw new Error('no launcher');
  return unit;
}

/** Decide every orderable unit but `n`, so the round is `n` clicks away. */
function decideAllBut(n: number): void {
  const units = mine();
  for (const unit of units.slice(0, units.length - n)) holdUnit(unit.id);
}

/** The one unit still undecided. */
function undecided() {
  const unit = mine().find((u) => !(u.id in matchStore.getState().draft));
  if (!unit) throw new Error('expected an undecided unit');
  return unit;
}

describe('the order draft', () => {
  it('stores a legal order and refuses an illegal one', () => {
    const unit = launcher();
    const target = moveTargets(viewFor(SANDBOX_PLAYER), unit)[0];
    const order = orderFor(unit, 'MOVE', target);

    setOrder(order);
    expect(matchStore.getState().draft[unit.id]).toEqual(order);

    // Its own hex is SAME_HEX (spec §9), so this must not overwrite the good
    // order above with a nonsense one.
    setOrder(orderFor(unit, 'MOVE', unit.position));
    expect(matchStore.getState().draft[unit.id]).toEqual(order);
  });

  it('cannot draft an order for the CPU’s units, whatever the viewer is', () => {
    // Orders are always judged against SANDBOX_PLAYER's view, so an enemy unit
    // id simply is not there to be found (spec §6 — a VisibleGameState holds
    // only its owner's units). Nothing has to remember to check ownership.
    setViewer(SANDBOX_DUMMY);
    setOrder({
      type: 'MOVE',
      unitId: `${SANDBOX_DUMMY}-launcher-1`,
      destination: { q: 0, r: 0 },
    });
    expect(matchStore.getState().draft).toEqual({});
  });

  it('replaces a unit’s order rather than queueing a second (spec §9)', () => {
    const unit = launcher();
    const view = viewFor(SANDBOX_PLAYER);

    setOrder(orderFor(unit, 'MOVE', moveTargets(view, unit)[0]));
    setOrder(orderFor(unit, 'LAUNCH', launchTargets(view, unit)[0]));

    expect(Object.keys(matchStore.getState().draft)).toEqual([unit.id]);
    expect(matchStore.getState().draft[unit.id].type).toBe('LAUNCH');
  });

  it('clears a single decision, and the whole draft', () => {
    const unit = launcher();
    setOrder(orderFor(unit, 'MOVE', moveTargets(viewFor(SANDBOX_PLAYER), unit)[0]));
    clearOrder(unit.id);
    expect(matchStore.getState().draft).toEqual({});

    holdUnit(launcher(0).id);
    holdUnit(launcher(1).id);
    clearDraft();
    expect(matchStore.getState().draft).toEqual({});
  });

  it('survives a look at the other player’s board', () => {
    // Flipping the viewer is a debug glance, not a decision — discarding queued
    // orders for it would punish looking.
    const unit = launcher();
    const order = orderFor(unit, 'MOVE', moveTargets(viewFor(SANDBOX_PLAYER), unit)[0]);
    setOrder(order);

    setViewer(SANDBOX_DUMMY);
    setViewer(SANDBOX_PLAYER);

    expect(matchStore.getState().draft[unit.id]).toEqual(order);
    // It does leave target-picking, though, so a click on the way back cannot
    // land an order the player did not mean to give.
    expect(matchStore.getState().orderMode).toBeNull();
  });

  it('submits the draft and clears it when the round resolves', () => {
    const unit = launcher();
    const before = unit.position;
    const destination = moveTargets(viewFor(SANDBOX_PLAYER), unit)[0];

    setOrder(orderFor(unit, 'MOVE', destination));
    resolveRound();

    expect(matchStore.getState().draft).toEqual({});
    const after = viewFor(SANDBOX_PLAYER).units.find((u) => u.id === unit.id);
    expect(after?.position).not.toEqual(before);
    expect(after?.position).toEqual(destination);
  });

  it('is discarded by newMatch and by resigning', () => {
    holdUnit(launcher().id);
    newMatch();
    expect(matchStore.getState().draft).toEqual({});

    holdUnit(launcher().id);
    resign(SANDBOX_PLAYER);
    expect(matchStore.getState().draft).toEqual({});
  });
});

describe('a completed draft resolves the round on its own', () => {
  it('waits until every orderable unit is decided, then fires exactly once', () => {
    const round = viewFor(SANDBOX_PLAYER).round;

    decideAllBut(1);
    expect(viewFor(SANDBOX_PLAYER).round).toBe(round);

    holdUnit(undecided().id);

    expect(viewFor(SANDBOX_PLAYER).round).toBe(round + 1);
    expect(matchStore.getState().draft).toEqual({});
  });

  it('counts a real order as a decision too, not only a hold', () => {
    const round = viewFor(SANDBOX_PLAYER).round;
    decideAllBut(1);

    const last = undecided();
    const view = viewFor(SANDBOX_PLAYER);
    setOrder(
      last.kind === 'drone'
        ? orderFor(last, 'FLY', flyTargets(view, last)[0])
        : orderFor(last, 'MOVE', moveTargets(view, last)[0]),
    );

    expect(viewFor(SANDBOX_PLAYER).round).toBe(round + 1);
  });

  it('does NOT fire when there is nothing to order', () => {
    // The empty-set guard at the store level. A finished match has no orderable
    // units, and "all zero of them are decided" must not resolve anything —
    // otherwise the CPU's dead-hand round would resolve itself forever.
    resign(SANDBOX_PLAYER);
    const round = viewFor(SANDBOX_PLAYER).round;
    expect(mine()).toEqual([]);

    clearDraft();
    expect(viewFor(SANDBOX_PLAYER).round).toBe(round);
    expect(viewFor(SANDBOX_PLAYER).outcome).not.toBeNull();
  });

  it('never resolves on an UNDO — removing a decision cannot complete a draft', () => {
    decideAllBut(1);
    const round = viewFor(SANDBOX_PLAYER).round;

    clearOrder(Object.keys(matchStore.getState().draft)[0]);
    expect(viewFor(SANDBOX_PLAYER).round).toBe(round);
  });
});

describe('clicking the map', () => {
  it('selects a hex, picking up your own unit if one is standing there', () => {
    const unit = launcher();
    pickHex(unit.position);

    expect(matchStore.getState().selected).toEqual(unit.position);
    expect(matchStore.getState().selectedUnitId).toBe(unit.id);
  });

  it('commits the order when a legal target is clicked in a mode', () => {
    const unit = launcher();
    const target = moveTargets(viewFor(SANDBOX_PLAYER), unit)[0];

    selectUnit(unit.id);
    setOrderMode('MOVE');
    pickHex(target);

    expect(matchStore.getState().draft[unit.id]).toEqual(
      orderFor(unit, 'MOVE', target),
    );
    // Target-picking is over — the panel is back to picking a unit.
    expect(matchStore.getState().orderMode).toBeNull();
  });

  it('falls back to selecting when an illegal hex is clicked in a mode', () => {
    // Which is also how a player backs out of target-picking: click somewhere
    // irrelevant. No order is drafted and nothing is lost.
    const unit = launcher();
    const far = offsetToAxial({ col: 0, row: 0 });

    selectUnit(unit.id);
    setOrderMode('MOVE');
    pickHex(far);

    expect(matchStore.getState().draft).toEqual({});
    expect(matchStore.getState().selected).toEqual(far);
    expect(matchStore.getState().orderMode).toBeNull();
  });
});
