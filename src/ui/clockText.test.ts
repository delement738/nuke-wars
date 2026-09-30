import { describe, expect, it } from 'vitest';
import { clockText, clockUrgent, secondsLeft, shouldTick } from './clockText';

describe('the order clock display', () => {
  it('rounds up, and never goes below zero', () => {
    expect(secondsLeft(25_000, 0)).toBe(25);
    expect(secondsLeft(25_000, 24_001)).toBe(1);
    expect(secondsLeft(25_000, 25_000)).toBe(0);
    expect(secondsLeft(25_000, 99_000)).toBe(0);
  });

  it('reads as m:ss', () => {
    expect(clockText(30)).toBe('0:30');
    expect(clockText(9)).toBe('0:09');
    expect(clockText(75)).toBe('1:15');
  });

  it('turns red at 10 seconds and below', () => {
    expect(clockUrgent(11)).toBe(false);
    expect(clockUrgent(10)).toBe(true);
    expect(clockUrgent(0)).toBe(true);
  });

  it('ticks once a second from 10 to 1, only while orders are still owed', () => {
    expect(shouldTick(11, false, null)).toBe(false);
    expect(shouldTick(10, false, null)).toBe(true);
    expect(shouldTick(10, false, 10)).toBe(false); // same second: once only
    expect(shouldTick(9, false, 10)).toBe(true);
    expect(shouldTick(1, false, 2)).toBe(true);
    expect(shouldTick(0, false, 1)).toBe(false); // time is up: no tick at zero
    expect(shouldTick(5, true, 6)).toBe(false); // sent: the opponent's time
  });
});
