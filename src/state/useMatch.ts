// CLIENT STATE — React bindings for the match store (build-order step 9).
//
// Kept separate from `./match` so that module stays React-free and testable as a
// plain object, the same way `src/sim/` stays dependency-free. Everything here
// is a one-line subscription; there is no logic in this file on purpose.
//
// **Every hook returns filtered data, because the store contains nothing else.**
// The unfiltered `GameState` lives in a module-private variable in `./match`
// with no accessor, so there is no hook that could return one (CLAUDE.md gotcha
// 34) — the type flowing into `src/render/` and `src/ui/` is `VisibleGameState`
// and nothing else.
//
// Each selector returns a value already stored in the state rather than deriving
// a new object or array. That matters with `useSyncExternalStore` underneath: a
// selector that built a fresh array every call would return a new reference on
// every render and re-render forever.

import { useStore } from 'zustand';
import type { CpuDifficulty } from './cpu';
import type { Hex } from '../sim/hex';
import type { MapData } from '../sim/map';
import type { PlayerId, UnitId, VisibleGameState } from '../sim/types';
import { matchStore, type LogEntry } from './match';
import type { OrderDraft, OrderMode } from './orders';
import { placementComplete, type PlacementDraft } from './placement';
import type { BattleReport } from './reports';
import { isHotseat, nextSeat } from './seats';

/**
 * The board as the current viewer is allowed to see it (spec §6 layer 2) — or
 * null while the setup screen is still collecting placements, because a
 * `GameState` only exists on the far side of `startMatch` (§12).
 */
export function useView(): VisibleGameState | null {
  return useStore(matchStore, (state) => state.views?.[state.viewer] ?? null);
}

/**
 * Whether a match is running (build-order step 10b) — false on the setup screen.
 *
 * Derived from `views` rather than stored, so there is exactly one fact about
 * which screen the client is on. It returns a boolean, which
 * `useSyncExternalStore` compares by value, so deriving it costs no extra
 * renders — unlike a selector that built a fresh object.
 */
export function useMatchStarted(): boolean {
  return useStore(matchStore, (state) => state.views !== null);
}

/**
 * The board itself. Available before a match exists, because terrain is public
 * (spec §11) and the setup screen has to draw it.
 */
export function useMap(): MapData {
  return useStore(matchStore, (state) => state.map);
}

/**
 * The **viewer's own** placements, one entry per roster slot (spec §12). Pass it
 * to `placementSlots` for the roster the setup panel lists.
 *
 * Keyed on `viewer` inside the hook, and that is load-bearing since 10c: in
 * hotseat both players' secret setups are in the store at once, so a hook that
 * took a `PlayerId` from its caller would be one mistyped argument away from
 * showing a player their opponent's four hidden hexes (gotcha 36).
 */
export function usePlaced(): PlacementDraft {
  return useStore(matchStore, (state) => state.placed[state.viewer]);
}

/** Which roster slot the viewer's setup screen is positioning (spec §12). */
export function useSelectedSlot(): number {
  return useStore(matchStore, (state) => state.selectedSlot[state.viewer]);
}

/** The current viewer's permanent event history (spec §11). */
export function useLog(): readonly LogEntry[] {
  return useStore(matchStore, (state) => state.logs[state.viewer]);
}

/**
 * The banner the current viewer has not read yet, or null (V1.1 step 1).
 *
 * Returns only the head of the queue, so the UI shows one at a time and
 * `dismissReport` advances it. Keyed on `viewer` inside the hook like every
 * other selector here — in hotseat the other seat's queue is waiting for a
 * player who has not sat down yet, and no component may reach it (gotcha 36).
 */
export function useReport(): BattleReport | null {
  return useStore(matchStore, (state) => state.reports[state.viewer][0] ?? null);
}

/** Whose view is on screen. */
export function useViewer(): PlayerId {
  return useStore(matchStore, (state) => state.viewer);
}

/**
 * Whose turn it is to act (build-order step 10c).
 *
 * Equal to `useViewer()` in hotseat and while playing solo normally; the two
 * come apart only when the solo debug viewer switch is used, which is exactly
 * the case the order builder must refuse to serve (gotcha 41d).
 */
export function useActiveSeat(): PlayerId {
  return useStore(matchStore, (state) => state.activeSeat);
}

/**
 * The player the screen is waiting to be passed to, or null when someone is
 * already at it (build-order step 10c).
 *
 * `App` renders the handoff prompt and nothing else while this is set — the
 * blank that stands in for the structural secrecy solo play gets for free.
 */
export function useHandoff(): PlayerId | null {
  return useStore(matchStore, (state) => state.handoff);
}

/** Whether two humans are sharing this screen (build-order step 10c). Returns a
 *  boolean, which `useSyncExternalStore` compares by value, so deriving it here
 *  costs no extra renders. */
export function useIsHotseat(): boolean {
  return useStore(matchStore, (state) => isHotseat(state.seats));
}

/**
 * Whether committing this setup will hand the screen over rather than start the
 * match — i.e. another human still has assets to hide (build-order step 10c).
 *
 * It answers only *whether* someone else is still placing, never *what* they
 * have placed, so it is a fact about the procedure rather than about the board.
 * The setup panel needs it to label its button honestly: pressing Start as the
 * first player in a hotseat game does not start anything.
 */
export function useAwaitingSetup(): boolean {
  return useStore(
    matchStore,
    (state) =>
      nextSeat(
        state.seats,
        state.activeSeat,
        (player) => !placementComplete(state.placed[player]),
      ) !== null,
  );
}

/** The selected hex, or null. */
export function useSelected(): Hex | null {
  return useStore(matchStore, (state) => state.selected);
}

/** The unit currently being ordered, or null (build-order step 10a). */
export function useSelectedUnitId(): UnitId | null {
  return useStore(matchStore, (state) => state.selectedUnitId);
}

/** Which order kind the panel is composing, or null. */
export function useOrderMode(): OrderMode | null {
  return useStore(matchStore, (state) => state.orderMode);
}

/** The hex under the cursor — drives the flight-path preview. */
export function useHovered(): Hex | null {
  return useStore(matchStore, (state) => state.hovered);
}

/**
 * The **viewer's** queued decisions for this round, keyed by unit (spec §9's
 * budget, structural).
 *
 * Keyed on `viewer` for the same reason as `usePlaced`: orders are simultaneous
 * and hidden (§3), so in hotseat the other player's draft is exactly as secret
 * as their placements.
 */
export function useDraft(): OrderDraft {
  return useStore(matchStore, (state) => state.draft[state.viewer]);
}

/** The running match's map seed — shown in the HUD so a board can be re-rolled. */
export function useSeed(): number {
  return useStore(matchStore, (state) => state.seed);
}

/** How the CPU (`SANDBOX_DUMMY`) currently plays. */
export function useDifficulty(): CpuDifficulty {
  return useStore(matchStore, (state) => state.difficulty);
}
