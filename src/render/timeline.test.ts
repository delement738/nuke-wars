// The replay timeline (presentation phase, session 1). Pure — no Pixi, no store.

import { describe, expect, it } from 'vitest';
import type { Hex } from '../sim/hex';
import type { VisibleEvent } from '../sim/types';
import {
  BEAT_GAP,
  CUE_DURATION,
  HOLD_END,
  LEAD_IN,
  buildTimeline,
  captionAt,
  frameAt,
  hiddenMissileIds,
  hiddenUnitIds,
} from './timeline';

const h = (q: number, r: number): Hex => ({ q, r });

const droneMoved: VisibleEvent = {
  type: 'DRONE_MOVED',
  unitId: 'p1-drone',
  owner: 'p1',
  from: h(0, 0),
  to: h(0, 2),
  path: [h(0, 0), h(0, 1), h(0, 2)],
};
const spotted = (q: number): VisibleEvent => ({
  type: 'ASSET_SPOTTED',
  kind: 'launcher',
  hex: h(q, 3),
  owner: 'p2',
});
const launch = (q: number): VisibleEvent => ({
  type: 'LAUNCH_DETECTED',
  missileId: `m${q}`,
  origin: h(q, 0),
  target: h(q, 4),
});
const impact = (q: number): VisibleEvent => ({ type: 'IMPACT', missileId: `m${q}`, hex: h(q, 4) });
const moved: VisibleEvent = {
  type: 'UNIT_MOVED',
  unitId: 'p1-launcher-1',
  owner: 'p1',
  from: h(1, 1),
  to: h(1, 2),
};
const destroyed: VisibleEvent = {
  type: 'UNIT_DESTROYED',
  unitId: 'p1-launcher-2',
  kind: 'launcher',
  hex: h(2, 2),
};

describe('buildTimeline', () => {
  it('is empty for an empty log', () => {
    const timeline = buildTimeline([]);
    expect(timeline).toEqual({ clips: [], beats: [], duration: 0 });
    expect(frameAt(timeline, 1000)).toEqual([]);
    expect(captionAt(timeline, 1000)).toBeNull();
  });

  it('groups neighbouring same-cue events into one beat that starts together', () => {
    const timeline = buildTimeline([droneMoved, spotted(1), spotted(2), launch(1), launch(2), impact(1), moved]);

    expect(timeline.beats.map((b) => b.cue)).toEqual(['fly', 'spot', 'launch', 'impact', 'move']);
    const [, s1, s2, l1, l2] = timeline.clips;
    expect(s1.start).toBe(s2.start);
    expect(l1.start).toBe(l2.start);
    expect(l1.start).toBeGreaterThan(s1.start);
  });

  /**
   * **Never re-sort** (spec §6: "a client can animate straight through the
   * array without sorting"). Fed deliberately out of phase order, the timeline
   * must keep the order it was given — sorting by phase here would reorder a
   * dead-hand round's repeated passes and fail the next test too.
   */
  it('keeps the order it is given rather than sorting by phase', () => {
    const timeline = buildTimeline([moved, droneMoved, impact(1)]);
    expect(timeline.beats.map((b) => b.cue)).toEqual(['move', 'fly', 'impact']);
  });

  it('plays a dead-hand round’s repeated launch → impact passes as separate beats', () => {
    const timeline = buildTimeline([
      launch(1),
      impact(1),
      launch(2),
      impact(2),
      { type: 'GAME_OVER', outcome: { type: 'ARMISTICE' } },
    ]);
    expect(timeline.beats.map((b) => b.cue)).toEqual(['launch', 'impact', 'launch', 'impact', 'verdict']);
  });

  it('spaces beats by their duration plus the gap, after a lead-in, and holds the end', () => {
    const timeline = buildTimeline([droneMoved, launch(1), moved]);
    const [fly, shot, move] = timeline.beats;

    expect(fly.start).toBe(LEAD_IN);
    expect(shot.start).toBe(fly.start + CUE_DURATION.fly + BEAT_GAP);
    expect(move.start).toBe(shot.start + CUE_DURATION.launch + BEAT_GAP);
    expect(timeline.duration).toBe(move.start + CUE_DURATION.move + HOLD_END);
  });

  /** The designer asked for 4–6 s on a busy round (2026-09-28). */
  it('plays a busy round in roughly four to six seconds', () => {
    const busy = buildTimeline([droneMoved, spotted(1), launch(1), impact(1), destroyed, moved]);
    expect(busy.duration).toBeGreaterThanOrEqual(4000);
    expect(busy.duration).toBeLessThanOrEqual(6000);
  });
});

describe('frameAt', () => {
  const timeline = buildTimeline([droneMoved, launch(1)]);
  const [fly, shot] = timeline.beats;

  it('shows nothing before the first beat', () => {
    expect(frameAt(timeline, LEAD_IN - 1)).toEqual([]);
  });

  it('reports progress through a playing clip', () => {
    const frames = frameAt(timeline, fly.start + fly.duration / 2);
    expect(frames).toHaveLength(1);
    expect(frames[0].progress).toBeCloseTo(0.5);
  });

  it('holds a finished clip at progress 1 while later ones play', () => {
    const frames = frameAt(timeline, shot.start + 1);
    expect(frames.map((f) => f.clip.cue)).toEqual(['fly', 'launch']);
    expect(frames[0].progress).toBe(1);
    expect(frames[1].progress).toBeLessThan(1);
  });

  it('never runs past 1, however late it is asked', () => {
    for (const frame of frameAt(timeline, 1e9)) expect(frame.progress).toBe(1);
  });
});

describe('captionAt', () => {
  it('names the phase of the beat playing', () => {
    const timeline = buildTimeline([droneMoved, launch(1), impact(1), moved]);
    const [fly, shot, hit, move] = timeline.beats;
    expect(captionAt(timeline, 0)).toBeNull();
    expect(captionAt(timeline, fly.start)).toBe('Recon');
    expect(captionAt(timeline, shot.start)).toBe('Launches & intercepts');
    expect(captionAt(timeline, hit.start + 1)).toBe('Impacts');
    expect(captionAt(timeline, move.start + 1)).toBe('Movement');
  });
});

describe('hiddenUnitIds', () => {
  const timeline = buildTimeline([droneMoved, destroyed, moved]);
  const [fly, , move] = timeline.beats;

  it('hides nothing before any clip starts', () => {
    expect(hiddenUnitIds(frameAt(timeline, 0)).size).toBe(0);
  });

  it('hides the drone from the moment its flight starts, and the launcher from its move', () => {
    expect([...hiddenUnitIds(frameAt(timeline, fly.start))]).toEqual(['p1-drone']);
    expect(hiddenUnitIds(frameAt(timeline, move.start))).toEqual(
      new Set(['p1-drone', 'p1-launcher-1']),
    );
  });

  it('does not hide a destroyed unit — the X is drawn over it', () => {
    expect(hiddenUnitIds(frameAt(timeline, 1e9)).has('p1-launcher-2')).toBe(false);
  });
});

describe('hiddenMissileIds', () => {
  const timeline = buildTimeline([launch(1), impact(1)]);
  const [shot, hit] = timeline.beats;

  it('keeps a parked missile on the board until its own impact clip starts', () => {
    expect(hiddenMissileIds(frameAt(timeline, shot.start)).size).toBe(0);
    expect([...hiddenMissileIds(frameAt(timeline, hit.start))]).toEqual(['m1']);
  });
});
