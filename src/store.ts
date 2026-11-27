import { useEffect, useReducer } from 'react';
import { chooseInterval, replay, type Candle, type ReplayResult } from './engine/replay';
import { HLSocket, fetchBook, fetchCandles, fetchFundingHistory, fetchMetaAndCtxs, fetchSpotMetaAndCtxs, type RawAssetCtx, type RawBook, type RawTrade, type WsStatus } from './api/hl';
import { Engine, newState, DEFAULT_SETTINGS, type AssetInfo, type Book, type Ctx, type State, type Trade } from './engine/engine';

const STORAGE_KEY = 'hlsim:state:v1';
const PREFS_KEY = 'hlsim:prefs:v1';

export interface MarketRow extends AssetInfo {
  markPx: number; oraclePx: number; funding: number; prevDayPx: number; dayNtlVlm: number; openInterest: number; midPx: number | null;
  /** spot only */
  circulatingSupply?: number;
  /** "BTC-USD" for perps, "HYPE/USDC" for spot */
  display: string;
}

function loadState(): State | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as State;
    // Infinity does not survive JSON
    for (const o of s.orders) {
      if (o.queueAhead == null) o.queueAhead = Number.POSITIVE_INFINITY;
      if (o.queuePrevBook == null) o.queuePrevBook = o.queueAhead;
      // orders still in flight when the tab closed never reached the exchange
    }
    s.orders = s.orders.filter((o) => o.status === 'open');
    s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
    return s;
  } catch { return undefined; }
}

export type View = 'trade' | 'portfolio';
export interface Prefs { coin: string; interval: string; favorites: string[]; view: View }
const DEFAULT_PREFS: Prefs = { coin: 'BTC', interval: '15m', favorites: ['BTC', 'ETH', 'SOL', 'HYPE', '@107'], view: 'trade' };
function loadPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_PREFS }; }
}

export interface Toast { id: number; type: string; msg: string }

class Store {
  engine = new Engine(loadState() ?? newState());
  socket = new HLSocket();
  markets: MarketRow[] = [];
  marketsByCoin = new Map<string, MarketRow>();
  trades = new Map<string, Trade[]>();
  prefs = loadPrefs();
  wsStatus: WsStatus = 'closed';
  toasts: Toast[] = [];
  ready = false;
  /** catch-up replay of the time the app was closed */
  catchup: { status: 'running'; from: number; to: number } | { status: 'done'; result: ReplayResult } | { status: 'failed'; msg: string } | null = null;
  error: string | null = null;
  private listeners = new Set<() => void>();
  private bookSubs = new Map<string, () => void>();
  private dirty = false;
  private toastId = 1;
  private warnedStorage = false;

