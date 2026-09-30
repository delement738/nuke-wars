import { describe, expect, it } from 'vitest';
import { LIMITS, PROTOCOL_VERSION, parseClientMessage, parseServerMessage } from './protocol';

const json = (value: unknown) => JSON.stringify(value);

describe('parseClientMessage', () => {
  it('reads every message a browser may send', () => {
    expect(parseClientMessage(json({ type: 'create', version: PROTOCOL_VERSION }))).toEqual({
      type: 'create',
      version: PROTOCOL_VERSION,
    });
    expect(parseClientMessage(json({ type: 'join', version: 1, room: 'ABC234' }))).toEqual({
      type: 'join',
      version: 1,
      room: 'ABC234',
    });
    expect(
      parseClientMessage(json({ type: 'setup', setup: [{ kind: 'bunker', hex: { q: 3, r: 14 } }] })),
    ).toEqual({ type: 'setup', setup: [{ kind: 'bunker', hex: { q: 3, r: 14 } }] });
    expect(
      parseClientMessage(
        json({
          type: 'orders',
          orders: [
            { type: 'MOVE', unitId: 'a', destination: { q: 1, r: 2 } },
            { type: 'MARCH', unitId: 'b', destination: { q: 1, r: 2 } },
            { type: 'LAUNCH', unitId: 'c', target: { q: -1, r: 9 } },
            { type: 'FLY', unitId: 'd', destination: { q: 0, r: 0 } },
          ],
        }),
      ),
    ).toMatchObject({ type: 'orders', orders: { length: 4 } });
    expect(parseClientMessage(json({ type: 'resign' }))).toEqual({ type: 'resign' });
  });

  it('accepts an empty order list — holding everything is a legal round', () => {
    expect(parseClientMessage(json({ type: 'orders', orders: [] }))).toEqual({
      type: 'orders',
      orders: [],
    });
  });

  it('drops fields the protocol does not have, so nothing extra reaches the server', () => {
    const parsed = parseClientMessage(
      json({
        type: 'orders',
        player: 'p2',
        orders: [{ type: 'LAUNCH', unitId: 'x', target: { q: 1, r: 1, owner: 'p2' }, extra: 1 }],
      }),
    );
    expect(parsed).toEqual({
      type: 'orders',
      orders: [{ type: 'LAUNCH', unitId: 'x', target: { q: 1, r: 1 } }],
    });
  });

  it.each([
    ['not JSON', '{nope'],
    ['a bare array', '[]'],
    ['an unknown type', json({ type: 'teleport' })],
    ['create without a version', json({ type: 'create' })],
    ['join without a room', json({ type: 'join', version: 1 })],
    ['join with a numeric token', json({ type: 'join', version: 2, room: 'ABC234', token: 5 })],
    ['join with an enormous token', json({ type: 'join', version: 2, room: 'ABC234', token: 'x'.repeat(500) })],
    ['a fractional hex', json({ type: 'setup', setup: [{ kind: 'bunker', hex: { q: 1.5, r: 2 } }] })],
    ['a string hex', json({ type: 'setup', setup: [{ kind: 'bunker', hex: { q: '1', r: 2 } }] })],
    ['a huge hex', json({ type: 'setup', setup: [{ kind: 'bunker', hex: { q: 1e9, r: 2 } }] })],
    ['a launcher placement', json({ type: 'setup', setup: [{ kind: 'launcher', hex: { q: 1, r: 2 } }] })],
    ['an unknown order', json({ type: 'orders', orders: [{ type: 'NUKE', unitId: 'a' }] })],
    ['a launch with no target', json({ type: 'orders', orders: [{ type: 'LAUNCH', unitId: 'a' }] })],
    ['an order with no unit', json({ type: 'orders', orders: [{ type: 'FLY', destination: { q: 0, r: 0 } }] })],
    ['orders that are not a list', json({ type: 'orders', orders: {} })],
  ])('refuses %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('reads a join with the token of a seat to take back, and drops fields it does not know', () => {
    expect(
      parseClientMessage(json({ type: 'join', version: 2, room: 'ABC234', token: 'abc-123', player: 'p2' })),
    ).toEqual({ type: 'join', version: 2, room: 'ABC234', token: 'abc-123' });
  });

  it('refuses a list longer than an honest client could send', () => {
    const order = { type: 'FLY', unitId: 'd', destination: { q: 0, r: 0 } };
    const orders = Array.from({ length: LIMITS.maxOrders + 1 }, () => order);
    expect(parseClientMessage(json({ type: 'orders', orders }))).toBeNull();
  });

  it('refuses an over-long unit id and an oversized message', () => {
    const unitId = 'x'.repeat(LIMITS.maxIdLength + 1);
    expect(
      parseClientMessage(json({ type: 'orders', orders: [{ type: 'FLY', unitId, destination: { q: 0, r: 0 } }] })),
    ).toBeNull();
    expect(parseClientMessage(json({ type: 'resign', pad: 'x'.repeat(LIMITS.maxMessageBytes) }))).toBeNull();
  });
});

describe('parseServerMessage', () => {
  it('reads the server message types and refuses anything else', () => {
    expect(parseServerMessage(json({ type: 'opponent', present: true }))).toEqual({
      type: 'opponent',
      present: true,
    });
    expect(parseServerMessage('<html>Bad gateway</html>')).toBeNull();
    expect(parseServerMessage(json({ type: 'create' }))).toBeNull();
  });
});
