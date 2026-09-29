// AUDIO — the four sounds, made in the browser (V1.5 Session 4).
//
// Every sound is synthesised with the Web Audio API at the moment it plays: no
// audio files, no library, nothing to licence (designer's pick). The palette is
// `docs/art-direction.md`'s bunker: teletype clicks for the UI, a low klaxon
// sting for launches, a muffled distant thump for impacts, a relay click for
// intercepts. Everything passes through a low-pass somewhere, because the room
// is underground and nothing in it should sound arcade-bright.
//
// **What this file may be asked to play is decided elsewhere.** It takes a
// `Sound` name and nothing else, so no board fact can reach a sound's shape,
// pitch or loudness (gotcha 69 for the ear). Which beat is heard is `./cues`.
//
// Browsers refuse to start audio before the page has been interacted with, so
// the `AudioContext` is created lazily on the first sound — which is always
// after a click or key press — and resumed if the browser suspended it. Where
// Web Audio does not exist (the test runner, a very old browser) every call is
// a silent no-op.

import type { Sound } from './cues';
import { effectiveVolume, settingsStore } from './settings';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;

function context(): AudioContext | null {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }
  const Ctor =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;

  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = effectiveVolume();
  master.connect(ctx.destination);
  settingsStore.subscribe((settings) => {
    if (master && ctx) master.gain.setTargetAtTime(effectiveVolume(settings), ctx.currentTime, 0.02);
  });

  // One second of white noise, reused by every sound that needs grit.
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Play one sound now. Silent when muted, and before Web Audio exists. */
export function playSound(sound: Sound): void {
  if (effectiveVolume() === 0) return;
  const c = context();
  if (!c || !master) return;
  const t = c.currentTime;
  switch (sound) {
    case 'click':
      return teletype(c, master, t);
    case 'klaxon':
      return klaxon(c, master, t);
    case 'thump':
      return thump(c, master, t);
    case 'relay':
      return relay(c, master, t);
    default: {
      const never: never = sound;
      return never;
    }
  }
}

/** A gain node shaped as a quick attack and an exponential fall to silence. */
function envelope(
  c: AudioContext,
  out: AudioNode,
  t: number,
  peak: number,
  attack: number,
  decay: number,
): GainNode {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

/** A burst of filtered noise: the grit in a click, a relay or a blast. */
function noiseBurst(
  c: AudioContext,
  out: AudioNode,
  t: number,
  length: number,
  filter: BiquadFilterType,
  frequency: number,
  q = 1,
): void {
  if (!noise) return;
  const src = c.createBufferSource();
  src.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = filter;
  f.frequency.value = frequency;
  f.Q.value = q;
  src.connect(f).connect(out);
  src.start(t, Math.random() * 0.5, length);
}

/** Teletype key: a hard tick and a softer bounce, with a little body under it. */
function teletype(c: AudioContext, out: AudioNode, t: number): void {
  noiseBurst(c, envelope(c, out, t, 0.35, 0.001, 0.018), t, 0.03, 'bandpass', 3200, 1.5);
  noiseBurst(c, envelope(c, out, t + 0.026, 0.12, 0.001, 0.014), t + 0.026, 0.02, 'bandpass', 2600, 1.5);
  const body = c.createOscillator();
  body.type = 'triangle';
  body.frequency.value = 170;
  body.connect(envelope(c, out, t, 0.12, 0.001, 0.03));
  body.start(t);
  body.stop(t + 0.05);
}

/** A low two-tone klaxon sting, heard through a wall. */
function klaxon(c: AudioContext, out: AudioNode, t: number): void {
  const wall = c.createBiquadFilter();
  wall.type = 'lowpass';
  wall.frequency.value = 850;
  wall.Q.value = 0.7;
  const level = c.createGain();
  level.gain.setValueAtTime(0.0001, t);
  level.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
  level.gain.setValueAtTime(0.16, t + 0.7);
  level.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
  wall.connect(level).connect(out);

  const step = 0.24;
  for (const detune of [0, 7]) {
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.detune.value = detune;
    for (let i = 0; i < 4; i++) {
      osc.frequency.setValueAtTime(i % 2 === 0 ? 196 : 165, t + i * step);
    }
    osc.connect(wall);
    osc.start(t);
    osc.stop(t + 1);
  }
}

/** A muffled, distant impact: a falling low boom and a rumble of dirt. */
function thump(c: AudioContext, out: AudioNode, t: number): void {
  const boom = c.createOscillator();
  boom.type = 'sine';
  boom.frequency.setValueAtTime(72, t);
  boom.frequency.exponentialRampToValueAtTime(30, t + 0.6);
  boom.connect(envelope(c, out, t, 0.9, 0.01, 0.8));
  boom.start(t);
  boom.stop(t + 0.9);

  noiseBurst(c, envelope(c, out, t, 0.5, 0.02, 1.1), t, 1.2, 'lowpass', 240, 0.8);
}

/** A relay closing: two sharp contacts a hair apart. */
function relay(c: AudioContext, out: AudioNode, t: number): void {
  for (const [at, peak] of [[0, 0.4], [0.045, 0.28]] as const) {
    noiseBurst(c, envelope(c, out, t + at, peak, 0.001, 0.012), t + at, 0.02, 'bandpass', 1800, 4);
    const blip = c.createOscillator();
    blip.type = 'square';
    blip.frequency.value = 900;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2000;
    blip.connect(f).connect(envelope(c, out, t + at, 0.05, 0.001, 0.01));
    blip.start(t + at);
    blip.stop(t + at + 0.02);
  }
}

/**
 * Teletype clicks for every enabled button in the page, from one listener
 * rather than an `onClick` added to each button. Returns the cleanup.
 */
export function installUiClicks(): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    if (target?.closest?.('button:not(:disabled)')) playSound('click');
  };
  document.addEventListener('click', onClick, { capture: true });
  return () => document.removeEventListener('click', onClick, { capture: true });
}
