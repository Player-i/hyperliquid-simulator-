import { describe, expect, it } from 'vitest';
import { Engine, newState, DEFAULT_SETTINGS, type Book } from './engine';
import { isValidPrice, roundPrice, roundSize } from './rules';

const T0 = 1_800_000_000_000;

function mkEngine(balance = 10_000) {
  const e = new Engine(newState({ ...DEFAULT_SETTINGS, latencyMs: 0, startingBalance: balance }, T0));
  e.setAssets([
    { coin: 'BTC', szDecimals: 5, maxLeverage: 40, tiers: [{ lowerBound: 0, maxLeverage: 40 }, { lowerBound: 150_000_000, maxLeverage: 20 }] },
    { coin: 'ETH', szDecimals: 4, maxLeverage: 25, tiers: [{ lowerBound: 0, maxLeverage: 25 }] },
  ]);
  return e;
}

function book(time: number, bids: [number, number][], asks: [number, number][]): Book {
  return {
    coin: 'BTC', time,
    bids: bids.map(([px, sz]) => ({ px, sz, n: 1 })),
    asks: asks.map(([px, sz]) => ({ px, sz, n: 1 })),
  };
}

const BOOK = book(T0, [[59999, 1], [59998, 2], [59990, 5]], [[60001, 0.5], [60002, 1], [60010, 5]]);

describe('rules', () => {
  it('rounds prices to 5 sig figs and max decimals', () => {
    expect(roundPrice(60031.4, 5)).toBe(60031);
    expect(roundPrice(1.234567, 0)).toBe(1.2346);
    expect(roundPrice(0.000123456, 0)).toBe(0.000123);
    expect(roundPrice(3456.78, 4)).toBe(3456.8);
    expect(isValidPrice(123456, 5)).toBe(true);
    expect(isValidPrice(3456.78, 4)).toBe(false);
    expect(roundSize(0.123456789, 5)).toBe(0.12345);
  });
});

describe('taker execution against the live book', () => {
  it('market buy walks multiple levels', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.onCtxs({ BTC: { markPx: 60000, oraclePx: 60000, funding: 0.0000125, midPx: 60000 } }, T0);
    e.setLeverage('BTC', 10, 'cross');
    const r = e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 1 }, T0);
    expect(r.ok).toBe(true);
    const fills = e.state.fills.slice().reverse();
    expect(fills.map((f) => [f.px, f.sz])).toEqual([[60001, 0.5], [60002, 0.5]]);
    const pos = e.state.positions.BTC;
    expect(pos.szi).toBeCloseTo(1);
    expect(pos.entryPx).toBeCloseTo(60001.5);
    const fees = fills.reduce((a, f) => a + f.fee, 0);
    expect(fees).toBeCloseTo(60001.5 * 0.00045, 4);
    expect(e.state.cash).toBeCloseTo(10_000 - fees, 6);
  });

  it('consumed liquidity is not reused until the book refreshes', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.5 }, T0);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.5 }, T0);
    expect(e.state.fills[0].px).toBe(60002);
  });

  it('rejects post-only that would cross', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    const msgs: string[] = [];
    e.onEvent = (ev) => msgs.push(ev.msg);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 60005, sz: 0.1, tif: 'Alo' }, T0);
    expect(msgs[0]).toMatch(/Post only/);
    expect(e.state.orders.length).toBe(0);
  });

  it('crossing limit takes then rests remainder', () => {
    const e = mkEngine(100_000);
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 60001, sz: 0.8 }, T0);
    expect(e.state.positions.BTC.szi).toBeCloseTo(0.5);
    expect(e.state.orders[0].sz).toBeCloseTo(0.3);
    expect(e.state.orders[0].status).toBe('open');
  });

  it('enforces margin', () => {
    const e = mkEngine(100);
    e.onBook(BOOK);
    e.setLeverage('BTC', 1, 'cross');
    const msgs: string[] = [];
    e.onEvent = (ev) => msgs.push(ev.msg);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.01 }, T0);
    expect(msgs[0]).toMatch(/Insufficient margin/);
  });
});

