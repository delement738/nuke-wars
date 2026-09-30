import { describe, expect, it } from 'vitest';
import { clockText, clockUrgent, secondsLeft } from './clockText';

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
});
