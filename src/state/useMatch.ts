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
import type { PlacementDraft } from './placement';

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

/** The human's own placements, one entry per roster slot (spec §12). Pass it to
 *  `placementSlots` for the roster the setup panel lists. */
export function usePlaced(): PlacementDraft {
  return useStore(matchStore, (state) => state.placed);
}

/** Which roster slot the setup screen is positioning (spec §12). */
export function useSelectedSlot(): number {
  return useStore(matchStore, (state) => state.selectedSlot);
}

/** The current viewer's permanent event history (spec §11). */
export function useLog(): readonly LogEntry[] {
  return useStore(matchStore, (state) => state.logs[state.viewer]);
}

/** Whose view is on screen. */
export function useViewer(): PlayerId {
  return useStore(matchStore, (state) => state.viewer);
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

/** This round's queued decisions, keyed by unit (spec §9's budget, structural). */
export function useDraft(): OrderDraft {
  return useStore(matchStore, (state) => state.draft);
}

/** The running match's map seed — shown in the HUD so a board can be re-rolled. */
export function useSeed(): number {
  return useStore(matchStore, (state) => state.seed);
}

/** How the CPU (`SANDBOX_DUMMY`) currently plays. */
export function useDifficulty(): CpuDifficulty {
  return useStore(matchStore, (state) => state.difficulty);
}
