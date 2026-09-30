import { describe, expect, it } from 'vitest';
import { clientIp, createBucket, createIpLedger, originAllowed, parseOrigins } from './guard';

describe('the origin check', () => {
  const allowed = parseOrigins(
    'https://nuke-wars.vercel.app, https://nuke-wars-*-delement738s-projects.vercel.app/ ,http://localhost:5173',
  );

  it('reads the setting as a list, trimming spaces and trailing slashes', () => {
    expect(allowed).toEqual([
      'https://nuke-wars.vercel.app',
      'https://nuke-wars-*-delement738s-projects.vercel.app',
      'http://localhost:5173',
    ]);
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins(' , ')).toEqual([]);
  });

  it('lets in the live site, preview links and local development', () => {
    expect(originAllowed('https://nuke-wars.vercel.app', allowed)).toBe(true);
    expect(originAllowed('https://nuke-wars-git-feat-x-delement738s-projects.vercel.app', allowed)).toBe(true);
    expect(originAllowed('http://localhost:5173', allowed)).toBe(true);
  });

  it('refuses any other site, including look-alikes', () => {
    expect(originAllowed('https://evil.example', allowed)).toBe(false);
    expect(originAllowed('https://nuke-wars.vercel.app.evil.example', allowed)).toBe(false);
    expect(originAllowed('https://nuke-warsXvercel.app', allowed)).toBe(false);
    expect(originAllowed('http://nuke-wars.vercel.app', allowed)).toBe(false);
    // The wildcard never spans a path, so it cannot swallow a whole other address.
    expect(originAllowed('https://nuke-wars-a/b-delement738s-projects.vercel.app', allowed)).toBe(false);
  });

  it('refuses a handshake with no origin at all once a list is set', () => {
    expect(originAllowed(undefined, allowed)).toBe(false);
  });

  it('checks nothing when no list is set (local development)', () => {
    expect(originAllowed('https://anything.example', [])).toBe(true);
    expect(originAllowed(undefined, [])).toBe(true);
  });
});

describe('who a visitor is', () => {
  it('behind a proxy, takes the last forwarded address — the one the proxy wrote', () => {
    const headers = { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' };
    expect(clientIp(headers, '10.0.0.1', true)).toBe('203.0.113.9');
  });

  it('without a proxy, ignores the header anyone could send', () => {
    const headers = { 'x-forwarded-for': '6.6.6.6' };
    expect(clientIp(headers, '198.51.100.2', false)).toBe('198.51.100.2');
  });

  it('falls back to the socket address when the proxy sent nothing', () => {
    expect(clientIp({}, '198.51.100.2', true)).toBe('198.51.100.2');
    expect(clientIp({}, undefined, false)).toBe('unknown');
  });
});

describe('token buckets', () => {
  it('allows a burst, then one per refill', () => {
    const bucket = createBucket(3, 2, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.take(400)).toBe(false); // 0.8 of a token
    expect(bucket.take(500)).toBe(true); // 1.0
    expect(bucket.take(500)).toBe(false);
  });

  it('never saves up more than the burst, however long it waits', () => {
    const bucket = createBucket(2, 1, 0);
    const later = 1_000_000;
    expect([bucket.take(later), bucket.take(later), bucket.take(later)]).toEqual([true, true, false]);
  });
});

describe('per-address counts', () => {
  it('caps open connections per address, and frees a place when one closes', () => {
    const ledger = createIpLedger({ connectionsPerIp: 2, roomsPerMinutePerIp: 10 });
    expect(ledger.openConnection('a')).toBe(true);
    expect(ledger.openConnection('a')).toBe(true);
    expect(ledger.openConnection('a')).toBe(false);
    expect(ledger.openConnection('b')).toBe(true);
    ledger.closeConnection('a');
    expect(ledger.openConnection('a')).toBe(true);
  });

  it('counts room creations over a sliding minute', () => {
    const ledger = createIpLedger({ connectionsPerIp: 8, roomsPerMinutePerIp: 2 });
    expect(ledger.createRoom('a', 0)).toBe(true);
    expect(ledger.createRoom('a', 30_000)).toBe(true);
    expect(ledger.createRoom('a', 59_999)).toBe(false);
    expect(ledger.createRoom('a', 60_000)).toBe(true); // the first has aged out
    expect(ledger.createRoom('a', 60_001)).toBe(false);
  });
});
