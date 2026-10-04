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

import { RULES } from '../sim/defs';
import type { Hex } from '../sim/hex';
import type { Unit } from '../sim/types';
import type { PaletteName } from '../render/palette';
import {
  clearDraft,
  clearOrder,
  holdUnit,
  selectUnit,
  setOrderMode,
} from '../state/match';
import {
  decidedCount,
  modesFor,
  orderableUnits,
  type DraftEntry,
  type OrderMode,
} from '../state/orders';
import {
  useActiveSeat,
  useDraft,
  useOrderMode,
  useSelectedUnitId,
  useView,
  useViewer,
} from '../state/useMatch';
import { hexLabel } from './eventText';
import Prompt from './Prompt';

/** Verb shown on the mode button. "Fire" rather than "Launch" so the three
 *  buttons never start with the same letter at a glance. */
const MODE_LABEL: Record<OrderMode, string> = {
  MOVE: 'Move',
  MARCH: 'March',
  LAUNCH: 'Fire',
  FLY: 'Fly',
};

/**
 * What picking this mode is asking the player to click: a headline naming the
 * board colour, then one line on what it costs or rules out. `tone` is the
 * palette entry the board highlights that mode's hexes in, so the swatch on the
 * card is the same green / orange / violet the player is looking for.
 */
const MODE_PROMPT: Record<OrderMode, { tone: PaletteName; title: string; body: string }> = {
  MOVE: {
    tone: 'move',
    title: 'Move — click a green hex',
    body: 'The launcher drives there this round.',
  },
  // States the cost, because no overlay can draw it: the hexes look like richer
  // MOVE ground, and the price is a public event on the hex you are leaving.
  MARCH: {
    tone: 'march',
    title: 'March — click a bright green hex',
    body: 'Twice as far, but the enemy hears the hex you leave for one round.',
  },
  LAUNCH: {
    tone: 'launch',
    title: 'Fire — click an orange hex',
    body: 'Mountains and empty ground are fair targets. Hexes behind a ridge aren’t offered: the mountain blocks the shot.',
  },
  FLY: {
    tone: 'fly',
    title: 'Fly — click a violet hex',
    body: 'Hover first to preview the flight and the strip of ground it photographs.',
  },
};

/** What to do with a unit that is picked but has no mode yet. */
function choosePrompt(unit: Unit): string {
  return unit.kind === 'drone'
    ? 'Fly to photograph a strip of ground, or Hover to watch your own.'
    : 'Move or March to reposition, Fire to launch, or Hold to stay put.';
}

export default function OrderPanel() {
  const view = useView();
  const viewer = useViewer();
  const activeSeat = useActiveSeat();
  const selectedUnitId = useSelectedUnitId();
  const orderMode = useOrderMode();
  const draft = useDraft();

  // Unreachable in practice — `App` mounts this only once a match exists — but
  // `useView()` is nullable because the setup screen has no board (step 10b).
  if (!view) return null;

  // Orders belong to whoever's turn it is — `activeSeat`, the seat
  // `orderingView` drafts for (gotcha 55). If the board on screen is someone
  // else's, entry is switched off rather than silently pointed at the wrong
  // player. (The store refuses such an order anyway — the two guards are
  // independent on purpose.)
  //
  // This used to compare against SANDBOX_PLAYER, step 10a's "the human is P1",
  // which left hotseat P2 permanently "spectating" their own turn.
  if (viewer !== activeSeat) {
    return (
      <section className="panel">
        <h2>Orders</h2>
        <p className="muted">
          Spectating {viewer.toUpperCase()}. Switch back to{' '}
          {activeSeat.toUpperCase()} to give orders — anything you had queued
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

      {!selected && decided < units.length && (
        <Prompt tone="own" title="Pick a unit to order">
          Click one in the list above or on the board.
        </Prompt>
      )}

      {selected && !orderMode && (
        <Prompt tone="own" title={`${unitLabel(selected)} — choose an order`}>
          {choosePrompt(selected)}
        </Prompt>
      )}

      {selected && orderMode && (
        <>
          <Prompt tone={MODE_PROMPT[orderMode].tone} title={MODE_PROMPT[orderMode].title}>
            {MODE_PROMPT[orderMode].body}
          </Prompt>
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
          {orderMode === 'LAUNCH' && (
            // Spec §3, §10: flight time (RULES.missileSpeed 4 vs missileRange 6).
            // Deliberately does NOT promise a dodge — a carried missile lands in
            // the next round's impact phase, before that round's movement.
            <p className="footnote">
              Targets 1–{RULES.missileSpeed} hexes away are hit this round. At{' '}
              {RULES.missileSpeed + 1}–{RULES.missileRange} hexes the missile
              spends a round in the air and lands next round, before anyone
              moves. Both sides see it on the map until it lands.
            </p>
          )}
          {orderMode === 'MARCH' && (
            // The same §9 prediction caveat, plus the one rule a player will
            // otherwise learn the hard way (CLAUDE.md gotcha 51): the reveal
            // fires on the ATTEMPT. A march blocked by an unseen enemy pays the
            // full price and buys nothing, which is what makes marching into
            // unscouted ground a genuinely worse bet than walking into it.
            <p className="footnote">
              The red hex is what you are giving away: the enemy sees the hex you
              left, for one round, and never where you arrived. They learn a
              bearing, not a target. Be sure before you commit — if an enemy you
              have not detected is standing on the destination the march fails
              outright and is <em>still</em> heard.
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
