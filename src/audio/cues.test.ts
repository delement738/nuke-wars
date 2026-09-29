// The replay's sound track (V1.5 Session 4). Pure — no Web Audio, no store.

import { describe, expect, it } from 'vitest';
import type { Hex } from '../sim/hex';
import type { MissileId, VisibleEvent } from '../sim/types';
import { CUE_DURATION, DIVE, LEAD_IN, buildTimeline } from '../render/timeline';
import { SOUND_OF, soundCues } from './cues';

const h = (q: number, r: number): Hex => ({ q, r });
const launch = (q: number): VisibleEvent => ({
  type: 'LAUNCH_DETECTED',
  missileId: `m${q}`,
  origin: h(q, 0),
  target: h(q, 4),
});
const impact = (q: number): VisibleEvent => ({ type: 'IMPACT', missileId: `m${q}`, hex: h(q, 4) });
const intercepted = (q: number): VisibleEvent => ({
  type: 'MISSILE_INTERCEPTED',
  missileId: `m${q}`,
  hex: h(q, 2),
});
const moved: VisibleEvent = {
  type: 'UNIT_MOVED',
  unitId: 'p1-l1',
  owner: 'p1',
  from: h(1, 1),
  to: h(1, 2),
};

const noDive = () => false;

describe('soundCues', () => {
  it('plays a klaxon for launches, a relay for intercepts and a thump for impacts, in order', () => {
    const t = buildTimeline([launch(1), intercepted(1), impact(2)]);
    expect(soundCues(t, noDive).map((c) => c.sound)).toEqual(['klaxon', 'relay', 'thump']);
    const at = soundCues(t, noDive).map((c) => c.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(at[0]).toBe(LEAD_IN);
  });

  it('plays one sound per beat, not one per missile', () => {
    const t = buildTimeline([launch(1), launch(2), launch(3), impact(1), impact(2), impact(3)]);
    expect(soundCues(t, noDive).map((c) => c.sound)).toEqual(['klaxon', 'thump']);
  });

  it('a quiet round (movement only) is silent', () => {
    expect(soundCues(buildTimeline([moved]), noDive)).toEqual([]);
  });

  // Gotchas 60 and 69: the sound of an impact must not say what it hit.
  it('an impact sounds the same whether it hit bare ground, a launcher, the bunker or the decoy', () => {
    const bare = soundCues(buildTimeline([impact(1)]), noDive);
    const hits: VisibleEvent[][] = [
      [impact(1), { type: 'BUNKER_HIT', unitId: 'p2-bunker', owner: 'p2', hex: h(1, 4), hpRemaining: 1 }],
      [impact(1), { type: 'UNIT_DESTROYED', unitId: 'p2-decoy', kind: 'decoy', hex: h(1, 4) }],
      [impact(1), { type: 'UNIT_DESTROYED', unitId: 'p2-bunker', kind: 'bunker', hex: h(1, 4) }],
      [impact(1), { type: 'UNIT_DESTROYED', unitId: 'p2-l1', kind: 'launcher', hex: h(1, 4) }],
    ];
    for (const events of hits) {
      expect(soundCues(buildTimeline(events), noDive)).toEqual(bare);
    }
  });

  it('the damage beat is silent', () => {
    expect(SOUND_OF.damage).toBeNull();
  });

  it("waits for the burst when every missile in the beat dives in first", () => {
    const t = buildTimeline([impact(1)]);
    const [cue] = soundCues(t, () => true);
    expect(cue.at).toBe(LEAD_IN + CUE_DURATION.impact * DIVE);
  });

  it('plays at the first burst when only some missiles dive', () => {
    const t = buildTimeline([impact(1), impact(2)]);
    const [cue] = soundCues(t, (id: MissileId) => id === 'm1');
    expect(cue.at).toBe(LEAD_IN);
  });
});
