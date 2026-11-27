import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, Engine, newState, type Book } from './engine';
import { chooseInterval, replay, type Candle } from './replay';

const H = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % H); // on an hour boundary
const M = 60_000;

function setup() {
  const e = new Engine(newState({ ...DEFAULT_SETTINGS, latencyMs: 150, startingBalance: 10_000 }, T0));
  e.setAssets([{ coin: 'BTC', szDecimals: 5, maxLeverage: 40, tiers: [{ lowerBound: 0, maxLeverage: 40 }] }]);
  const book: Book = {
    coin: 'BTC', time: T0,
    bids: [{ px: 59999, sz: 2, n: 1 }, { px: 59990, sz: 5, n: 1 }],
    asks: [{ px: 60001, sz: 2, n: 1 }, { px: 60010, sz: 5, n: 1 }],
  };
  e.onBook(book);
  e.onCtxs({ BTC: { markPx: 60000, oraclePx: 60000, funding: 0, midPx: 60000 } }, T0);
  e.updateSettings({ latencyMs: 0 });
  return { e, book };
}

const flat = (n: number, px: number, start = T0): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: start + i * M, o: px, h: px + 5, l: px - 5, c: px }));

describe('catch-up replay', () => {
  it('stop loss fires at the minute price crossed it, even if price recovered after', () => {
    const { e, book } = setup();
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.1 }, T0);
    e.placeOrder({ coin: 'BTC', side: 'A', kind: 'trigger', sz: 0.1, trigger: { triggerPx: 59000, isMarket: true, tpsl: 'sl', positionTpsl: true } }, T0);
    const candles = flat(10, 60000, T0 + M);
    candles[4] = { t: T0 + 5 * M, o: 60000, h: 60010, l: 58900, c: 59950 }; // wick through the stop
    const r = replay(e, { from: T0 + M, to: T0 + 11 * M, intervalMs: M, candles: { BTC: candles }, books: { BTC: book }, funding: {} });
    expect(e.state.positions.BTC).toBeUndefined();
    const close = e.state.fills.find((f) => f.dir === 'Close Long')!;
    expect(close.time).toBeGreaterThanOrEqual(T0 + 5 * M);
    expect(close.time).toBeLessThan(T0 + 6 * M);
    // fires as price passes 59,000 (not at the 58,900 wick) and sells into the book there
    expect(close.px).toBeLessThan(59000);
    expect(close.px).toBeGreaterThan(58950);
    expect(r.events.some((x) => /SL triggered/.test(x.msg))).toBe(true);
  });

  it('when TP and SL are both inside one candle, the stop loss wins', () => {
    const { e, book } = setup();
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.1 }, T0);
    e.placeOrder({ coin: 'BTC', side: 'A', kind: 'trigger', sz: 0.1, trigger: { triggerPx: 59000, isMarket: true, tpsl: 'sl', positionTpsl: true } }, T0);
    e.placeOrder({ coin: 'BTC', side: 'A', kind: 'trigger', sz: 0.1, trigger: { triggerPx: 61000, isMarket: true, tpsl: 'tp', positionTpsl: true } }, T0);
    const candles = [{ t: T0 + M, o: 60000, h: 61500, l: 58500, c: 60200 }];
    replay(e, { from: T0 + M, to: T0 + 2 * M, intervalMs: M, candles: { BTC: candles }, books: { BTC: book }, funding: {} });
    const close = e.state.fills.find((f) => f.dir === 'Close Long')!;
    expect(close.closedPnl).toBeLessThan(0);
  });

  it('resting limit fills only when price trades through it, not on a touch', () => {
    const { e, book } = setup();
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 59500, sz: 0.1 }, T0);
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'limit', px: 59400, sz: 0.1 }, T0);
    const candles = [...flat(3, 60000, T0 + M), { t: T0 + 4 * M, o: 60000, h: 60000, l: 59400, c: 59800 }];
    replay(e, { from: T0 + M, to: T0 + 5 * M, intervalMs: M, candles: { BTC: candles }, books: { BTC: book }, funding: {} });
    const fills = e.state.fills.filter((f) => f.liquidity === 'maker');
    expect(fills.map((f) => f.px)).toEqual([59500]); // 59,400 was only touched
    expect(fills[0].time).toBeGreaterThanOrEqual(T0 + 4 * M);
    expect(e.state.orders.filter((o) => o.status === 'open').map((o) => o.px)).toEqual([59400]);
  });

  it('settles every missed funding hour with historical rates', () => {
    const { e, book } = setup();
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 1 }, T0);
    const cash = e.state.cash;
    const candles = flat(180, 60000, T0 + M);
    const funding = [{ time: T0 + H, rate: 0.0001 }, { time: T0 + 2 * H, rate: -0.0002 }, { time: T0 + 3 * H, rate: 0.0003 }];
    const r = replay(e, { from: T0 + M, to: T0 + 3 * H + 30 * M, intervalMs: M, candles: { BTC: candles }, books: { BTC: book }, funding: { BTC: funding } });
    expect(r.fundingCount).toBe(3);
    expect(r.fundingNet).toBeCloseTo(-60000 * (0.0001 - 0.0002 + 0.0003), 1);
    expect(e.state.cash).toBeCloseTo(cash + r.fundingNet, 1);
    expect(e.state.funding[0].time).toBe(T0 + 3 * H);
  });

  it('liquidates on a candle close beyond the liquidation price but ignores a wick', () => {
    const { e, book } = setup();
    e.setLeverage('BTC', 40, 'cross');
    e.reset();
    e.updateSettings({ latencyMs: 0, startingBalance: 1000 });
    e.state.cash = 1000;
    e.onBook(book);
    e.onCtxs({ BTC: { markPx: 60000, oraclePx: 60000, funding: 0, midPx: 60000 } }, T0);
    e.setLeverage('BTC', 40, 'cross');
    e.placeOrder({ coin: 'BTC', side: 'B', kind: 'market', sz: 0.5 }, T0);
    const liq = e.liqPx(e.state.positions.BTC)!;
    const wick = { t: T0 + M, o: 60000, h: 60000, l: liq - 200, c: 59990 };
    replay(e, { from: T0 + M, to: T0 + 2 * M, intervalMs: M, candles: { BTC: [wick] }, books: { BTC: book }, funding: {} });
    expect(e.state.positions.BTC).toBeDefined();
    const crash = { t: T0 + 2 * M, o: 59990, h: 59990, l: liq - 300, c: liq - 100 };
    replay(e, { from: T0 + 2 * M, to: T0 + 3 * M, intervalMs: M, candles: { BTC: [crash] }, books: { BTC: book }, funding: {} });
    expect(e.state.positions.BTC).toBeUndefined();
    expect(e.state.fills[0].liquidation).toBe(true);
  });

  it('runs TWAP slices that were due while closed', () => {
    const { e, book } = setup();
    e.placeTwap({ coin: 'BTC', side: 'B', sz: 1, minutes: 5 }, T0);
    e.tick(T0); // first slice live
    replay(e, { from: T0 + 1000, to: T0 + 10 * M, intervalMs: M, candles: { BTC: flat(10, 60000, T0) }, books: { BTC: book }, funding: {} });
    expect(e.state.twaps[0].status).toBe('completed');
    expect(e.state.twaps[0].filledSz).toBeCloseTo(1, 6);
  });

  it('picks an interval whose 5000-candle history covers the gap', () => {
    expect(chooseInterval(2 * H)[0]).toBe('1m');
    expect(chooseInterval(5 * 24 * H)[0]).toBe('5m');
    expect(chooseInterval(30 * 24 * H)[0]).toBe('15m');
  });
});
