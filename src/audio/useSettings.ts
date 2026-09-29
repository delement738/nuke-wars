// AUDIO — React binding for the sound settings (V1.5 Session 4). Kept apart
// from `./settings` so that module stays React-free, as `state/useMatch.ts`
// does for the match store.

import { useStore } from 'zustand';
import { settingsStore, type SoundSettings } from './settings';

export function useSoundSettings(): SoundSettings {
  return useStore(settingsStore);
}
