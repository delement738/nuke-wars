// UI LAYER — the order builder (build-order step 10a).
//
// Reads state, sends player intents, never mutates game state and never decides
// a rule. Which units may be ordered, which modes each may take, and which hexes
// are legal all come from `src/state/orders.ts`, which asks the real sim
// validators. This file's whole job is to put those answers on screen and turn
// clicks back into intents.
//
// The loop it implements: pick one of your units -> pick what it does -> click a
// highlighted hex (or Hold). When every orderable unit has been decided, the
// round resolves on its own — see `allDecided` in `src/state/orders.ts` for why
// Hold has to exist for that to be a rule a player can actually satisfy.

import type { Hex } from '../sim/hex';
import type { Unit } from '../sim/types';
import {
  clearDraft,
  clearOrder,
  holdUnit,
  selectUnit,
  setOrderMode,
  SANDBOX_PLAYER,
} from '../state/match';
import {
  decidedCount,
  modesFor,
  orderableUnits,
  type DraftEntry,
  type OrderMode,
} from '../state/orders';
import {
  useDraft,
  useOrderMode,
  useSelectedUnitId,
  useView,
  useViewer,
} from '../state/useMatch';
import { hexLabel } from './eventText';

/** Verb shown on the mode button. "Fire" rather than "Launch" so the three
 *  buttons never start with the same letter at a glance. */
const MODE_LABEL: Record<OrderMode, string> = {
  MOVE: 'Move',
  MARCH: 'March',
  LAUNCH: 'Fire',
  FLY: 'Fly',
};

/** What picking this mode is asking the player to click. */
const MODE_HINT: Record<OrderMode, string> = {
  MOVE: 'Click a green hex to advance there.',
  // States the cost, because no overlay can draw it: the hexes look like richer
  // MOVE ground, and the price is a public event on the hex you are leaving.
  MARCH: 'Click a bright green hex to force-march there — twice the distance, but the hex you leave is announced to the enemy for one round.',
  LAUNCH: 'Click any hex in the amber ring to fire on it — mountains included, and blind fire at empty ground is legal.',
  FLY: 'Hover a violet hex to preview the flight path and the corridor it photographs, then click to commit.',
};

export default function OrderPanel() {
  const view = useView();
  const viewer = useViewer();
  const selectedUnitId = useSelectedUnitId();
  const orderMode = useOrderMode();
  const draft = useDraft();

  // Unreachable in practice — `App` mounts this only once a match exists — but
  // `useView()` is nullable because the setup screen has no board (step 10b).
  if (!view) return null;

  // The viewer switch is a sandbox control, and orders always belong to the
  // human. Drafting while looking at the CPU's board would be queueing orders
  // for a side you are only spectating, so entry is switched off rather than
  // silently pointed at the wrong player. (The store refuses such an order
  // anyway — the two guards are independent on purpose.)
  if (viewer !== SANDBOX_PLAYER) {
    return (
      <section className="panel">
        <h2>Orders</h2>
        <p className="muted">
          Spectating {viewer.toUpperCase()}. Switch back to{' '}
          {SANDBOX_PLAYER.toUpperCase()} to give orders — anything you had queued
          is still waiting.
        </p>
      </section>
    );
  }

  const units = orderableUnits(view);

  if (units.length === 0) {
    return (
      <section className="panel">
        <h2>Orders</h2>
        <p className="muted">
          {view.outcome
            ? 'The match is over.'
            : view.phase === 'DEAD_HAND_PHASE'
              ? 'The enemy is firing their final volley. You issue no orders this round.'
              : 'Nothing of yours can take an order.'}
        </p>
      </section>
    );
  }

  const decided = decidedCount(view, draft);
  const selected = units.find((unit) => unit.id === selectedUnitId) ?? null;

  return (
    <section className="panel orders">
      <h2>
        Orders
        <span className="viewing">
          {decided} / {units.length}
        </span>
      </h2>

      <ul className="unit-list">
        {units.map((unit) => {
          const active = unit.id === selected?.id;
          return (
            <li key={unit.id} className={active ? 'unit active' : 'unit'}>
              <button
                type="button"
                className="unit-name"
                onClick={() => selectUnit(unit.id)}
              >
                <span>{unitLabel(unit)}</span>
                <span className="decision">{decisionLabel(unit, draft[unit.id])}</span>
              </button>

              {active && (
                <div className="buttons">
                  {modesFor(view, unit).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setOrderMode(orderMode === mode ? null : mode)}
                      disabled={orderMode === mode}
                    >
                      {MODE_LABEL[mode]}
                    </button>
                  ))}
                  <button type="button" onClick={() => holdUnit(unit.id)}>
                    {unit.kind === 'drone' ? 'Hover' : 'Hold'}
                  </button>
                  {draft[unit.id] && (
                    <button type="button" onClick={() => clearOrder(unit.id)}>
                      Undo
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {selected && orderMode && (
        <>
          <p className="alert">{MODE_HINT[orderMode]}</p>
          {orderMode === 'MOVE' && (
            // Spec §9, stated in words because the highlight cannot say it: the
            // range is computed from what this player knows, and an undetected
            // enemy sitting on the destination makes the order fail entirely.
            <p className="footnote">
              This range is a prediction, not a promise. An enemy you have not
              detected can be standing there — the advance then fails outright
              and the launcher holds. That risk is what the drone is for.
            </p>
          )}
          <div className="buttons">
            <button type="button" onClick={() => setOrderMode(null)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {decided > 0 && (
        <div className="buttons">
          <button type="button" onClick={() => clearDraft()}>
            Clear all orders
          </button>
        </div>
      )}

      <p className="footnote">
        The round resolves by itself once all {units.length} are decided. Hold
        counts as a decision — a launcher that stays put and a drone that hovers
        are both real choices, and a hovering drone still photographs its own
        corridor.
      </p>
    </section>
  );
}

/** `p1-launcher-2` -> `Launcher 2`. Ids are readable by design (spec §6). */
function unitLabel(unit: Unit): string {
  const suffix = unit.id.split('-').pop();
  const numbered = suffix !== undefined && /^\d+$/.test(suffix);
  const kind = unit.kind.charAt(0).toUpperCase() + unit.kind.slice(1);
  return numbered ? `${kind} ${suffix}` : kind;
}

/** One line describing what this unit is going to do, if anything yet. */
function decisionLabel(unit: Unit, entry: DraftEntry | undefined): string {
  if (!entry) return 'undecided';

  switch (entry.type) {
    case 'MOVE':
      return `move to ${hexLabel(entry.destination as Hex)}`;
    case 'MARCH':
      return `MARCH to ${hexLabel(entry.destination as Hex)} (origin revealed)`;
    case 'LAUNCH':
      return `fire on ${hexLabel(entry.target as Hex)}`;
    case 'FLY':
      return `fly to ${hexLabel(entry.destination as Hex)}`;
    case 'HOLD':
      return unit.kind === 'drone' ? 'hovering' : 'holding';
  }
}
