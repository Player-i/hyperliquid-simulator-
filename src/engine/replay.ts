// Catch-up: replay the market history that happened while the app was closed.
//
// For every candle (1m when available) and every coin with open orders,
// positions or TWAPs, the engine is walked along a price path through the
// candle: open -> adverse extreme -> favorable extreme -> close. "Adverse" is
// decided by your exposure in that coin, so when a stop loss and a take profit
// both sit inside the same candle, the stop loss is hit first (never better
// than reality).
//
//  - Resting limit orders fill when the price trades *through* them (strictly
//    beyond). A touch doesn't count: queue position can't be known after the fact.
//  - Trigger orders (TP/SL/stops) fire at the first path point that crosses them
//    and execute against a synthetic book: today's real book shape re-centred on
//    that price, so slippage reflects real depth.
//  - Liquidations are checked on candle closes (mark price is smoother than
//    trade wicks).
//  - Funding is settled every hour with Hyperliquid's historical rates.
//  - TWAP sub-orders run every 30s at the candle close.

import type { Book, Ctx, Engine, Level } from './engine';

export interface Candle { t: number; o: number; h: number; l: number; c: number }

export interface ReplayInput {
  from: number;
  to: number;
  intervalMs: number;
  candles: Record<string, Candle[]>;
  /** current real books, used for depth shape */
  books: Record<string, Book | undefined>;
  /** historical hourly funding rates (perps) */
  funding: Record<string, { time: number; rate: number }[]>;
}

export interface ReplayEvent { time: number; type: string; msg: string }

export interface ReplayResult {
  from: number;
  to: number;
  intervalMs: number;
  events: ReplayEvent[];
  fills: number;
  fundingNet: number;
  fundingCount: number;
  realized: number;
  fees: number;
  equityBefore: number;
  equityAfter: number;
  missing: string[];
}

const HOUR = 3_600_000;

function synthBook(e: Engine, coin: string, px: number, time: number, real?: Book): Book {
  const round = (p: number) => e.roundPx(coin, p);
  if (real?.bids.length && real.asks.length) {
    const mid = (real.bids[0].px + real.asks[0].px) / 2;
    const f = px / mid;
    const shift = (ls: Level[], up: boolean) => {
      const out: Level[] = [];
      for (const l of ls) {
        const p = round(l.px * f);
        const last = out[out.length - 1];
        if (last && (up ? p <= last.px : p >= last.px)) { last.sz += l.sz; continue; }
        out.push({ px: p, sz: l.sz, n: l.n });
      }
      return out;
    };
    const bids = shift(real.bids, false);
    const asks = shift(real.asks, true);
    // keep the spread open after rounding
    while (asks.length && bids.length && asks[0].px <= bids[0].px) asks.shift();
    if (bids.length && asks.length) return { coin, time, bids, asks };
  }
  // no book shape available: thin synthetic spread around the price
  return { coin, time, bids: [{ px: round(px * 0.9995), sz: 1e9, n: 1 }], asks: [{ px: round(px * 1.0005), sz: 1e9, n: 1 }] };
}

/** +1 if the account is long this coin (position or spot holding with sell triggers), -1 if short, 0 if flat */
function exposure(e: Engine, coin: string): number {
  const p = e.state.positions[coin];
  if (p) return Math.sign(p.szi);
  const sp = e.assets.get(coin)?.spot;
  if (sp && (e.state.spot[sp.base] ?? 0) > 0) return 1;
  // resting entries: a buy limit gets hurt by a drop through it, then a rebound
  const o = e.state.orders.find((x) => x.coin === coin && x.status === 'open');
  return o ? (o.side === 'B' ? 1 : -1) : 0;
}

