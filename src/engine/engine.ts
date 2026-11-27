// Paper-trading engine that executes simulated orders against Hyperliquid's
// *real* live order book and trade tape.
//
// Realism model:
//  - Taker orders (market, IOC, crossing limits) walk the live L2 book level by
//    level, with real depth and real slippage. Liquidity you take is removed from a
//    local overlay so repeated orders can't fill twice at the same level until the
//    real book refreshes.
//  - Resting limit orders join the back of the queue at their price. Your queue
//    position shrinks as real trades print at your price and as size ahead of you
//    is cancelled. You only get filled when real aggressive flow reaches you, a
//    trade prints through your price, or the book crosses your price.
//  - Fees: Hyperliquid base-tier taker/maker rates (configurable).
//  - Margin: cross & isolated, per-asset leverage capped by the asset's margin
//    tiers, maintenance margin = half of initial margin at max leverage,
//    liquidation on mark price, Hyperliquid's liquidation price formula.
//  - Funding: settled every hour on the hour using the live funding rate and
//    oracle price (longs pay shorts when positive).
//  - TP/SL triggers on mark price, like Hyperliquid.
//  - Optional network latency before an order reaches the "exchange".
//  - Spot: real token balances, fees taken in the received token, average-cost PnL.
//  - TWAP: a market sub-order every 30s with max 3% slippage, catching up on
//    unfilled size (capped at 3x a normal slice), like Hyperliquid's TWAP.

import { MIN_ORDER_NOTIONAL, roundPrice, roundSize } from './rules';

const fmtMin = (v: number) => Math.ceil(v).toLocaleString('en-US');

export type Side = 'B' | 'A'; // B = buy/bid, A = sell/ask (Hyperliquid convention)
export type Tif = 'Gtc' | 'Alo' | 'Ioc';
export type MarginMode = 'cross' | 'isolated';

export interface MarginTier { lowerBound: number; maxLeverage: number }
export interface AssetInfo {
  coin: string;
  szDecimals: number;
  maxLeverage: number;
  tiers: MarginTier[];
  onlyIsolated?: boolean;
  /** present for spot pairs. `coin` is the exchange's pair id (e.g. "@107" or "PURR/USDC") */
  spot?: { name: string; base: string; quote: string };
}
export interface Level { px: number; sz: number; n: number }
export interface Book { coin: string; time: number; bids: Level[]; asks: Level[] }
export interface Trade { coin: string; side: Side; px: number; sz: number; time: number }
export interface Ctx { markPx: number; oraclePx: number; funding: number; midPx: number | null }

export interface Settings {
  takerFee: number; // e.g. 0.00045
  makerFee: number; // e.g. 0.00015 (negative = rebate)
  latencyMs: number;
  marketSlippage: number; // max slippage for market orders, e.g. 0.08
  startingBalance: number;
  spotTakerFee: number;
  spotMakerFee: number;
}

export const DEFAULT_SETTINGS: Settings = {
  takerFee: 0.00045,
  makerFee: 0.00015,
  latencyMs: 150,
  marketSlippage: 0.08,
  startingBalance: 10_000,
  spotTakerFee: 0.0007,
  spotMakerFee: 0.0004,
};

export const TWAP_INTERVAL_MS = 30_000;
export const TWAP_SLIPPAGE = 0.03;

export type OrderKind = 'limit' | 'market' | 'trigger';
export type OrderStatus = 'pending' | 'open' | 'filled' | 'canceled' | 'rejected' | 'triggered';

export interface Trigger {
  triggerPx: number;
  isMarket: boolean;
  tpsl: 'tp' | 'sl';
  /** Position TP/SL: sized to the whole position at trigger time. */
  positionTpsl?: boolean;
}

export interface Order {
  oid: number;
  coin: string;
  side: Side;
  kind: OrderKind;
  px: number; // limit price (for trigger-limit: the limit price after trigger)
  sz: number; // remaining
  origSz: number;
  tif: Tif;
  reduceOnly: boolean;
  trigger?: Trigger;
  status: OrderStatus;
  createdAt: number;
  /** size resting ahead of us at our price level */
  queueAhead: number;
  /** queueAhead before the most recent book snapshot was applied */
  queuePrevBook: number;
  /** exchange time of the book snapshot we joined the queue on; older trades are already reflected */
  restTime?: number;
  statusMsg?: string;
  /** sub-order of a TWAP */
  twapId?: number;
  /** internal order: no toasts / order-history rows */
  quiet?: boolean;
  /** TP/SL attached to this entry; placed once it fills */
  tpsl?: { tp?: number; sl?: number };
  /** amount received so far (spot: after fee) */
  recv?: number;
}

export interface Twap {
  id: number;
  coin: string;
  side: Side;
  totalSz: number;
  filledSz: number;
  notional: number; // sum px*sz of fills, for avg price
  startedAt: number;
  durationMs: number;
  randomize: boolean;
  reduceOnly: boolean;
  status: 'running' | 'completed' | 'canceled';
  nextAt: number;
  endedAt?: number;
  lastMsg?: string;
}

export interface Position {
  coin: string;
  szi: number; // signed size
  entryPx: number;
  leverage: number;
  mode: MarginMode;
  isoMargin: number; // only for isolated
  cumFunding: number; // funding paid since open (positive = paid)
  openedAt: number;
}

export interface Fill {
  id: number;
  oid: number;
  coin: string;
  side: Side;
  px: number;
  sz: number;
  time: number;
  fee: number;
  closedPnl: number;
  dir: string;
  liquidity: 'maker' | 'taker';
  liquidation?: boolean;
  spot?: boolean;
  twapId?: number;
  /** display name at fill time, e.g. "HYPE/USDC" */
  label?: string;
}

export interface FundingEvent { time: number; coin: string; szi: number; rate: number; payment: number }
export interface OrderEvent { time: number; order: Order }

export interface LevSetting { leverage: number; mode: MarginMode }

export interface State {
  cash: number; // USDC not locked in isolated margin
  positions: Record<string, Position>;
  orders: Order[];
  fills: Fill[];
  funding: FundingEvent[];
  history: OrderEvent[];
  lev: Record<string, LevSetting>;
  nextId: number;
  lastFundingHour: number;
  settings: Settings;
  createdAt: number;
  /** spot token balances (token name -> amount) */
  spot: Record<string, number>;
  /** average-cost basis of spot holdings, in quote units */
  spotCost: Record<string, { sz: number; cost: number }>;
  twaps: Twap[];
  /** [time, total equity] samples for the equity curve */
  equityHist: [number, number][];
  /** last time the app was running; catch-up replays history from here */
  lastSeen?: number;
}

export interface OrderRequest {
  coin: string;
  side: Side;
  kind: OrderKind;
  sz: number;
  px?: number; // required for limit
  tif?: Tif;
  reduceOnly?: boolean;
  trigger?: Trigger;
  /** TP/SL prices that activate when this order fills (sized to the fill) */
  tpsl?: { tp?: number; sl?: number };
}

export interface PlaceResult { ok: boolean; oid?: number; error?: string }

