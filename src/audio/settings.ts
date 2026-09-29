// AUDIO — the player's sound settings (V1.5 Session 4).
//
// Volume and mute, kept per browser in `localStorage` (no accounts; roadmap
// ruling). A plain Zustand store with no React in it, like `../state/match`, so
// it tests as an object; the hook lives in `./useSettings`.
//
// **This is not match state and must never become part of it.** It holds
// nothing about any board, player or event, which is why it is its own store
// rather than a field on `matchStore`: a hotseat handoff, a new match or the
// title screen have no reason to touch it, and nothing here could leak across
// one.
//
// Storage can be missing or throw (a private window, blocked site data, the
// test runner), so every read and write is guarded and the defaults stand in.

import { createStore } from 'zustand/vanilla';

export interface SoundSettings {
  /** Master volume, 0..1. */
  volume: number;
  muted: boolean;
}

export const DEFAULT_SETTINGS: SoundSettings = { volume: 0.7, muted: false };

export const STORAGE_KEY = 'nuke-wars:sound';

/** The subset of `Storage` this module uses, so tests can hand it a fake. */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Read saved settings, falling back field by field to the defaults. A corrupt
 * or hand-edited entry never throws and never yields a volume outside 0..1.
 */
export function loadSettings(storage: SettingsStorage | null = browserStorage()): SoundSettings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(raw) as Partial<Record<keyof SoundSettings, unknown>>;
    return {
      volume:
        typeof saved.volume === 'number' && Number.isFinite(saved.volume)
          ? clamp01(saved.volume)
          : DEFAULT_SETTINGS.volume,
      muted: typeof saved.muted === 'boolean' ? saved.muted : DEFAULT_SETTINGS.muted,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(
  settings: SoundSettings,
  storage: SettingsStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Full or blocked storage: the setting still applies for this visit.
  }
}

export const settingsStore = createStore<SoundSettings>(() => loadSettings());

settingsStore.subscribe((settings) => saveSettings(settings));

export function setVolume(volume: number): void {
  // Moving the slider is a request to hear something, so it unmutes.
  settingsStore.setState({ volume: clamp01(volume), muted: false });
}

export function setMuted(muted: boolean): void {
  settingsStore.setState({ muted });
}

export function toggleMute(): void {
  setMuted(!settingsStore.getState().muted);
}

/** The gain actually applied: zero when muted. */
export function effectiveVolume(settings: SoundSettings = settingsStore.getState()): number {
  return settings.muted ? 0 : settings.volume;
}
