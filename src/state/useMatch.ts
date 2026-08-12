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
import type { Hex } from '../sim/hex';
import type { PlayerId, VisibleGameState } from '../sim/types';
import { matchStore, type LogEntry } from './match';

/** The board as the current viewer is allowed to see it (spec §6 layer 2). */
export function useView(): VisibleGameState {
  return useStore(matchStore, (state) => state.views[state.viewer]);
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

/** The running match's map seed — shown in the HUD so a board can be re-rolled. */
export function useSeed(): number {
  return useStore(matchStore, (state) => state.seed);
}