export function newState(settings: Settings = DEFAULT_SETTINGS, now = Date.now()): State {
  return {
    cash: settings.startingBalance,
    positions: {},
    orders: [],
    fills: [],
    funding: [],
    history: [],
    lev: {},
    nextId: 1,
    lastFundingHour: Math.floor(now / 3_600_000),
    settings: { ...settings },
    createdAt: now,
    spot: {},
    spotCost: {},
    twaps: [],
    equityHist: [[now, settings.startingBalance]],
  };
}

/** fill in fields added in later versions so old saved accounts keep working */
export function migrateState(s: State): State {
  s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
  s.spot ??= {};
  s.spotCost ??= {};
  s.twaps ??= [];
  s.equityHist ??= [[s.createdAt ?? Date.now(), s.settings.startingBalance]];
  return s;
}

const sideSign = (s: Side) => (s === 'B' ? 1 : -1);
const opposite = (s: Side): Side => (s === 'B' ? 'A' : 'B');
const EPS = 1e-12;

interface ConsumedEntry { amt: number; bookSz: number; at: number }

export class Engine {
  state: State;
  assets = new Map<string, AssetInfo>();
  books = new Map<string, Book>();
  ctxs = new Map<string, Ctx>();
  private consumed = new Map<string, Map<string, ConsumedEntry>>();
  private pending: { at: number; run: (at: number) => void }[] = [];
  private listeners = new Set<() => void>();
  private notifyQueued = false;
  /** user-facing notifications (fills, liquidations, rejections) */
  onEvent: (e: { type: 'fill' | 'reject' | 'liquidation' | 'info'; msg: string }) => void = () => {};

  constructor(state?: State) {
    this.state = state ? migrateState(state) : newState();
  }

