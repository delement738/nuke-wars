// CLIENT STATE — battle reports (V1.1 step 1).
//
// The large, unmissable notifications a player gets when something decisive
// happens: a launcher kill, and the end of the match. This module is the pure
// half — it turns one resolution's *already filtered* events into a list of
// banners — and `src/ui/BattleReport.tsx` is the half that draws them.
//
// It sits beside `src/ui/eventText.ts` rather than inside it because the two
// answer different questions. The event log answers "what happened this round?"
// and is exhaustive; a battle report answers "does this deserve to stop the
// player?" and is deliberately, aggressively **not** exhaustive.
//
// ---------------------------------------------------------------------------
// The four rules this module exists to keep
// ---------------------------------------------------------------------------
//
//  1. **It is a projection of the filtered log, and decides no visibility.**
//     Callers hand it `VisibleEvent[]` — the output of `filterEventsForPlayer` —
//     so every redaction has already happened upstream (spec §6). If a banner
//     ever needs a fact that is not on the event, the fact is not the player's
//     to have. This is `visibility.ts`'s "the filter decides nothing" rule
//     (CLAUDE.md gotcha 32) applied one layer further out.
//
//  2. **A bunker hit is never reported, to either player.** `BUNKER_HIT` is
//     owner-only and stays log-only, by design decision on 2026-08-30. Two
//     things break if a banner announces one. To the *attacker* it would be a
//     bunker detector: blind-fire a spread, watch for the popup, and "only
//     drones find bunkers" is over (spec §6's note on `IMPACT`). To the game as
//     a whole it would erase the tell that the whole decoy mechanic rests on —
//     a real bunker takes a hit *in silence* where a decoy dies loudly, and
//     that difference is the answer the attacker spends a missile to buy (§12).
//     The negative tests in `reports.test.ts` are load-bearing, not padding.
//
//  3. **A confirmed kill means a launcher.** Decoys and interceptor bases also
//     emit a public `UNIT_DESTROYED`, and neither gets a banner: a decoy's
//     death is a *deduction* the player should draw from their log, not a
//     conclusion the UI hands them, and a base is scenery either side of the
//     event. Drones never appear here at all — they die by `DRONE_DOWNED`,
//     which is not a `UNIT_DESTROYED` (§6).
//
//  4. **Whose launcher it was comes from a unit lookup, never from the event.**
//     `UNIT_DESTROYED` carries no `owner`, deliberately — it is public, and an
//     owner field on a public event naming a `unitId` is a step toward the
//     cross-round trackable identity §11 withholds. So the audience question
//     ("did I score this, or take it?") is answered the way `eventText.ts`
//     already answers it: look the id up in the viewer's **own** roster, which
//     a `VisibleGameState` guarantees contains only their units — including
//     their destroyed ones, since your own losses are your own knowledge (§6).
//     Not found means not yours, and that inference is safe *because* the
//     filtered roster can never hold an enemy id (gotcha 31).

import { axialToOffset, type Hex } from '../sim/hex';
import type { Outcome, PlayerId, Unit, VisibleEvent } from '../sim/types';

/**
 * How a report should feel, and the only thing the UI is allowed to colour by.
 *
 * Kept separate from the copy so the component never pattern-matches on text.
 */
export type ReportTone = 'kill' | 'loss' | 'victory' | 'defeat' | 'draw';

/** One banner. `id` is stable within a round so React can key the queue. */
export interface BattleReport {
  id: string;
  tone: ReportTone;
  /** The big line. A few words — the UI sets it in caps. */
  headline: string;
  /** One supporting sentence. Never empty; the layout expects both lines. */
  detail: string;
}

/**
 * Spec §4's outcomes as a banner, from the reader's point of view.
 *
 * Exported for its own tests and because the outcome banner is the one report
 * whose text a future end-of-match screen will want to reuse.
 *
 * The switch is exhaustive over `Outcome` with a `never` fallthrough, so adding
 * an outcome to the engine is a build error here rather than a silent blank
 * screen at the most important moment in the match.
 */
