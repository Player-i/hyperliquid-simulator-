// Thin client for Hyperliquid's public (read-only) market data API.
// No keys, no signing: the simulator only *reads* real market data.

export const INFO_URL = 'https://api.hyperliquid.xyz/info';
export const WS_URL = 'wss://api.hyperliquid.xyz/ws';

export interface RawLevel { px: string; sz: string; n: number }
export interface RawBook { coin: string; time: number; levels: [RawLevel[], RawLevel[]] }
export interface RawTrade { coin: string; side: 'B' | 'A'; px: string; sz: string; time: number; tid: number; hash: string }
export interface RawCandle { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number }
export interface RawAssetCtx {
  funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string;
  premium: string | null; oraclePx: string; markPx: string; midPx: string | null;
  impactPxs: string[] | null; dayBaseVlm: string;
}
export interface RawUniverseAsset { name: string; szDecimals: number; maxLeverage: number; marginTableId: number; isDelisted?: boolean; onlyIsolated?: boolean }
export interface RawMarginTier { lowerBound: string; maxLeverage: number }
export interface RawMeta {
  universe: RawUniverseAsset[];
  marginTables: [number, { description: string; marginTiers: RawMarginTier[] }][];
}

export interface RawSpotToken { name: string; szDecimals: number; index: number; fullName: string | null }
export interface RawSpotPair { name: string; tokens: [number, number]; index: number; isCanonical: boolean }
export interface RawSpotMeta { tokens: RawSpotToken[]; universe: RawSpotPair[] }
export interface RawSpotCtx { coin: string; markPx: string; midPx: string | null; prevDayPx: string; dayNtlVlm: string; circulatingSupply: string }

export async function info<T>(body: unknown): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`info ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchMetaAndCtxs = () => info<[RawMeta, RawAssetCtx[]]>({ type: 'metaAndAssetCtxs' });
export const fetchSpotMetaAndCtxs = () => info<[RawSpotMeta, RawSpotCtx[]]>({ type: 'spotMetaAndAssetCtxs' });
export const fetchFundingHistory = (coin: string, startTime: number, endTime: number) =>
  info<{ coin: string; fundingRate: string; premium: string; time: number }[]>({ type: 'fundingHistory', coin, startTime, endTime });
export const fetchBook = (coin: string) => info<RawBook>({ type: 'l2Book', coin });
export const fetchCandles = (coin: string, interval: string, startTime: number, endTime: number) =>
  info<RawCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } });

// ---------------------------------------------------------------------------
// WebSocket manager with ref-counted subscriptions and auto-reconnect.

type Sub = Record<string, unknown> & { type: string };
type Handler = (data: any) => void;

function subKey(s: Sub) {
  return JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
}

export type WsStatus = 'connecting' | 'open' | 'closed';

export class HLSocket {
  private ws: WebSocket | null = null;
  private subs = new Map<string, { sub: Sub; handlers: Set<Handler> }>();
  private pingTimer: number | undefined;
  private reconnectDelay = 500;
  status: WsStatus = 'closed';
  onStatus: (s: WsStatus) => void = () => {};
  lastMessageAt = 0;

  connect() {
    this.setStatus('connecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.setStatus('open');
      for (const { sub } of this.subs.values()) this.send({ method: 'subscribe', subscription: sub });
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ method: 'ping' }), 30_000);
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this.dispatch(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.setStatus('closed');
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  }

  private setStatus(s: WsStatus) { this.status = s; this.onStatus(s); }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private dispatch(msg: { channel: string; data: any }) {
    const { channel, data } = msg;
    if (!data || channel === 'subscriptionResponse' || channel === 'pong') return;
    // route message back to the subscription it belongs to
    let key: string | null = null;
    switch (channel) {
      case 'l2Book': key = subKey({ type: 'l2Book', coin: data.coin }); break;
      case 'trades': if (data.length) key = subKey({ type: 'trades', coin: data[0].coin }); break;
      case 'candle': key = subKey({ type: 'candle', coin: data.s, interval: data.i }); break;
      case 'activeSpotAssetCtx':
      case 'activeAssetCtx': key = subKey({ type: 'activeAssetCtx', coin: data.coin }); break;
      case 'allMids': key = subKey({ type: 'allMids' }); break;
    }
    if (!key) return;
    const entry = this.subs.get(key);
    if (entry) for (const h of entry.handlers) h(data);
  }

  subscribe(sub: Sub, handler: Handler): () => void {
    const key = subKey(sub);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { sub, handlers: new Set() };
      this.subs.set(key, entry);
      this.send({ method: 'subscribe', subscription: sub });
    }
    entry.handlers.add(handler);
    return () => {
      const e = this.subs.get(key);
      if (!e) return;
      e.handlers.delete(handler);
      if (e.handlers.size === 0) {
        this.subs.delete(key);
        this.send({ method: 'unsubscribe', subscription: sub });
      }
    };
  }
}