export function replay(e: Engine, inp: ReplayInput): ReplayResult {
  const events: ReplayEvent[] = [];
  const prevOnEvent = e.onEvent;
  let clock = inp.from;
  e.onEvent = (ev) => events.push({ time: clock, ...ev });
  const fillsBefore = e.state.fills.length ? e.state.fills[0].id : -1;
  const fundingBefore = e.state.funding.length ? e.state.funding[0].time : -1;
  const equityBefore = e.summary().equity;
  e.replaying = true;

  const missing = Object.entries(inp.candles).filter(([, cs]) => !cs.length).map(([c]) => c);
  const byTime = new Map<number, [string, Candle][]>();
  for (const [coin, cs] of Object.entries(inp.candles)) {
    for (const c of cs) {
      if (c.t + inp.intervalMs <= inp.from || c.t >= inp.to) continue;
      let arr = byTime.get(c.t);
      if (!arr) byTime.set(c.t, (arr = []));
      arr.push([coin, c]);
    }
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const fundingRate = (coin: string, at: number): number => {
    const list = inp.funding[coin];
    if (!list?.length) return e.ctxs.get(coin)?.funding ?? 0;
    const boundary = Math.ceil(at / HOUR) * HOUR;
    let best = list[0];
    for (const f of list) if (Math.abs(f.time - boundary) < Math.abs(best.time - boundary)) best = f;
    return best.rate;
  };
  const ctxAt = (coin: string, px: number, at: number): Ctx => ({
    markPx: px, oraclePx: px, midPx: px, funding: e.isSpot(coin) ? 0 : fundingRate(coin, at),
  });

  let lastEquity = 0;
  try {
    for (const t of times) {
      const start = Math.max(t, inp.from);
      const end = Math.min(t + inp.intervalMs, inp.to);
      const span = Math.max(1, end - start);
      for (const [coin, c] of byTime.get(t)!) {
        const dir = exposure(e, coin) || (c.c >= c.o ? 1 : -1);
        // adverse extreme first for the side we're exposed to
        const path = dir > 0 ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c];
        const visit = (px: number, at: number, liquidations: boolean) => {
          clock = at;
          e.onBook(synthBook(e, coin, px, at, inp.books[coin]));
          e.onCtxs({ [coin]: ctxAt(coin, px, at) }, at, { liquidations });
        };
        let prev = path[0];
        path.forEach((px, i) => {
          const at = Math.round(start + (span * i) / (path.length - 1));
          if (i > 0) {
            // price moves continuously: stop at each trigger price on the way, so a
            // stop fires at its level instead of at the candle's extreme
            const lo = Math.min(prev, px), hi = Math.max(prev, px);
            const levels = e.state.orders
              .filter((o) => o.coin === coin && o.status === 'open' && o.kind === 'trigger' && o.trigger && o.trigger.triggerPx > lo && o.trigger.triggerPx < hi)
              .map((o) => o.trigger!.triggerPx)
              .sort((a, b) => (px > prev ? a - b : b - a));
            for (const lvl of levels) {
              e.replayThrough(coin, Math.min(prev, lvl), Math.max(prev, lvl), at);
              visit(lvl, at, false);
              prev = lvl;
            }
            e.replayThrough(coin, Math.min(prev, px), Math.max(prev, px), at);
          }
          visit(px, at, i === path.length - 1);
          prev = px;
        });
      }
      // TWAP slices every 30s and hourly funding, at candle-close prices
      for (let k = start + 30_000; k < end; k += 30_000) { clock = k; e.tick(k); }
      clock = end;
      e.tick(end);
      if (end - lastEquity >= 15 * 60_000) { e.recordEquity(end); lastEquity = end; }
    }
    clock = inp.to;
    e.tick(inp.to);
  } finally {
    e.replaying = false;
    e.onEvent = prevOnEvent;
  }

  const newFills = e.state.fills.filter((f) => f.id > fillsBefore);
  const newFunding = e.state.funding.filter((f) => f.time > fundingBefore && f.time > inp.from);
  return {
    from: inp.from,
    to: inp.to,
    intervalMs: inp.intervalMs,
    events,
    fills: newFills.length,
    realized: newFills.reduce((a, f) => a + f.closedPnl, 0),
    fees: newFills.reduce((a, f) => a + f.fee, 0),
    fundingNet: newFunding.reduce((a, f) => a + f.payment, 0),
    fundingCount: newFunding.length,
    equityBefore,
    equityAfter: e.summary().equity,
    missing,
  };
}

/** pick the finest candle interval whose 5000-candle history covers the gap */
export function chooseInterval(gapMs: number): [string, number] {
  const opts: [string, number][] = [['1m', 60e3], ['5m', 300e3], ['15m', 900e3], ['1h', 3600e3], ['4h', 14400e3], ['1d', 86400e3]];
  for (const o of opts) if (o[1] * 4900 >= gapMs) return o;
  return opts[opts.length - 1];
}
