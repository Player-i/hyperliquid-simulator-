import { useEffect, useReducer } from 'react';
import { HLSocket, fetchMetaAndCtxs, type RawAssetCtx, type RawBook, type RawTrade, type WsStatus } from './api/hl';
import { Engine, newState, DEFAULT_SETTINGS, type AssetInfo, type Book, type Ctx, type State, type Trade } from './engine/engine';

const STORAGE_KEY = 'hlsim:state:v1';
const PREFS_KEY = 'hlsim:prefs:v1';

export interface MarketRow extends AssetInfo {
  markPx: number; oraclePx: number; funding: number; prevDayPx: number; dayNtlVlm: number; openInterest: number; midPx: number | null;
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

export interface Prefs { coin: string; interval: string; favorites: string[] }
function loadPrefs(): Prefs {
  try { return { coin: 'BTC', interval: '15m', favorites: ['BTC', 'ETH', 'SOL', 'HYPE'], ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { coin: 'BTC', interval: '15m', favorites: ['BTC', 'ETH', 'SOL', 'HYPE'] }; }
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
  error: string | null = null;
  private listeners = new Set<() => void>();
  private bookSubs = new Map<string, () => void>();
  private dirty = false;
  private toastId = 1;

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
    await this.refreshMarkets();
    this.ready = true;
    if (!this.marketsByCoin.has(this.prefs.coin)) this.prefs.coin = 'BTC';
    this.syncSubscriptions();
    setInterval(() => this.refreshMarkets().catch(() => {}), 3_000);
    setInterval(() => this.engine.tick(Date.now()), 50);
    setInterval(() => this.syncSubscriptions(), 1_000);
    setInterval(() => this.persist(), 1_000);
    window.addEventListener('beforeunload', () => { this.dirty = true; this.persist(); });
    this.notify();
  }

  private async refreshMarkets() {
    try {
      const [meta, ctxs] = await fetchMetaAndCtxs();
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
          midPx: c.midPx ? Number(c.midPx) : null,
        };
        rows.push(row);
        ctxMap[u.name] = { markPx: row.markPx, oraclePx: row.oraclePx, funding: row.funding, midPx: row.midPx };
      });
      this.markets = rows;
      this.marketsByCoin = new Map(rows.map((r) => [r.coin, r]));
      this.engine.setAssets(rows);
      this.engine.onCtxs(ctxMap);
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
      const u3 = this.socket.subscribe({ type: 'activeAssetCtx', coin }, (d: { coin: string; ctx: RawAssetCtx }) => {
        const c = d.ctx;
        const m = this.marketsByCoin.get(coin);
        if (m) { m.markPx = Number(c.markPx); m.oraclePx = Number(c.oraclePx); m.funding = Number(c.funding); m.openInterest = Number(c.openInterest); m.dayNtlVlm = Number(c.dayNtlVlm); m.prevDayPx = Number(c.prevDayPx); }
        this.engine.onCtxs({ [coin]: { markPx: Number(c.markPx), oraclePx: Number(c.oraclePx), funding: Number(c.funding), midPx: c.midPx ? Number(c.midPx) : null } });
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
    } catch { /* storage full or blocked */ }
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