  constructor() {
    this.engine.subscribe(() => { this.dirty = true; this.notify(); });
    this.engine.onEvent = (e) => this.toast(e.type, e.msg);
    this.socket.onStatus = (s) => { this.wsStatus = s; this.notify(); };
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private raf = 0;
  notify() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; for (const l of this.listeners) l(); });
  }

  toast(type: string, msg: string) {
    const t = { id: this.toastId++, type, msg };
    this.toasts = [...this.toasts.slice(-4), t];
    this.notify();
    setTimeout(() => { this.toasts = this.toasts.filter((x) => x.id !== t.id); this.notify(); }, type === 'liquidation' ? 10_000 : 4_000);
  }

  async start() {
    this.socket.connect();
    // load markets without feeding today's prices to the engine yet: the
    // catch-up must replay history first, in time order
    await this.refreshMarkets(false);
    try { await this.catchUp(); } catch (err) {
      this.catchup = { status: 'failed', msg: `Couldn't replay the time the app was closed: ${String((err as Error)?.message ?? err)}` };
      this.engine.replaying = false;
    }
    this.engine.state.lastSeen = Date.now();
    await this.refreshMarkets();
    this.ready = true;
    if (!this.marketsByCoin.has(this.prefs.coin)) this.prefs.coin = 'BTC';
    this.syncSubscriptions();
    setInterval(() => this.refreshMarkets().catch(() => {}), 3_000);
    setInterval(() => this.engine.tick(Date.now()), 50);
    setInterval(() => this.syncSubscriptions(), 1_000);
    setInterval(() => this.persist(), 1_000);
    this.engine.recordEquity();
    setInterval(() => this.engine.recordEquity(), 60_000);
    setInterval(() => { this.engine.state.lastSeen = Date.now(); this.dirty = true; }, 5_000);
    window.addEventListener('beforeunload', () => { this.engine.state.lastSeen = Date.now(); this.dirty = true; this.persist(); });
    this.notify();
  }

  /** coins whose history matters for the account: open orders, positions, running TWAPs */
  private exposedCoins() {
    const st = this.engine.state;
    const set = new Set<string>();
    for (const o of st.orders) if (o.status === 'open') set.add(o.coin);
    for (const c of Object.keys(st.positions)) set.add(c);
    for (const t of st.twaps) if (t.status === 'running') set.add(t.coin);
    return [...set].filter((c) => this.marketsByCoin.has(c));
  }

  private async catchUp() {
    const e = this.engine;
    const from = e.state.lastSeen;
    const to = Date.now();
    if (!from || to - from < 60_000) return;
    const coins = this.exposedCoins();
    if (!coins.length) { e.state.lastFundingHour = Math.floor(to / 3_600_000); return; }
    // coins we don't replay are valued at today's prices (no triggers run for them)
    for (const [c, ctx] of Object.entries(this.latestCtx)) if (!coins.includes(c)) e.ctxs.set(c, ctx);
    this.catchup = { status: 'running', from, to };
    this.notify();
    const [interval, ms] = chooseInterval(to - from);
    const candles: Record<string, Candle[]> = {};
    const books: Record<string, Book | undefined> = {};
    const funding: Record<string, { time: number; rate: number }[]> = {};
    await Promise.all(coins.map(async (coin) => {
      const [cs, book] = await Promise.all([
        fetchCandles(coin, interval, from - ms, to).catch(() => []),
        fetchBook(coin).then(parseBook).catch(() => undefined),
      ]);
      candles[coin] = cs.map((c) => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c) })).sort((a, b) => a.t - b.t);
      books[coin] = book;
      if (!this.marketsByCoin.get(coin)?.spot && e.state.positions[coin]) {
        const list: { time: number; rate: number }[] = [];
        let start = from;
        for (let page = 0; page < 20 && start < to; page++) {
          const rows = await fetchFundingHistory(coin, start, to).catch(() => []);
          for (const r of rows) list.push({ time: r.time, rate: Number(r.fundingRate) });
          if (rows.length < 500) break;
          start = rows[rows.length - 1].time + 1;
        }
        funding[coin] = list;
      }
    }));
    const result = replay(e, { from, to, intervalMs: ms, candles, books, funding });
    this.catchup = { status: 'done', result };
    this.dirty = true;
    this.persist();
    this.notify();
  }

  private latestCtx: Record<string, Ctx> = {};

  dismissCatchup() { this.catchup = null; this.notify(); }

  private async refreshMarkets(applyToEngine = true) {
    try {
      const [perp, spot] = await Promise.allSettled([fetchMetaAndCtxs(), fetchSpotMetaAndCtxs()]);
      if (perp.status === 'rejected') throw perp.reason;
      const [meta, ctxs] = perp.value;
      const tables = new Map(meta.marginTables.map(([id, t]) => [id, t.marginTiers]));
      const rows: MarketRow[] = [];
      const ctxMap: Record<string, Ctx> = {};
      meta.universe.forEach((u, i) => {
        if (u.isDelisted) return;
        const c: RawAssetCtx = ctxs[i];
        const tiers = (tables.get(u.marginTableId) ?? [{ lowerBound: '0', maxLeverage: u.maxLeverage }])
          .map((t) => ({ lowerBound: Number(t.lowerBound), maxLeverage: t.maxLeverage }));
        const row: MarketRow = {
          coin: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, tiers, onlyIsolated: u.onlyIsolated,
          markPx: Number(c.markPx), oraclePx: Number(c.oraclePx), funding: Number(c.funding),
          prevDayPx: Number(c.prevDayPx), dayNtlVlm: Number(c.dayNtlVlm), openInterest: Number(c.openInterest),
          midPx: c.midPx ? Number(c.midPx) : null, display: `${u.name}-USD`,
        };
        rows.push(row);
        ctxMap[u.name] = { markPx: row.markPx, oraclePx: row.oraclePx, funding: row.funding, midPx: row.midPx };
      });
      if (spot.status === 'fulfilled') {
        const [smeta, sctxs] = spot.value;
        const tokens = new Map(smeta.tokens.map((t) => [t.index, t]));
        const sc = new Map(sctxs.map((c) => [c.coin, c]));
        for (const u of smeta.universe) {
          const c = sc.get(u.name);
          const base = tokens.get(u.tokens[0]), quote = tokens.get(u.tokens[1]);
          if (!c || !base || !quote) continue;
          const mark = Number(c.markPx);
          const name = `${base.name}/${quote.name}`;
          rows.push({
            coin: u.name, szDecimals: base.szDecimals, maxLeverage: 1, tiers: [], spot: { name, base: base.name, quote: quote.name },
            markPx: mark, oraclePx: mark, funding: 0, prevDayPx: Number(c.prevDayPx), dayNtlVlm: Number(c.dayNtlVlm),
            openInterest: 0, midPx: c.midPx ? Number(c.midPx) : null, circulatingSupply: Number(c.circulatingSupply), display: name,
          });
          ctxMap[u.name] = { markPx: mark, oraclePx: mark, funding: 0, midPx: c.midPx ? Number(c.midPx) : null };
        }
      }
      this.markets = rows;
      this.marketsByCoin = new Map(rows.map((r) => [r.coin, r]));
      this.engine.setAssets(rows);
      this.latestCtx = ctxMap;
      if (applyToEngine) this.engine.onCtxs(ctxMap);
      this.error = null;
    } catch (e) {
      this.error = 'Cannot reach Hyperliquid API';
      if (!this.ready) throw e;
    } finally {
      this.notify();
    }
  }

  /** keep live book + trades for the active coin and every coin we have exposure in */
  syncSubscriptions() {
    const need = new Set<string>([this.prefs.coin]);
    for (const c of Object.keys(this.engine.state.positions)) need.add(c);
    for (const o of this.engine.state.orders) need.add(o.coin);
    for (const t of this.engine.state.twaps) if (t.status === 'running') need.add(t.coin);
    for (const [coin, unsub] of this.bookSubs) if (!need.has(coin)) { unsub(); this.bookSubs.delete(coin); }
    for (const coin of need) {
      if (this.bookSubs.has(coin) || !this.marketsByCoin.has(coin)) continue;
      const u1 = this.socket.subscribe({ type: 'l2Book', coin }, (d: RawBook) => this.engine.onBook(parseBook(d)));
      const u2 = this.socket.subscribe({ type: 'trades', coin }, (d: RawTrade[]) => {
        const ts = d.map((t) => ({ coin: t.coin, side: t.side, px: Number(t.px), sz: Number(t.sz), time: t.time }));
        const list = this.trades.get(coin) ?? [];
        this.trades.set(coin, [...ts.slice().reverse(), ...list].slice(0, 80));
        this.engine.onTrades(ts);
        this.notify();
      });
      const u3 = this.socket.subscribe({ type: 'activeAssetCtx', coin }, (d: { coin: string; ctx: Partial<RawAssetCtx> & { markPx: string } }) => {
        const c = d.ctx;
        const m = this.marketsByCoin.get(coin);
        const mark = Number(c.markPx);
        const oracle = c.oraclePx ? Number(c.oraclePx) : mark;
        const funding = c.funding ? Number(c.funding) : 0;
        if (m) {
          m.markPx = mark; m.oraclePx = oracle; m.funding = funding; m.dayNtlVlm = Number(c.dayNtlVlm); m.prevDayPx = Number(c.prevDayPx);
          if (c.openInterest) m.openInterest = Number(c.openInterest);
        }
        this.engine.onCtxs({ [coin]: { markPx: mark, oraclePx: oracle, funding, midPx: c.midPx ? Number(c.midPx) : null } });
      });
      this.bookSubs.set(coin, () => { u1(); u2(); u3(); });
    }
  }

  setCoin(coin: string) {
    this.prefs.coin = coin;
    this.savePrefs();
    this.syncSubscriptions();
    this.notify();
  }

  setInterval(i: string) { this.prefs.interval = i; this.savePrefs(); this.notify(); }

  setView(v: View) { this.prefs.view = v; this.savePrefs(); this.notify(); }

  display(coin: string) { return this.marketsByCoin.get(coin)?.display ?? this.engine.label(coin); }

  toggleFavorite(coin: string) {
    const f = this.prefs.favorites;
    this.prefs.favorites = f.includes(coin) ? f.filter((c) => c !== coin) : [...f, coin];
    this.savePrefs();
    this.notify();
  }

  private savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)); } catch { /* ignore */ } }

  persist() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.engine.state, (_k, v) => (v === Number.POSITIVE_INFINITY ? null : v)));
    } catch {
      if (!this.warnedStorage) { this.warnedStorage = true; this.toast('reject', 'Could not save your account to browser storage (full or blocked).'); }
    }
  }
}

export function parseBook(d: RawBook): Book {
  return {
    coin: d.coin,
    time: d.time,
    bids: d.levels[0].map((l) => ({ px: Number(l.px), sz: Number(l.sz), n: l.n })),
    asks: d.levels[1].map((l) => ({ px: Number(l.px), sz: Number(l.sz), n: l.n })),
  };
}

export const store = new Store();

/** re-render on any store/engine change (batched per animation frame) */
export function useStore() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => store.subscribe(force), []);
  return store;
}
