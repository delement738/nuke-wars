// Who fills each seat, and whose turn it is (build-order step 10c).
//
// Pure functions with no store behind them, so these are the cheap tests — the
// turn rotation is exercised end-to-end in `hotseat.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  HOTSEAT_SEATS,
  SOLO_SEATS,
  humanSeats,
  isHotseat,
  nextSeat,
  openingSeat,
} from './seats';

const always = () => true;
const never = () => false;

describe('humanSeats', () => {
  it('lists only the human seats, in PLAYERS order', () => {
    expect(humanSeats(SOLO_SEATS)).toEqual(['p1']);
    expect(humanSeats(HOTSEAT_SEATS)).toEqual(['p1', 'p2']);
    expect(humanSeats({ p1: 'cpu', p2: 'human' })).toEqual(['p2']);
    expect(humanSeats({ p1: 'cpu', p2: 'cpu' })).toEqual([]);
  });
});

describe('isHotseat', () => {
  it('is true only when both seats are human', () => {
    expect(isHotseat(SOLO_SEATS)).toBe(false);
    expect(isHotseat(HOTSEAT_SEATS)).toBe(true);
    expect(isHotseat({ p1: 'cpu', p2: 'cpu' })).toBe(false);
  });
});

describe('openingSeat', () => {
  it('picks the first human with something to do', () => {
    expect(openingSeat(HOTSEAT_SEATS, always)).toBe('p1');
    expect(openingSeat(SOLO_SEATS, always)).toBe('p1');
    expect(openingSeat({ p1: 'cpu', p2: 'human' }, always)).toBe('p2');
  });

  /**
   * The dead-hand skip (spec §3, gotcha 41c). Only the player facing the dead
   * hand has orderable units, and handing the screen to someone with nothing to
   * decide would strand the round — their draft can never complete.
   */
  it('skips a human with nothing to decide', () => {
    expect(openingSeat(HOTSEAT_SEATS, (p) => p === 'p2')).toBe('p2');
  });

  it('returns null when no human has anything to decide — the cue to resolve', () => {
    expect(openingSeat(HOTSEAT_SEATS, never)).toBeNull();
    expect(openingSeat({ p1: 'cpu', p2: 'cpu' }, always)).toBeNull();
  });
});

describe('nextSeat', () => {
  it('moves to the following human seat', () => {
    expect(nextSeat(HOTSEAT_SEATS, 'p1', always)).toBe('p2');
  });

  /**
   * **It must not wrap.** One pass over the human seats is one round of
   * drafting, so reaching the end means everybody has had their turn and the
   * round should resolve — not that it is p1's go again, which would be a
   * hotseat game that never resolves anything.
   */
  it('returns null after the last seat rather than wrapping', () => {
    expect(nextSeat(HOTSEAT_SEATS, 'p2', always)).toBeNull();
    expect(nextSeat(SOLO_SEATS, 'p1', always)).toBeNull();
  });

  it('skips a following seat with nothing to decide', () => {
    expect(nextSeat(HOTSEAT_SEATS, 'p1', never)).toBeNull();
  });

  it('treats a CPU seat as not a stop on the rotation', () => {
    // p2 is the CPU here, so p1 is both the first and the last human seat.
    expect(nextSeat(SOLO_SEATS, 'p1', always)).toBeNull();
  });
});