  // ------------------------------------------------------------------ plumbing
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => { this.notifyQueued = false; for (const l of this.listeners) l(); });
  }
  /** force a synchronous notify (used by tests / UI refresh) */
  emit() { for (const l of this.listeners) l(); }

  setAssets(list: AssetInfo[]) { for (const a of list) this.assets.set(a.coin, a); }

  asset(coin: string): AssetInfo {
    const a = this.assets.get(coin);
    if (!a) throw new Error(`unknown asset ${coin}`);
    return a;
  }

  isSpot(coin: string) { return !!this.assets.get(coin)?.spot; }

  /** "BTC" for perps, "HYPE/USDC" for spot */
  label(coin: string) { return this.assets.get(coin)?.spot?.name ?? coin; }

  roundPx(coin: string, px: number, mode: 'nearest' | 'down' | 'up' = 'nearest') {
    const a = this.asset(coin);
    return roundPrice(px, a.szDecimals, mode, !!a.spot);
  }

  levSetting(coin: string): LevSetting {
    const s = this.state.lev[coin];
    if (s) return s;
    const a = this.assets.get(coin);
    const def = Math.min(20, a?.maxLeverage ?? 20);
    return { leverage: def, mode: a?.onlyIsolated ? 'isolated' : 'cross' };
  }

  maxLeverageFor(coin: string, notional: number): number {
    const a = this.assets.get(coin);
    if (!a) return this.state.positions[coin]?.leverage ?? 20; // metadata not loaded yet
    let lev = a.maxLeverage;
    for (const t of a.tiers) if (notional >= t.lowerBound) lev = Math.min(lev, t.maxLeverage);
    return lev;
  }

  /** maintenance margin rate: half of initial margin at max leverage for this notional */
  mmr(coin: string, notional: number): number {
    return 1 / (2 * this.maxLeverageFor(coin, notional));
  }

  markPx(coin: string): number {
    const c = this.ctxs.get(coin);
    if (c?.markPx) return c.markPx;
    const b = this.books.get(coin);
    if (b?.bids[0] && b?.asks[0]) return (b.bids[0].px + b.asks[0].px) / 2;
    return this.state.positions[coin]?.entryPx ?? 0;
  }

  midPx(coin: string): number {
    const b = this.books.get(coin);
    if (b?.bids[0] && b?.asks[0]) return (b.bids[0].px + b.asks[0].px) / 2;
    return this.markPx(coin);
  }

  // ------------------------------------------------------------- spot math
  private usdcPairs = new Map<string, string>();
  /** USDC value of one unit of a spot token */
  tokenPx(token: string): number {
    if (token === 'USDC') return 1;
    let coin = this.usdcPairs.get(token);
    if (!coin) {
      for (const a of this.assets.values()) if (a.spot?.base === token && a.spot.quote === 'USDC') { coin = a.coin; break; }
      if (coin) this.usdcPairs.set(token, coin);
    }
    return coin ? this.midPx(coin) : 0;
  }

  /** balance held by resting spot orders */
  spotHold(token: string): number {
    let h = 0;
    for (const o of this.state.orders) {
      if (o.status !== 'open' || o.kind !== 'limit') continue;
      const sp = this.assets.get(o.coin)?.spot;
      if (!sp) continue;
      if (o.side === 'B' && sp.quote === token) h += o.sz * o.px;
      if (o.side === 'A' && sp.base === token) h += o.sz;
    }
    return h;
  }

  spotAvailable(token: string) { return Math.max(0, (this.state.spot[token] ?? 0) - this.spotHold(token)); }

  spotValue() {
    let v = 0;
    for (const [t, amt] of Object.entries(this.state.spot)) v += amt * this.tokenPx(t);
    return v;
  }

  /** move USDC between the perps and spot accounts */
  transfer(amount: number, toSpot: boolean): string | null {
    if (!(amount > 0)) return 'Enter an amount';
    if (toSpot) {
      if (amount > this.summary().available + 1e-9) return 'Amount exceeds perps withdrawable balance';
      this.state.cash -= amount;
      this.state.spot.USDC = (this.state.spot.USDC ?? 0) + amount;
    } else {
      if (amount > this.spotAvailable('USDC') + 1e-9) return 'Amount exceeds available spot USDC';
      this.state.spot.USDC -= amount;
      this.state.cash += amount;
    }
    this.changed();
    return null;
  }

  // ------------------------------------------------------------- account math
  upnl(p: Position) { return p.szi * (this.markPx(p.coin) - p.entryPx); }

  positionMargin(p: Position) {
    if (p.mode === 'isolated') return p.isoMargin;
    return (Math.abs(p.szi) * this.markPx(p.coin)) / p.leverage;
  }

  positionMaint(p: Position) {
    const ntl = Math.abs(p.szi) * this.markPx(p.coin);
    return ntl * this.mmr(p.coin, ntl);
  }

  /** margin required by resting orders that would increase exposure */
  orderMargin(filter?: (o: Order) => boolean): number {
    let total = 0;
    for (const o of this.state.orders) {
      if (o.status !== 'open' || o.reduceOnly || o.kind === 'trigger' || this.isSpot(o.coin)) continue;
      if (filter && !filter(o)) continue;
      const pos = this.state.positions[o.coin];
      let incSz = o.sz;
      if (pos && Math.sign(pos.szi) === -sideSign(o.side)) incSz = Math.max(0, o.sz - Math.abs(pos.szi));
      const lev = pos?.leverage ?? this.levSetting(o.coin).leverage;
      total += (incSz * o.px) / lev;
    }
    return total;
  }

  summary() {
    const s = this.state;
    let crossUpnl = 0, crossMargin = 0, crossMaint = 0, isoEquity = 0, ntl = 0, upnlAll = 0;
    for (const p of Object.values(s.positions)) {
      const u = this.upnl(p);
      upnlAll += u;
      ntl += Math.abs(p.szi) * this.markPx(p.coin);
      if (p.mode === 'cross') {
        crossUpnl += u;
        crossMargin += this.positionMargin(p);
        crossMaint += this.positionMaint(p);
      } else {
        isoEquity += p.isoMargin + u;
      }
    }
    const crossAccountValue = s.cash + crossUpnl;
    const orderMargin = this.orderMargin();
    const available = Math.max(0, crossAccountValue - crossMargin - orderMargin);
    const perpEquity = crossAccountValue + isoEquity;
    const spotValue = this.spotValue();
    const equity = perpEquity + spotValue;
    return {
      cash: s.cash,
      equity,
      perpEquity,
      spotValue,
      crossAccountValue,
      crossMargin,
      crossMaint,
      orderMargin,
      available,
      upnl: upnlAll,
      totalNotional: ntl,
      crossMarginRatio: crossAccountValue > 0 ? crossMaint / crossAccountValue : 0,
      accountLeverage: perpEquity > 0 ? ntl / perpEquity : 0,
      pnlSinceStart: equity - s.settings.startingBalance,
    };
  }

  /** Hyperliquid liquidation price formula */
  liqPx(p: Position): number | null {
    const mark = this.markPx(p.coin);
    const side = Math.sign(p.szi);
    const absSz = Math.abs(p.szi);
    if (!absSz || !mark) return null;
    const l = this.mmr(p.coin, absSz * mark);
    let av: number;
    if (p.mode === 'isolated') av = p.isoMargin + this.upnl(p);
    else {
      const sum = this.summary();
      av = sum.crossAccountValue - sum.crossMaint + this.positionMaint(p);
    }
    // liq when av(P) = |s| * P * l, holding other positions fixed
    const px = (mark - (side * av) / absSz) / (1 - side * l);
    return px > 0 && Number.isFinite(px) ? px : null;
  }

  // ------------------------------------------------------------ market data
  onBook(book: Book) {
    this.books.set(book.coin, book);
    // refresh consumed-liquidity overlay: drop entries whose level changed or aged out
    const cm = this.consumed.get(book.coin);
    if (cm) {
      for (const [k, e] of cm) {
        const side = k[0] as Side;
        const px = Number(k.slice(2));
        const lvl = (side === 'B' ? book.bids : book.asks).find((l) => l.px === px);
        if (!lvl || Math.abs(lvl.sz - e.bookSz) > EPS || book.time - e.at > 5_000) cm.delete(k);
      }
    }
    let touched = false;
    for (const o of this.state.orders) {
      if (o.coin !== book.coin || o.status !== 'open' || o.kind !== 'limit') continue;
      touched = true;
      if (!this.replaying) {
        o.queuePrevBook = o.queueAhead;
        const levels = o.side === 'B' ? book.bids : book.asks;
        const lvl = levels.find((l) => l.px === o.px);
        if (lvl) o.queueAhead = Math.min(o.queueAhead, lvl.sz);
        else if (this.withinVisible(levels, o.side, o.px)) o.queueAhead = 0;
      }
      // book crossed through our price -> we'd have been matched
      const best = o.side === 'B' ? book.asks[0]?.px : book.bids[0]?.px;
      if (best !== undefined && (o.side === 'B' ? best <= o.px : best >= o.px)) {
        this.fillResting(o, o.sz, book.time);
      }
    }
    if (touched) this.cleanup();
    this.changed();
  }

  private withinVisible(levels: Level[], side: Side, px: number) {
    if (!levels.length) return true;
    const worst = levels[levels.length - 1].px;
    return side === 'B' ? px >= worst : px <= worst;
  }

  onTrades(trades: Trade[]) {
    let touched = false;
    for (const t of trades) {
      const book = this.books.get(t.coin);
      const inBook = book ? t.time <= book.time : false;
      for (const o of this.state.orders) {
        if (o.coin !== t.coin || o.status !== 'open' || o.kind !== 'limit') continue;
        // aggressor must be on the opposite side of our resting order
        if (t.side === o.side) continue;
        if (o.restTime !== undefined && t.time <= o.restTime) continue;
        touched = true;
        const through = o.side === 'B' ? t.px < o.px : t.px > o.px;
        if (through) { this.fillResting(o, o.sz, t.time); continue; }
        if (t.px !== o.px) continue;
        if (inBook) {
          // book snapshot already reflects this trade; measure against pre-snapshot queue
          const fill = t.sz - o.queuePrevBook;
          o.queuePrevBook = Math.max(0, o.queuePrevBook - t.sz);
          if (fill > EPS) this.fillResting(o, Math.min(fill, o.sz), t.time);
        } else {
          const fill = t.sz - o.queueAhead;
          o.queueAhead = Math.max(0, o.queueAhead - t.sz);
          o.queuePrevBook = Math.max(0, o.queuePrevBook - t.sz);
          if (fill > EPS) this.fillResting(o, Math.min(fill, o.sz), t.time);
        }
      }
    }
    if (touched) { this.cleanup(); this.changed(); }
  }

  onCtxs(ctxs: Record<string, Ctx>, now = Date.now(), opts: { liquidations?: boolean } = {}) {
    for (const [coin, c] of Object.entries(ctxs)) this.ctxs.set(coin, c);
    this.checkTriggers(now);
    if (opts.liquidations !== false) this.checkLiquidations(now);
    this.changed();
  }

  // --------------------------------------------------------------- scheduling
  /** call regularly (e.g. every 50ms) */
  tick(now = Date.now()) {
    if (this.pending.length) {
      const due = this.pending.filter((p) => p.at <= now);
      this.pending = this.pending.filter((p) => p.at > now);
      for (const p of due) p.run(p.at);
    }
    for (const t of this.state.twaps) if (t.status === 'running' && now >= t.nextAt) this.stepTwap(t, now);
    const hour = Math.floor(now / 3_600_000);
    if (hour > this.state.lastFundingHour) {
      this.settleFunding(hour * 3_600_000);
      this.state.lastFundingHour = hour;
      this.changed();
    }
  }

  private schedule(run: (at: number) => void, now: number) {
    const lat = this.replaying ? 0 : this.state.settings.latencyMs;
    if (lat <= 0) run(now);
    else {
      // jitter ±30% to mimic real network variance
      const j = lat * (0.7 + Math.random() * 0.6);
      this.pending.push({ at: now + j, run });
    }
  }

  // ------------------------------------------------------------ replay mode
  /**
   * While replaying history (catch-up after the app was closed) the books are
   * synthetic, so they must not move queue positions, and there is no latency.
   */
  replaying = false;

  /** a candle traded through these prices: resting orders strictly inside its range fill in full */
  replayThrough(coin: string, low: number, high: number, time: number) {
    let touched = false;
    for (const o of this.state.orders) {
      if (o.coin !== coin || o.status !== 'open' || o.kind !== 'limit') continue;
      if ((o.side === 'B' && low < o.px) || (o.side === 'A' && high > o.px)) {
        touched = true;
        this.fillResting(o, o.sz, time);
      }
    }
    if (touched) { this.cleanup(); this.changed(); }
  }

  // ----------------------------------------------------------------- orders
  placeOrder(req: OrderRequest, now = Date.now()): PlaceResult {
    const a = this.assets.get(req.coin);
    if (!a) return { ok: false, error: 'Unknown asset' };
    const sz = roundSize(req.sz, a.szDecimals);
    if (!(sz > 0)) return { ok: false, error: 'Order size must be positive' };
    if (req.kind === 'limit' && !(req.px && req.px > 0)) return { ok: false, error: 'Limit price required' };
    if (req.kind === 'trigger' && !req.trigger) return { ok: false, error: 'Trigger price required' };

    if (a.spot && (req.reduceOnly || req.trigger?.positionTpsl)) return { ok: false, error: 'Reduce only is not available for spot' };
    const ref = this.markPx(req.coin) || this.midPx(req.coin);
    const px = req.px ? this.roundPx(req.coin, req.px) : 0;
    if (req.kind === 'trigger' && req.trigger) {
      req.trigger.triggerPx = this.roundPx(req.coin, req.trigger.triggerPx);
      if (!req.trigger.isMarket && !px) return { ok: false, error: 'Limit price required' };
    }
    const pxForCheck = px || req.trigger?.triggerPx || ref;
    if (!req.reduceOnly && !req.trigger?.positionTpsl && sz * pxForCheck < MIN_ORDER_NOTIONAL) {
      return { ok: false, error: `Order must have minimum value of $${MIN_ORDER_NOTIONAL}` };
    }
    if (req.kind === 'limit' && ref && Math.abs(px / ref - 1) > 0.8) {
      return { ok: false, error: 'Order price cannot be more than 80% away from the reference price' };
    }

    const oid = this.state.nextId++;
    const order: Order = {
      oid, coin: req.coin, side: req.side, kind: req.kind, px, sz, origSz: sz,
      tif: req.kind === 'market' ? 'Ioc' : req.tif ?? 'Gtc',
      reduceOnly: !!req.reduceOnly || !!req.trigger?.positionTpsl,
      trigger: req.trigger ? { ...req.trigger } : undefined,
      status: 'pending', createdAt: now, queueAhead: 0, queuePrevBook: 0,
      tpsl: req.tpsl && (req.tpsl.tp || req.tpsl.sl) && !req.trigger && !req.reduceOnly ? { ...req.tpsl } : undefined,
    };
    if (order.tpsl && a.spot && req.side !== 'B') return { ok: false, error: 'Spot TP/SL can only be attached to buys' };
    this.state.orders.push(order);
    this.changed();
    this.schedule((at) => this.arrive(order, at), now);
    return { ok: true, oid };
  }

  cancelOrder(oid: number, now = Date.now()) {
    const o = this.state.orders.find((x) => x.oid === oid);
    if (!o) return;
    this.schedule((at) => {
      if (o.status === 'open' || o.status === 'pending') {
        this.finish(o, 'canceled', 'Canceled', at);
        this.cleanup();
        this.changed();
      }
    }, now);
  }

  cancelAll(coin?: string, now = Date.now()) {
    for (const o of this.state.orders) if (!coin || o.coin === coin) this.cancelOrder(o.oid, now);
  }

  /** order reaches the matching engine (after latency) */
  private arrive(o: Order, now: number) {
    if (o.status !== 'pending') return;
    const reject = (msg: string) => {
      this.finish(o, 'rejected', msg, now);
      if (o.twapId) {
        const t = this.state.twaps.find((x) => x.id === o.twapId);
        if (t) t.lastMsg = msg;
      }
      if (!o.quiet) this.onEvent({ type: 'reject', msg: `${this.label(o.coin)}: ${msg}` });
      this.cleanup();
      this.changed();
    };
    const pos = this.state.positions[o.coin];
    if (o.reduceOnly && !o.trigger) {
      if (!pos || Math.sign(pos.szi) !== -sideSign(o.side)) return reject('Reduce only order would increase position');
      o.sz = Math.min(o.sz, Math.abs(pos.szi));
    }
    if (o.kind === 'trigger') {
      const sp = this.assets.get(o.coin)?.spot;
      if (sp && o.side === 'A' && !((this.state.spot[sp.base] ?? 0) > 0)) return reject(`No ${sp.base} balance to sell`);
      o.status = 'open';
      this.state.history.push({ time: now, order: { ...o } });
      this.changed();
      this.checkTriggers(now);
      return;
    }
    if (o.kind === 'market') {
      const mid = this.midPx(o.coin);
      const slip = this.state.settings.marketSlippage;
      o.px = this.roundPx(o.coin, mid * (1 + sideSign(o.side) * slip), o.side === 'B' ? 'up' : 'down');
    }
    const err = this.isSpot(o.coin) ? this.spotBalanceCheck(o) : this.marginCheck(o);
    if (err) return reject(err);

    const book = this.books.get(o.coin);
    if (!book) return reject('No order book data yet');
    const bestOpp = o.side === 'B' ? book.asks[0]?.px : book.bids[0]?.px;
    const crosses = bestOpp !== undefined && (o.side === 'B' ? bestOpp <= o.px : bestOpp >= o.px);

    if (o.tif === 'Alo' && crosses) return reject('Post only order would have immediately matched');

    if (crosses) this.takeLiquidity(o, now);

    if (o.status !== 'pending') { this.cleanup(); this.changed(); return; } // fully filled
    if (o.tif === 'Ioc') {
      if (o.sz === o.origSz) return reject(o.kind === 'market' ? 'Order could not immediately match against any resting orders' : 'IOC order could not match');
      this.finish(o, 'canceled', 'IOC remainder canceled', now);
      this.cleanup();
      this.changed();
      return;
    }
    // rest on the book at the back of the queue
    const levels = o.side === 'B' ? book.bids : book.asks;
    const lvl = levels.find((l) => l.px === o.px);
    o.queueAhead = lvl ? lvl.sz : this.withinVisible(levels, o.side, o.px) ? 0 : Infinity;
    o.queuePrevBook = o.queueAhead;
    o.restTime = book.time;
    o.status = 'open';
    this.state.history.push({ time: now, order: { ...o } });
    this.changed();
  }

  private spotBalanceCheck(o: Order): string | null {
    const sp = this.asset(o.coin).spot!;
    if (o.side === 'B') {
      const px = o.kind === 'market' || o.tif === 'Ioc' ? Math.min(o.px, this.estimateTaker(o.coin, 'B', o.sz)?.avgPx ?? o.px) : o.px;
      const need = o.sz * px;
      const avail = this.spotAvailable(sp.quote);
      if (need > avail * 1.0001 + 1e-9) return `Insufficient ${sp.quote} balance (need ${need.toFixed(2)}, available ${avail.toFixed(2)})`;
    } else {
      const avail = this.spotAvailable(sp.base);
      if (o.sz > avail + 1e-9) return `Insufficient ${sp.base} balance (available ${avail})`;
    }
    return null;
  }

  private marginCheck(o: Order): string | null {
    if (o.reduceOnly) return null;
    const pos = this.state.positions[o.coin];
    const ls = this.levSetting(o.coin);
    let incSz = o.sz;
    if (pos && Math.sign(pos.szi) === -sideSign(o.side)) incSz = Math.max(0, o.sz - Math.abs(pos.szi));
    if (incSz <= 0) return null;
    const refPx = o.kind === 'market' ? this.midPx(o.coin) : o.px;
    const curNtl = pos && Math.sign(pos.szi) === sideSign(o.side) ? Math.abs(pos.szi) * refPx : 0;
    const newNtl = curNtl + incSz * refPx;
    const lev = pos?.leverage ?? ls.leverage;
    if (lev > this.maxLeverageFor(o.coin, newNtl)) {
      return `Position notional exceeds max for ${lev}x leverage on ${o.coin} (max ${this.maxLeverageFor(o.coin, newNtl)}x at this size)`;
    }
    const need = (incSz * refPx) / lev + incSz * refPx * this.state.settings.takerFee;
    const avail = this.summary().available;
    if (need > avail + 1e-6) return `Insufficient margin (need $${need.toFixed(2)}, available $${avail.toFixed(2)})`;
    return null;
  }

  /** walk the live book on the opposite side up to o.px */
  private takeLiquidity(o: Order, now: number, liquidation = false) {
    const book = this.books.get(o.coin);
    if (!book) return;
    const levels = o.side === 'B' ? book.asks : book.bids;
    let cm = this.consumed.get(o.coin);
    if (!cm) { cm = new Map(); this.consumed.set(o.coin, cm); }
    const oppSide = opposite(o.side);
    for (const lvl of levels) {
      if (o.sz <= EPS) break;
      if (!liquidation && (o.side === 'B' ? lvl.px > o.px : lvl.px < o.px)) break;
      const key = `${oppSide}:${lvl.px}`;
      const used = cm.get(key);
      const availSz = lvl.sz - (used?.amt ?? 0);
      if (availSz <= EPS) continue;
      const fillSz = Math.min(availSz, o.sz);
      cm.set(key, { amt: (used?.amt ?? 0) + fillSz, bookSz: lvl.sz, at: book.time });
      this.applyFill(o, lvl.px, fillSz, 'taker', now, liquidation);
      if (o.status !== 'pending' && o.status !== 'open') break;
    }
  }

  private fillResting(o: Order, sz: number, time: number) {
    if (o.status !== 'open' || sz <= EPS) return;
    this.applyFill(o, o.px, Math.min(sz, o.sz), 'maker', time);
  }

  private recordFill(o: Order, f: Omit<Fill, 'id' | 'oid' | 'coin' | 'side' | 'label' | 'twapId'>, received = f.sz) {
    const s = this.state;
    const a = this.asset(o.coin);
    o.recv = (o.recv ?? 0) + received;
    // perps: position TP/SL covers the whole position, so arm it on the first fill
    if (o.tpsl && !a.spot) this.spawnTpsl(o, f.time);
    o.sz = Math.max(0, o.sz - f.sz);
    if (o.sz <= EPS || roundSize(o.sz, a.szDecimals) === 0) { o.sz = 0; this.finish(o, 'filled', 'Filled', f.time); }
    const fill: Fill = { id: s.nextId++, oid: o.oid, coin: o.coin, side: o.side, label: this.label(o.coin), twapId: o.twapId, ...f };
    s.fills.unshift(fill);
    if (s.fills.length > 10_000) s.fills.length = 10_000;
    if (o.twapId) {
      const t = s.twaps.find((x) => x.id === o.twapId);
      if (t) { t.filledSz += f.sz; t.notional += f.sz * f.px; t.lastMsg = undefined; }
    } else {
      this.onEvent({
        type: f.liquidation ? 'liquidation' : 'fill',
        msg: `${f.liquidation ? 'LIQUIDATED ' : ''}${f.dir} ${f.sz} ${this.label(o.coin)} @ ${f.px}${f.closedPnl ? ` (PnL ${f.closedPnl >= 0 ? '+' : ''}${f.closedPnl.toFixed(2)})` : ''}`,
      });
    }
  }

  /** spot fill: fees are taken from the token you receive; PnL uses average cost */
  private applySpotFill(o: Order, px: number, sz: number, liquidity: 'maker' | 'taker', time: number) {
    const s = this.state;
    const a = this.asset(o.coin);
    const { base, quote } = a.spot!;
    const feeRate = liquidity === 'taker' ? s.settings.spotTakerFee : s.settings.spotMakerFee;
    if (o.side === 'B') {
      // can't spend more than we have (market orders estimate price up front)
      const bal = s.spot[quote] ?? 0;
      if (sz * px > bal + 1e-9) sz = roundSize(bal / px, a.szDecimals);
    } else {
      sz = Math.min(sz, s.spot[base] ?? 0);
    }
    sz = roundSize(sz, a.szDecimals);
    if (sz <= EPS) { if (o.status === 'pending' || o.status === 'open') this.finish(o, 'canceled', 'Insufficient balance', time); return; }
    const qPx = this.tokenPx(quote) || 1;
    const value = px * sz;
    const cb = (s.spotCost[base] ??= { sz: 0, cost: 0 });
    let closedPnl = 0;
    let fee: number;
    if (o.side === 'B') {
      const got = sz * (1 - feeRate);
      s.spot[quote] = (s.spot[quote] ?? 0) - value;
      s.spot[base] = (s.spot[base] ?? 0) + got;
      cb.sz += got;
      cb.cost += value * (1 - feeRate);
      fee = value * feeRate * qPx;
    } else {
      const got = value * (1 - feeRate);
      s.spot[base] = (s.spot[base] ?? 0) - sz;
      s.spot[quote] = (s.spot[quote] ?? 0) + got;
      const avg = cb.sz > EPS ? cb.cost / cb.sz : px;
      const basisSz = Math.min(sz, cb.sz);
      closedPnl = (px - avg) * basisSz * qPx;
      cb.cost -= avg * basisSz;
      cb.sz -= basisSz;
      fee = value * feeRate * qPx;
    }
    for (const t of [base, quote]) if (Math.abs(s.spot[t]) < 1e-10) delete s.spot[t];
    if (cb.sz <= 1e-10) delete s.spotCost[base];
    if (o.side === 'A' && roundSize(s.spot[base] ?? 0, a.szDecimals) === 0) {
      // like a closed position: the holding is gone, so its TP/SL sell triggers are canceled
      for (const x of s.orders) {
        if (x !== o && x.kind === 'trigger' && x.side === 'A' && (x.status === 'open' || x.status === 'pending') && this.assets.get(x.coin)?.spot?.base === base) {
          this.finish(x, 'canceled', `${base} balance sold`, time);
        }
      }
    }
    this.recordFill(o, { px, sz, time, fee, closedPnl, dir: o.side === 'B' ? 'Buy' : 'Sell', liquidity, spot: true }, o.side === 'B' ? sz * (1 - feeRate) : sz);
  }

  private applyFill(o: Order, px: number, sz: number, liquidity: 'maker' | 'taker', time: number, liquidation = false) {
    const s = this.state;
    const a = this.asset(o.coin);
    if (a.spot) return this.applySpotFill(o, px, sz, liquidity, time);
    let pos = s.positions[o.coin];
    // reduce-only: never flip or increase
    if (o.reduceOnly) {
      if (!pos || Math.sign(pos.szi) !== -sideSign(o.side)) { this.finish(o, 'canceled', 'Reduce only: no position to reduce', time); return; }
      sz = Math.min(sz, Math.abs(pos.szi));
    }
    sz = roundSize(sz, a.szDecimals) || sz;
    if (sz <= EPS) return;

    const signed = sideSign(o.side) * sz;
    const feeRate = liquidity === 'taker' ? s.settings.takerFee : s.settings.makerFee;
    const fee = px * sz * feeRate;
    const ls = this.levSetting(o.coin);
    let closedPnl = 0;
    let dir: string;

    if (!pos || pos.szi === 0) {
      pos = { coin: o.coin, szi: 0, entryPx: px, leverage: ls.leverage, mode: ls.mode, isoMargin: 0, cumFunding: 0, openedAt: time };
      s.positions[o.coin] = pos;
    }
    const before = pos.szi;
    if (Math.sign(before) === Math.sign(signed) || before === 0) {
      // increase
      const newSz = before + signed;
      pos.entryPx = (Math.abs(before) * pos.entryPx + sz * px) / Math.abs(newSz);
      pos.szi = newSz;
      if (pos.mode === 'isolated') {
        const m = (sz * px) / pos.leverage;
        pos.isoMargin += m;
        s.cash -= m;
      }
      s.cash -= fee;
      dir = signed > 0 ? 'Open Long' : 'Open Short';
    } else {
      const closeSz = Math.min(sz, Math.abs(before));
      closedPnl = closeSz * (px - pos.entryPx) * Math.sign(before);
      if (pos.mode === 'isolated') {
        const released = pos.isoMargin * (closeSz / Math.abs(before));
        pos.isoMargin -= released;
        s.cash += Math.max(liquidation ? 0 : -Infinity, released + closedPnl);
      } else {
        s.cash += closedPnl;
      }
      s.cash -= fee;
      pos.szi = before + Math.sign(signed) * closeSz;
      const rest = sz - closeSz;
      dir = before > 0 ? 'Close Long' : 'Close Short';
      if (Math.abs(pos.szi) < EPS) {
        delete s.positions[o.coin];
        if (rest > EPS) {
          dir = before > 0 ? 'Long > Short' : 'Short > Long';
          const np: Position = { coin: o.coin, szi: Math.sign(signed) * rest, entryPx: px, leverage: ls.leverage, mode: ls.mode, isoMargin: 0, cumFunding: 0, openedAt: time };
          if (np.mode === 'isolated') { np.isoMargin = (rest * px) / np.leverage; s.cash -= np.isoMargin; }
          s.positions[o.coin] = np;
        }
      }
    }
    if (s.cash < 0 && liquidation) s.cash = 0; // backstop absorbs bad debt

    this.recordFill(o, { px, sz, time, fee, closedPnl, dir, liquidity, liquidation });

    if (!s.positions[o.coin]) this.onFlat(o.coin, time);
  }

  private onFlat(coin: string, time: number) {
    for (const o of this.state.orders) {
      if (o.coin !== coin || (o.status !== 'open' && o.status !== 'pending')) continue;
      if (o.trigger?.positionTpsl || (o.reduceOnly && o.status === 'open')) this.finish(o, 'canceled', 'Position closed', time);
    }
  }

  private finish(o: Order, status: OrderStatus, msg: string, time: number) {
    o.status = status;
    o.statusMsg = msg;
    // spot: arm attached TP/SL for whatever the entry actually bought
    if (o.tpsl && (o.recv ?? 0) > 0) this.spawnTpsl(o, time);
    if (o.quiet) return;
    this.state.history.push({ time, order: { ...o } });
    if (this.state.history.length > 2000) this.state.history.splice(0, this.state.history.length - 2000);
  }

  private spawnTpsl(o: Order, now: number) {
    const t = o.tpsl;
    if (!t) return;
    o.tpsl = undefined;
    const a = this.asset(o.coin);
    const exit: Side = o.side === 'B' ? 'A' : 'B';
    const sz = a.spot ? roundSize(o.recv ?? 0, a.szDecimals) : o.origSz;
    if (!(sz > 0)) return;
    for (const kind of ['tp', 'sl'] as const) {
      const px = t[kind];
      if (!px) continue;
      const r = this.placeOrder({ coin: o.coin, side: exit, kind: 'trigger', sz, trigger: { triggerPx: px, isMarket: true, tpsl: kind, positionTpsl: !a.spot } }, now);
      if (!r.ok) this.onEvent({ type: 'reject', msg: `${this.label(o.coin)} ${kind.toUpperCase()}: ${r.error}` });
    }
  }

  private cleanup() {
    this.state.orders = this.state.orders.filter((o) => o.status === 'open' || o.status === 'pending');
  }

  // --------------------------------------------------------------- triggers
  private checkTriggers(now: number) {
    let any = false;
    for (const o of [...this.state.orders]) {
      if (o.kind !== 'trigger' || o.status !== 'open' || !o.trigger) continue;
      const mark = this.markPx(o.coin);
      if (!mark) continue;
      const t = o.trigger;
      // sell SL triggers when mark falls to trigger; sell TP when it rises. Buy is the mirror.
      const hit = o.side === 'A'
        ? (t.tpsl === 'sl' ? mark <= t.triggerPx : mark >= t.triggerPx)
        : (t.tpsl === 'sl' ? mark >= t.triggerPx : mark <= t.triggerPx);
      if (!hit) continue;
      any = true;
      const pos = this.state.positions[o.coin];
      let sz = o.sz;
      if (t.positionTpsl) {
        if (!pos || Math.sign(pos.szi) !== -sideSign(o.side)) { this.finish(o, 'canceled', 'No position', now); continue; }
        sz = Math.abs(pos.szi);
      }
      const sp = this.assets.get(o.coin)?.spot;
      if (sp && o.side === 'A') {
        // spot TP/SL sells what you still hold, up to the order size
        sz = roundSize(Math.min(sz, this.spotAvailable(sp.base)), this.asset(o.coin).szDecimals);
        if (sz <= 0) { this.finish(o, 'canceled', `No ${sp.base} balance left`, now); continue; }
      }
      this.finish(o, 'triggered', `Triggered at mark ${mark}`, now);
      this.onEvent({ type: 'info', msg: `${this.label(o.coin)} ${t.tpsl.toUpperCase()} triggered at ${mark}` });
      // spawn the child order immediately (trigger evaluation happens on the exchange)
      const child: Order = {
        oid: this.state.nextId++, coin: o.coin, side: o.side, kind: t.isMarket ? 'market' : 'limit',
        px: t.isMarket ? 0 : o.px, sz, origSz: sz, tif: t.isMarket ? 'Ioc' : 'Gtc', reduceOnly: o.reduceOnly,
        status: 'pending', createdAt: now, queueAhead: 0, queuePrevBook: 0,
      };
      if (t.isMarket) {
        // Hyperliquid uses 10% slippage for TP/SL market orders
        const mid = this.midPx(o.coin);
        child.px = this.roundPx(o.coin, mid * (1 + sideSign(o.side) * 0.1), o.side === 'B' ? 'up' : 'down');
        child.kind = 'limit';
        child.tif = 'Ioc';
      }
      this.state.orders.push(child);
      this.arrive(child, now);
    }
    if (any) { this.cleanup(); this.changed(); }
  }

  // ----------------------------------------------------------- liquidations
  private checkLiquidations(now: number) {
    const s = this.state;
    const positions = Object.values(s.positions);
    if (!positions.length) return;
    // isolated
    for (const p of positions) {
      if (p.mode !== 'isolated') continue;
      if (p.isoMargin + this.upnl(p) < this.positionMaint(p)) this.liquidate([p], now);
    }
    const cross = Object.values(s.positions).filter((p) => p.mode === 'cross');
    if (cross.length) {
      const sum = this.summary();
      if (sum.crossAccountValue < sum.crossMaint) {
        for (const o of s.orders) if (o.status === 'open' && this.levSetting(o.coin).mode === 'cross') this.finish(o, 'canceled', 'Canceled due to liquidation', now);
        this.cleanup();
        this.liquidate(cross, now);
      }
    }
  }

  private liquidate(ps: Position[], now: number) {
    for (const p of ps) {
      const o: Order = {
        oid: this.state.nextId++, coin: p.coin, side: p.szi > 0 ? 'A' : 'B', kind: 'market', px: 0,
        sz: Math.abs(p.szi), origSz: Math.abs(p.szi), tif: 'Ioc', reduceOnly: true, status: 'pending',
        createdAt: now, queueAhead: 0, queuePrevBook: 0,
      };
      this.takeLiquidity(o, now, true);
      // anything the visible book couldn't absorb goes to the backstop at mark
      if (this.state.positions[p.coin] && o.sz > EPS) this.applyFill(o, this.markPx(p.coin), o.sz, 'taker', now, true);
      if (o.status === 'pending') this.finish(o, 'filled', 'Liquidation', now);
    }
    this.onEvent({ type: 'liquidation', msg: `Liquidated: ${ps.map((p) => p.coin).join(', ')}` });
    this.changed();
  }

  // ---------------------------------------------------------------- funding
  private settleFunding(time: number) {
    for (const p of Object.values(this.state.positions)) {
      const c = this.ctxs.get(p.coin);
      if (!c) continue;
      const payment = p.szi * c.oraclePx * c.funding; // positive => this account pays
      if (p.mode === 'isolated') p.isoMargin -= payment;
      else this.state.cash -= payment;
      p.cumFunding += payment;
      this.state.funding.unshift({ time, coin: p.coin, szi: p.szi, rate: c.funding, payment: -payment });
    }
    if (this.state.funding.length > 2000) this.state.funding.length = 2000;
  }

  // --------------------------------------------------------- account actions
  setLeverage(coin: string, leverage: number, mode: MarginMode): string | null {
    const a = this.asset(coin);
    if (a.onlyIsolated && mode === 'cross') return `${coin} is isolated-only`;
    leverage = Math.max(1, Math.min(Math.round(leverage), a.maxLeverage));
    const pos = this.state.positions[coin];
    if (pos) {
      if (pos.mode !== mode) return 'Cannot switch margin mode with an open position';
      const ntl = Math.abs(pos.szi) * this.markPx(coin);
      if (leverage > this.maxLeverageFor(coin, ntl)) return `Max leverage at this position size is ${this.maxLeverageFor(coin, ntl)}x`;
      if (mode === 'isolated') {
        const target = ntl / leverage;
        const delta = target - pos.isoMargin;
        if (delta > 0 && delta > this.summary().available) return 'Insufficient margin to lower leverage';
        pos.isoMargin += delta;
        this.state.cash -= delta;
      } else if (leverage < pos.leverage) {
        const extra = ntl / leverage - ntl / pos.leverage;
        if (extra > this.summary().available) return 'Insufficient margin to lower leverage';
      }
      pos.leverage = leverage;
    }
    this.state.lev[coin] = { leverage, mode };
    this.changed();
    return null;
  }

  updateIsolatedMargin(coin: string, delta: number): string | null {
    const p = this.state.positions[coin];
    if (!p || p.mode !== 'isolated') return 'No isolated position';
    if (delta > 0 && delta > this.summary().available) return 'Insufficient available balance';
    if (delta < 0) {
      const ntl = Math.abs(p.szi) * this.markPx(coin);
      const minMargin = ntl / this.maxLeverageFor(coin, ntl);
      if (p.isoMargin + delta + Math.min(0, this.upnl(p)) < minMargin) return 'Cannot remove that much margin';
    }
    p.isoMargin += delta;
    this.state.cash -= delta;
    this.changed();
    return null;
  }

  /** market-close a position (reduce only) */
  closePosition(coin: string, fraction = 1, limitPx?: number): PlaceResult {
    const p = this.state.positions[coin];
    if (!p) return { ok: false, error: 'No position' };
    const a = this.asset(coin);
    const sz = roundSize(Math.abs(p.szi) * fraction, a.szDecimals) || Math.abs(p.szi);
    return this.placeOrder({ coin, side: p.szi > 0 ? 'A' : 'B', kind: limitPx ? 'limit' : 'market', px: limitPx, sz, reduceOnly: true, tif: 'Gtc' });
  }

  // ------------------------------------------------------------------ scale
  /**
   * Hyperliquid scale order ladder: `n` limit orders evenly spaced from startPx to endPx.
   * Sizes grow linearly so the last order is `skew` times the first.
   */
  scaleLadder(coin: string, totalSz: number, startPx: number, endPx: number, n: number, skew: number): { px: number; sz: number }[] {
    const a = this.assets.get(coin);
    if (!a || !(n >= 2) || !(skew > 0) || !(totalSz > 0) || !(startPx > 0) || !(endPx > 0)) return [];
    n = Math.floor(n);
    const first = (2 * totalSz) / (n * (1 + skew));
    const out: { px: number; sz: number }[] = [];
    let used = 0;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const px = this.roundPx(coin, startPx + (endPx - startPx) * f);
      const sz = i === n - 1 ? roundSize(totalSz - used, a.szDecimals) : roundSize(first * (1 + (skew - 1) * f), a.szDecimals);
      used += sz;
      out.push({ px, sz });
    }
    return out;
  }

  placeScale(req: { coin: string; side: Side; sz: number; startPx: number; endPx: number; n: number; skew: number; reduceOnly?: boolean }, now = Date.now()): PlaceResult & { oids?: number[] } {
    if (!this.assets.has(req.coin)) return { ok: false, error: 'Unknown asset' };
    if (!(req.n >= 2 && req.n <= 100)) return { ok: false, error: 'Total orders must be between 2 and 100' };
    if (!(req.skew >= 0.01 && req.skew <= 100)) return { ok: false, error: 'Size skew must be between 0.01 and 100' };
    if (!(req.startPx > 0 && req.endPx > 0)) return { ok: false, error: 'Enter start and end prices' };
    const ladder = this.scaleLadder(req.coin, req.sz, req.startPx, req.endPx, req.n, req.skew);
    if (!ladder.length || ladder.some((l) => l.sz <= 0)) return { ok: false, error: 'Size too small for this many orders' };
    if (!req.reduceOnly) {
      const small = ladder.find((l) => l.px * l.sz < MIN_ORDER_NOTIONAL);
      if (small) return { ok: false, error: `Each scale order must be worth at least $${MIN_ORDER_NOTIONAL} (smallest is $${(small.px * small.sz).toFixed(2)})` };
    }
    const oids: number[] = [];
    for (const l of ladder) {
      const r = this.placeOrder({ coin: req.coin, side: req.side, kind: 'limit', px: l.px, sz: l.sz, reduceOnly: req.reduceOnly, tif: 'Gtc' }, now);
      if (!r.ok) return { ok: oids.length > 0, error: r.error, oids };
      oids.push(r.oid!);
    }
    return { ok: true, oids, oid: oids[0] };
  }

  // ------------------------------------------------------------------- TWAP
  placeTwap(req: { coin: string; side: Side; sz: number; minutes: number; randomize?: boolean; reduceOnly?: boolean }, now = Date.now()): PlaceResult {
    const a = this.assets.get(req.coin);
    if (!a) return { ok: false, error: 'Unknown asset' };
    if (a.spot && req.reduceOnly) return { ok: false, error: 'Reduce only is not available for spot' };
    if (!(req.minutes >= 5 && req.minutes <= 1440)) return { ok: false, error: 'TWAP duration must be between 5 minutes and 24 hours' };
    const sz = roundSize(req.sz, a.szDecimals);
    if (!(sz > 0)) return { ok: false, error: 'Order size must be positive' };
    const durationMs = Math.round(req.minutes) * 60_000;
    const slices = durationMs / TWAP_INTERVAL_MS;
    const px = this.midPx(req.coin);
    if (!px) return { ok: false, error: 'No price data yet' };
    if ((sz / slices) * px < MIN_ORDER_NOTIONAL && !req.reduceOnly) {
      return { ok: false, error: `Each TWAP sub-order must be worth at least $${MIN_ORDER_NOTIONAL}: increase size to ${fmtMin(MIN_ORDER_NOTIONAL * slices)} USD or shorten the duration` };
    }
    const t: Twap = {
      id: this.state.nextId++, coin: req.coin, side: req.side, totalSz: sz, filledSz: 0, notional: 0,
      startedAt: now, durationMs, randomize: !!req.randomize, reduceOnly: !!req.reduceOnly, status: 'running', nextAt: now,
    };
    this.state.twaps.unshift(t);
    if (this.state.twaps.length > 500) this.state.twaps.length = 500;
    this.onEvent({ type: 'info', msg: `TWAP started: ${req.side === 'B' ? 'Buy' : 'Sell'} ${sz} ${this.label(req.coin)} over ${req.minutes}m` });
    this.changed();
    return { ok: true, oid: t.id };
  }

  cancelTwap(id: number, now = Date.now()) {
    const t = this.state.twaps.find((x) => x.id === id);
    if (!t || t.status !== 'running') return;
    t.status = 'canceled';
    t.endedAt = now;
    this.changed();
  }

  private stepTwap(t: Twap, now: number) {
    const a = this.assets.get(t.coin);
    if (!a) return;
    const remaining = roundSize(t.totalSz - t.filledSz, a.szDecimals);
    const end = t.startedAt + t.durationMs;
    if (remaining <= 0 || now >= end + TWAP_INTERVAL_MS) {
      t.status = 'completed';
      t.endedAt = now;
      const avg = t.filledSz ? t.notional / t.filledSz : 0;
      this.onEvent({ type: 'info', msg: `TWAP finished: ${t.filledSz} / ${t.totalSz} ${this.label(t.coin)}${avg ? ` @ avg ${avg.toPrecision(6)}` : ''}` });
      this.changed();
      return;
    }
    t.nextAt = now + TWAP_INTERVAL_MS;
    if (t.reduceOnly) {
      const pos = this.state.positions[t.coin];
      if (!pos || Math.sign(pos.szi) !== -sideSign(t.side)) { t.status = 'completed'; t.endedAt = now; t.lastMsg = 'Position closed'; this.changed(); return; }
    }
    const slices = t.durationMs / TWAP_INTERVAL_MS;
    const sliceSz = t.totalSz / slices;
    const done = Math.min(slices, Math.floor((now - t.startedAt) / TWAP_INTERVAL_MS) + 1);
    const target = Math.min(t.totalSz, sliceSz * done);
    let sz = Math.min(target - t.filledSz, 3 * sliceSz); // catch-up capped at 3x a normal slice
    if (t.randomize) sz *= 0.8 + Math.random() * 0.4;
    sz = roundSize(Math.min(sz, remaining), a.szDecimals);
    if (sz <= 0) return;
    const mid = this.midPx(t.coin);
    if (!mid) return;
    const o: Order = {
      oid: this.state.nextId++, coin: t.coin, side: t.side, kind: 'limit',
      px: this.roundPx(t.coin, mid * (1 + sideSign(t.side) * TWAP_SLIPPAGE), t.side === 'B' ? 'up' : 'down'),
      sz, origSz: sz, tif: 'Ioc', reduceOnly: t.reduceOnly, status: 'pending', createdAt: now,
      queueAhead: 0, queuePrevBook: 0, twapId: t.id, quiet: true,
    };
    this.state.orders.push(o);
    this.arrive(o, now);
    this.cleanup();
    this.changed();
  }

  // --------------------------------------------------------- equity history
  recordEquity(now = Date.now()) {
    const h = this.state.equityHist;
    h.push([now, this.summary().equity]);
    // keep 1-minute resolution for the last 7 days, hourly before that
    if (h.length > 20_000) {
      const cutoff = now - 7 * 86_400_000;
      const out: [number, number][] = [];
      let lastHour = -1;
      for (const p of h) {
        if (p[0] >= cutoff) { out.push(p); continue; }
        const hr = Math.floor(p[0] / 3_600_000);
        if (hr !== lastHour) { out.push(p); lastHour = hr; }
      }
      this.state.equityHist = out;
    }
    this.changed();
  }

  reset(settings?: Partial<Settings>) {
    const merged = { ...this.state.settings, ...settings };
    this.state = newState(merged);
    this.pending = [];
    this.consumed.clear();
    this.changed();
  }

  updateSettings(s: Partial<Settings>) {
    this.state.settings = { ...this.state.settings, ...s };
    this.changed();
  }

  /** simulate fill against current book without executing (for UI estimate) */
  estimateTaker(coin: string, side: Side, sz: number): { avgPx: number; filled: number; slippage: number } | null {
    const book = this.books.get(coin);
    if (!book) return null;
    const levels = side === 'B' ? book.asks : book.bids;
    let left = sz, cost = 0;
    for (const l of levels) {
      if (left <= 0) break;
      const f = Math.min(l.sz, left);
      cost += f * l.px;
      left -= f;
    }
    const filled = sz - left;
    if (!filled) return null;
    const avgPx = cost / filled;
    const mid = this.midPx(coin);
    return { avgPx, filled, slippage: Math.abs(avgPx / mid - 1) };
  }
}
