// RENDER LAYER — the replay timeline (presentation phase, session 1).
//
// Pure functions, no Pixi: an event list goes in, timed clips come out, and
// `frameAt` answers "at t ms, which clips are playing and how far through?".
// The Pixi side (`GameCanvas` + `./playbackDraw`) only advances a clock and
// draws whatever this module says is on screen, so everything about *order* and
// *timing* is testable without a browser.
//
// **Animate from events, never by diffing states** (CLAUDE.md architecture
// rules). The event list is the script; the viewer's pre-resolution board is
// only the backdrop it plays on. Nothing here ever compares two states.
//
// **Never re-sort.** Spec §6 guarantees the log is grouped by phase and
// canonically ordered inside each phase, "so a client can animate straight
// through the array without sorting or looking ahead". `buildTimeline` walks the
// events in order and cuts a new *beat* wherever the cue changes — neighbouring
// events of one cue start together (orders are simultaneous, §3), and beats play
// one after another. The dead-hand round's repeated launch → impact passes need
// no special case: they are simply more beats.

import type { UnitId, VisibleEvent } from '../sim/types';

/** One kind of beat. Listed in spec §6's phase order. */
export type Cue =
  | 'fly' // recon: the drone's flight
  | 'spot' // recon: what it photographed
  | 'downed' // recon: a drone shot down
  | 'launch' // launches
  | 'intercept' // interceptions
  | 'exposed' // an intercepting base given away
  | 'impact' // every missile that landed
  | 'damage' // what the impacts did
  | 'verdict' // phase 4: dead hand / game over
  | 'move' // phase 5: ground movement
  | 'respawn'; // entering the next order phase

/**
 * Which beat each event belongs to.
 *
 * A `Record` over every event type, not a switch with a default: adding an event
 * kind to `GameEvent` fails to compile here until someone decides how it is
 * animated (the gotcha-53 lesson — a fall-through is invisible to the compiler).
 */
export const CUE_OF: Record<VisibleEvent['type'], Cue> = {
  DRONE_MOVED: 'fly',
  ASSET_SPOTTED: 'spot',
  DRONE_DOWNED: 'downed',
  LAUNCH_DETECTED: 'launch',
  MISSILE_INTERCEPTED: 'intercept',
  BASE_EXPOSED: 'exposed',
  IMPACT: 'impact',
  BUNKER_HIT: 'damage',
  UNIT_DESTROYED: 'damage',
  DEAD_HAND_TRIGGERED: 'verdict',
  GAME_OVER: 'verdict',
  UNIT_MOVED: 'move',
  MOVE_FAILED: 'move',
  MARCH_DETECTED: 'move',
  DRONE_RESPAWNED: 'respawn',
};

/**
 * How long each beat lasts, in ms — the timing knobs.
 *
 * Tuned so a busy round (recon, a volley, impacts, damage, movement) plays in
 * roughly 4–6 seconds: slow enough that the replay explains the round by itself
 * and the player should not need the event log to follow it (designer's call,
 * 2026-09-28). A quiet round (a drone hovering, a launcher moving) is ~2 s.
 */
export const CUE_DURATION: Record<Cue, number> = {
  fly: 1000,
  spot: 500,
  downed: 600,
  launch: 700,
  intercept: 500,
  exposed: 500,
  impact: 500,
  damage: 600,
  verdict: 1200,
  move: 700,
  respawn: 400,
};

/** The on-screen caption for each beat, so the replay says what phase it is in. */
export const CUE_CAPTION: Record<Cue, string> = {
  fly: 'Recon',
  spot: 'Recon',
  downed: 'Recon',
  launch: 'Launches & intercepts',
  intercept: 'Launches & intercepts',
  exposed: 'Launches & intercepts',
  impact: 'Impacts',
  damage: 'Impacts',
  verdict: 'Verdict',
  move: 'Movement',
  respawn: 'Drone respawn',
};

/** A pause before the first beat, so the old board registers before it moves. */
export const LEAD_IN = 300;

/** The pause between beats. */
export const BEAT_GAP = 150;

/** How long the finished picture holds before the board settles, so the end of
 *  the round registers instead of snapping away on the last frame. */
export const HOLD_END = 800;

/** One event, placed on the timeline. */
export interface Clip {
  event: VisibleEvent;
  cue: Cue;
  /** ms from the start of the replay. */
  start: number;
  /** ms. */
  duration: number;
}

/** A run of neighbouring same-cue events, all starting together. */
export interface Beat {
  cue: Cue;
  start: number;
  duration: number;
}

export interface Timeline {
  clips: Clip[];
  beats: Beat[];
  /** Total length in ms, including `HOLD_END`; 0 for an empty event list. */
  duration: number;
}

/** Where one clip is at time t. `progress` runs 0..1 and stays at 1 once the
 *  clip is over, so a clip can hold its end pose until the replay settles. */
export interface ClipFrame {
  clip: Clip;
  progress: number;
}

/**
 * Lay an event list out in time — in the order given, never re-sorted (§6).
 */
export function buildTimeline(events: readonly VisibleEvent[]): Timeline {
  const clips: Clip[] = [];
  const beats: Beat[] = [];
  let cursor = LEAD_IN;

  for (const event of events) {
    const cue = CUE_OF[event.type];
    let beat = beats[beats.length - 1];

    if (!beat || beat.cue !== cue) {
      if (beat) cursor = beat.start + beat.duration + BEAT_GAP;
      beat = { cue, start: cursor, duration: CUE_DURATION[cue] };
      beats.push(beat);
    }

    clips.push({ event, cue, start: beat.start, duration: beat.duration });
  }

  const last = beats[beats.length - 1];
  return {
    clips,
    beats,
    duration: last ? last.start + last.duration + HOLD_END : 0,
  };
}

/** Every clip that has started by `t`, with how far through it is. */
export function frameAt(timeline: Timeline, t: number): ClipFrame[] {
  const frames: ClipFrame[] = [];
  for (const clip of timeline.clips) {
    if (clip.start > t) continue;
    const progress =
      clip.duration > 0 ? Math.min(1, (t - clip.start) / clip.duration) : 1;
    frames.push({ clip, progress });
  }
  return frames;
}

/** The caption of the beat currently playing (or last played), or null before
 *  the first one starts. */
export function captionAt(timeline: Timeline, t: number): string | null {
  let caption: string | null = null;
  for (const beat of timeline.beats) {
    if (beat.start > t) break;
    caption = CUE_CAPTION[beat.cue];
  }
  return caption;
}

/**
 * The viewer's own pieces the static units layer should NOT draw right now,
 * because a clip is drawing them instead: a launcher sliding along its move, or
 * the drone flying its path. Hidden from the moment their clip starts, so the
 * board never shows the same unit twice.
 *
 * Only owner-only events are consulted, so every id here is the viewer's own
 * (spec §6) — nothing about the enemy can reach the units layer this way.
 */
export function hiddenUnitIds(frames: readonly ClipFrame[]): Set<UnitId> {
  const hidden = new Set<UnitId>();
  for (const { clip } of frames) {
    const { event } = clip;
    if (event.type === 'UNIT_MOVED' || event.type === 'DRONE_MOVED') {
      hidden.add(event.unitId);
    }
  }
  return hidden;
}