describe('resting order queue simulation', () => {
  it('fills only after the queue ahead trades through', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 59999, sz: 0.2 }, T0);
    const o = e.state.orders[0];
    expect(o.queueAhead).toBe(1);
    // 0.7 sold into the bid: still 0.3 ahead of us
    e.onTrades([{ coin: 'BTC', side: 'A', px: 59999, sz: 0.7, time: T0 + 10 }]);
    expect(e.state.positions.BTC).toBeUndefined();
    expect(o.queueAhead).toBeCloseTo(0.3);
    // 0.4 more: 0.3 clears queue, 0.1 fills us
    e.onTrades([{ coin: 'BTC', side: 'A', px: 59999, sz: 0.4, time: T0 + 20 }]);
    expect(e.state.positions.BTC.szi).toBeCloseTo(0.1);
    expect(e.state.fills[0].liquidity).toBe('maker');
    expect(e.state.fills[0].fee).toBeCloseTo(59999 * 0.1 * 0.00015, 6);
  });

  it('book snapshot reflecting trades does not double count', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 59999, sz: 0.2 }, T0);
    // book arrives first showing level reduced 1 -> 0.3 due to a 0.7 trade
    e.onBook(book(T0 + 100, [[59999, 0.3], [59998, 2]], [[60001, 0.5]]));
    e.onTrades([{ coin: 'BTC', side: 'A', px: 59999, sz: 0.7, time: T0 + 100 }]);
    expect(e.state.positions.BTC).toBeUndefined();
    expect(e.state.orders[0].queueAhead).toBeCloseTo(0.3);
  });

  it('ignores trades already reflected in the book we joined on', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 59999, sz: 0.2 }, T0);
    e.onTrades([{ coin: 'BTC', side: 'A', px: 59999, sz: 5, time: T0 - 1 }]);
    expect(e.state.positions.BTC).toBeUndefined();
    expect(e.state.orders[0].queueAhead).toBe(1);
  });

  it('cancellations ahead move us up the queue', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 59998, sz: 0.2 }, T0);
    e.onBook(book(T0 + 100, [[59999, 1], [59998, 0.5]], [[60001, 0.5]]));
    expect(e.state.orders[0].queueAhead).toBeCloseTo(0.5);
  });

  it('trade through our price fills fully', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 59998, sz: 0.2 }, T0);
    e.onTrades([{ coin: 'BTC', side: 'A', px: 59997, sz: 0.01, time: T0 + 10 }]);
    expect(e.state.positions.BTC.szi).toBeCloseTo(0.2);
    expect(e.state.positions.BTC.entryPx).toBe(59998);
  });
});

describe('pnl, triggers, liquidation, funding', () => {
  it('realizes pnl on close', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.1 }, T0);
    e.onBook(book(T0 + 1000, [[61000, 1]], [[61001, 1]]));
    const r = e.closePosition('BTC');
    expect(r.ok).toBe(true);
    expect(e.state.positions.BTC).toBeUndefined();
    expect(e.state.fills[0].closedPnl).toBeCloseTo(0.1 * (61000 - 60001), 6);
  });

  it('stop loss triggers on mark price', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.1 }, T0);
    e.placeOrder({ coin: 'BTC', side: 'A', kind: 'trigger', sz: 0.1, trigger: { triggerPx: 59000, isMarket: true, tpsl: 'sl', positionTpsl: true } }, T0);
    e.onCtxs({ BTC: { markPx: 59500, oraclePx: 59500, funding: 0, midPx: 59500 } }, T0 + 1);
    expect(e.state.positions.BTC).toBeDefined();
    e.onBook(book(T0 + 2, [[58900, 1]], [[58901, 1]]));
    e.onCtxs({ BTC: { markPx: 58950, oraclePx: 58950, funding: 0, midPx: 58950 } }, T0 + 2);
    expect(e.state.positions.BTC).toBeUndefined();
    expect(e.state.fills[0].px).toBe(58900);
  });

  it('liquidates cross position when account value < maintenance', () => {
    const e = mkEngine(1000);
    e.onBook(BOOK);
    e.setLeverage('BTC', 40, 'cross');
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.5 }, T0); // ~30k notional on 1k
    const p = e.state.positions.BTC;
    e.onCtxs({ BTC: { markPx: 60000, oraclePx: 60000, funding: 0, midPx: 60000 } }, T0);
    const liq = e.liqPx(p)!;
    expect(liq).toBeGreaterThan(58000);
    expect(liq).toBeLessThan(60000);
    e.onBook(book(T0 + 5, [[liq - 50, 5]], [[liq - 49, 5]]));
    e.onCtxs({ BTC: { markPx: liq - 50, oraclePx: liq - 50, funding: 0, midPx: liq - 50 } }, T0 + 5);
    expect(e.state.positions.BTC).toBeUndefined();
    expect(e.state.fills[0].liquidation).toBe(true);
  });

  it('settles hourly funding', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.1 }, T0);
    e.onCtxs({ BTC: { markPx: 60000, oraclePx: 60000, funding: 0.0001, midPx: 60000 } }, T0);
    const cash = e.state.cash;
    e.tick(T0 + 3_600_000);
    expect(e.state.cash).toBeCloseTo(cash - 0.1 * 60000 * 0.0001, 6);
    expect(e.state.funding[0].payment).toBeCloseTo(-0.6, 6);
  });

  it('isolated margin locks and releases collateral', () => {
    const e = mkEngine();
    e.onBook(BOOK);
    e.setLeverage('BTC', 10, 'isolated');
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.1 }, T0);
    const p = e.state.positions.BTC;
    expect(p.isoMargin).toBeCloseTo(600.01, 2);
    e.closePosition('BTC');
    expect(e.state.positions.BTC).toBeUndefined();
    // net cost = fees + spread loss
    expect(e.state.cash).toBeLessThan(10_000);
    expect(e.state.cash).toBeGreaterThan(9_990);
  });
});
