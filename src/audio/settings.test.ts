// Sound settings (V1.5 Session 4): saved per browser, never trusted blindly.

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  STORAGE_KEY,
  effectiveVolume,
  loadSettings,
  saveSettings,
  setMuted,
  setVolume,
  settingsStore,
  toggleMute,
  type SettingsStorage,
} from './settings';

function fakeStorage(initial: Record<string, string> = {}): SettingsStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

afterEach(() => settingsStore.setState({ ...DEFAULT_SETTINGS }));

describe('loadSettings / saveSettings', () => {
  it('round-trips', () => {
    const storage = fakeStorage();
    saveSettings({ volume: 0.25, muted: true }, storage);
    expect(loadSettings(storage)).toEqual({ volume: 0.25, muted: true });
  });

  it('falls back to the defaults with nothing saved, no storage, or storage that throws', () => {
    expect(loadSettings(fakeStorage())).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    const throwing: SettingsStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS, throwing)).not.toThrow();
  });

  it('repairs a corrupt or hand-edited entry field by field', () => {
    expect(loadSettings(fakeStorage({ [STORAGE_KEY]: 'not json' }))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(fakeStorage({ [STORAGE_KEY]: '{"volume":7,"muted":"yes"}' }))).toEqual({
      volume: 1,
      muted: DEFAULT_SETTINGS.muted,
    });
    expect(loadSettings(fakeStorage({ [STORAGE_KEY]: '{"volume":-3,"muted":true}' }))).toEqual({
      volume: 0,
      muted: true,
    });
  });
});

describe('the settings store', () => {
  it('mute silences without forgetting the volume', () => {
    setVolume(0.4);
    toggleMute();
    expect(settingsStore.getState()).toEqual({ volume: 0.4, muted: true });
    expect(effectiveVolume()).toBe(0);
    toggleMute();
    expect(effectiveVolume()).toBe(0.4);
  });

  it('moving the volume unmutes, and clamps to 0..1', () => {
    setMuted(true);
    setVolume(1.5);
    expect(settingsStore.getState()).toEqual({ volume: 1, muted: false });
    setVolume(-1);
    expect(settingsStore.getState().volume).toBe(0);
  });
});
