// AUDIO — which sound the replay plays, and when (V1.5 Session 4).
//
// Pure, like `../render/timeline`: a timeline goes in, a list of timed sounds
// comes out, and `GameCanvas` plays each one as its moment passes. Nothing here
// touches Web Audio, so everything about *which* sound and *when* is testable.
//
// **Sound is drawn from the same filtered events as the picture, and says no
// more than it does** (spec §6; gotchas 60, 69). Two rules carry that:
//
//   1. **One thump for every impact, whatever it hit.** A sound keyed to the
//      damage events after it would be the bunker detector `IMPACT`'s design
//      exists to prevent: fire blind, listen for the louder bang. `soundCues`
//      is handed the timeline and nothing else about a hit.
//   2. **The damage beat is silent** (`SOUND_OF.damage` is null). A real bunker
//      takes a hit in silence where a decoy dies; that difference is what the
//      attacker pays a missile to learn, and it must stay in the log and on the
//      board, not be sharpened into a sting.
//
// One sound per BEAT, not per event: neighbouring events of one cue start
// together (spec §3's simultaneous orders), so a three-missile volley is one
// klaxon, not three stacked on top of each other.

import { DIVE, type Cue, type Timeline } from '../render/timeline';
import type { MissileId } from '../sim/types';

/** The sounds, from `docs/art-direction.md` (Motion and sound). `tick` is the
 *  order clock's last ten seconds (V1.5 Session 7), not a replay beat. */
export type Sound = 'click' | 'klaxon' | 'thump' | 'relay' | 'tick';

/**
 * Which sound each beat makes. A `Record` over every cue, so a new cue fails to
 * compile here until someone decides whether it is heard (the gotcha-53 lesson).
 */
export const SOUND_OF: Record<Cue, Sound | null> = {
  fly: null,
  spot: null,
  downed: null,
  launch: 'klaxon',
  intercept: 'relay',
  exposed: null,
  impact: 'thump',
  // Silent on purpose — see rule 2 above.
  damage: null,
  verdict: null,
  move: null,
  respawn: null,
};

/** One sound, placed on the replay's clock. */
export interface SoundCue {
  /** ms from the start of the replay, on the same clock as `frameAt`. */
  at: number;
  sound: Sound;
}

/**
 * The replay's sounds, in time order.
 *
 * An intercept or impact clip may open with a carried missile's dive before its
 * burst (`DIVE`), so its sound waits for the first burst in the beat rather than
 * the beat's start — a thump before the missile arrives would be a sound track
 * out of step with its picture. `hasDive` answers from the flight plan (whether
 * the missile has a `finalLeg`), which comes from public launches only.
 */
export function soundCues(
  timeline: Timeline,
  hasDive: (id: MissileId) => boolean,
): SoundCue[] {
  const cues: SoundCue[] = [];
  for (const beat of timeline.beats) {
    const sound = SOUND_OF[beat.cue];
    if (!sound) continue;

    let offset = 0;
    if (beat.cue === 'impact' || beat.cue === 'intercept') {
      const clips = timeline.clips.filter((clip) => clip.start === beat.start);
      const allDive = clips.every(
        ({ event }) =>
          (event.type === 'IMPACT' || event.type === 'MISSILE_INTERCEPTED') &&
          hasDive(event.missileId),
      );
      if (allDive) offset = beat.duration * DIVE;
    }
    cues.push({ at: beat.start + offset, sound });
  }
  return cues;
}