export function outcomeReport(outcome: Outcome, viewer: PlayerId): BattleReport {
  const id = `outcome-${outcome.type}`;

  switch (outcome.type) {
    case 'DECAPITATION':
      return outcome.winner === viewer
        ? {
            id,
            tone: 'victory',
            headline: 'Victory by decapitation',
            detail: 'The enemy bunker is destroyed and yours survived the dead hand.',
          }
        : {
            id,
            tone: 'defeat',
            headline: 'Defeated by decapitation',
            detail: 'Your bunker is destroyed. The regime has fallen.',
          };

    case 'DISARMAMENT':
      return outcome.winner === viewer
        ? {
            id,
            tone: 'victory',
            headline: 'Victory by disarmament',
            detail: 'The enemy has no launchers left and no way to strike back.',
          }
        : {
            id,
            tone: 'defeat',
            headline: 'Defeated by disarmament',
            detail: 'Your last launcher is gone. You have no offensive capability.',
          };

    case 'CAPITULATION':
      return outcome.winner === viewer
        ? {
            id,
            tone: 'victory',
            headline: 'Victory by capitulation',
            detail: 'The enemy has resigned.',
          }
        : {
            id,
            tone: 'defeat',
            headline: 'Capitulation',
            detail: 'You resigned the match.',
          };

    case 'MUTUAL_ANNIHILATION':
      return {
        id,
        tone: 'draw',
        headline: 'Mutual annihilation',
        detail: 'Both bunkers destroyed. Nobody survives this one.',
      };

    case 'MUTUAL_DISARMAMENT':
      return {
        id,
        tone: 'draw',
        headline: 'Mutual disarmament',
        detail: 'Both sides lost their last launcher in the same round. Draw.',
      };

    case 'ARMISTICE':
      return {
        id,
        tone: 'draw',
        headline: 'Armistice',
        detail: 'The round cap was reached with neither regime broken. Draw.',
      };

    default: {
      const unwritten: never = outcome;
      throw new Error(
        `outcomeReport(): no banner for ${JSON.stringify(unwritten)}`,
      );
    }
  }
}

/**
 * The banners `viewer` should be shown for one resolution, in event order.
 *
 * `events` must already be this player's filtered log slice, and `ownUnits`
 * their own roster from the same `VisibleGameState` — see rule 4 in the header
 * for why the roster is what answers "whose launcher was that?".
 *
 * Returns `[]` for the overwhelming majority of rounds, and that is the design:
 * a notification that fires every round is wallpaper. Everything not listed
 * here reaches the player through the event log, which is exhaustive and
 * permanent (spec §6, §11).
 */
export function battleReports(
  events: readonly VisibleEvent[],
  viewer: PlayerId,
  ownUnits: readonly Unit[],
  round: number,
): BattleReport[] {
  const reports: BattleReport[] = [];

  for (const event of events) {
    if (event.type === 'UNIT_DESTROYED') {
      // Rule 3: launchers only. A decoy or base death is a public event the
      // player reads in their log and draws their own conclusion from.
      if (event.kind !== 'launcher') continue;

      // Rule 4: the roster is the audience test. `find` over at most 8 units.
      const mine = ownUnits.some((unit) => unit.id === event.unitId);
      const hex = hexLabel(event.hex);

      reports.push(
        mine
          ? {
              id: `r${round}-lost-${event.unitId}`,
              tone: 'loss',
              headline: 'Launcher lost',
              detail: `Your launcher at ${hex} was destroyed.`,
            }
          : {
              id: `r${round}-kill-${event.unitId}`,
              tone: 'kill',
              headline: 'Confirmed kill',
              detail: `Enemy launcher destroyed at ${hex}.`,
            },
      );
      continue;
    }

    if (event.type === 'GAME_OVER') {
      reports.push(outcomeReport(event.outcome, viewer));
    }

    // Everything else is deliberately silent — see rules 2 and 3. There is no
    // `default:` throw here on purpose: unlike `describeEvent`, which must have
    // a line for every event, this module's correct answer for a new event kind
    // is "no banner" until someone decides otherwise.
  }

  return reports;
}

/**
 * A hex as the player sees it on the board: map column and row.
 *
 * Offset coordinates via the sim's own `axialToOffset`, never a local copy of
 * that arithmetic — axial `r` skews with the column, so a second definition
 * that drifted would name a row the player cannot see. Deliberately not
 * imported from `src/ui/eventText.ts`, which has the same two lines: `src/state/`
 * may depend on `src/sim/` but must not depend on the UI layer.
 */
function hexLabel(hex: Hex): string {
  const { col, row } = axialToOffset(hex);
  return `c${col} r${row}`;
}
