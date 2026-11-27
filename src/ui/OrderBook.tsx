import { useMemo, useState } from 'react';
import type { Level } from '../engine/engine';
import { tickFor } from '../engine/rules';
import { useStore } from '../store';
import { fmtPx, fmtSz, fmtTime, pxDecimals } from './format';

export const bookClick = { setPrice: (_px: number) => {} };

const ROWS = 11;

function group(levels: Level[], step: number, side: 'bid' | 'ask'): Level[] {
  const out = new Map<number, Level>();
  for (const l of levels) {
    const k = side === 'bid' ? Math.floor(l.px / step + 1e-9) * step : Math.ceil(l.px / step - 1e-9) * step;
    const key = Number(k.toFixed(10));
    const cur = out.get(key);
    if (cur) { cur.sz += l.sz; cur.n += l.n; } else out.set(key, { px: key, sz: l.sz, n: l.n });
  }
  return [...out.values()];
}

export function OrderBookPanel() {
  const [tab, setTab] = useState<'book' | 'trades'>('book');
  return (
    <>
      <div className="tabs">
        <button className={tab === 'book' ? 'active' : ''} onClick={() => setTab('book')}>Order Book</button>
        <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>Trades</button>
      </div>
      {tab === 'book' ? <OrderBook /> : <Tape />}
    </>
  );
}

function OrderBook() {
  const s = useStore();
  const coin = s.prefs.coin;
  const m = s.marketsByCoin.get(coin);
  const szD = m?.szDecimals ?? 2;
  const book = s.engine.books.get(coin);
  const [mult, setMult] = useState(1);
  const [inUsd, setInUsd] = useState(false);
  const base = tickFor(book?.bids[0]?.px ?? m?.markPx ?? 1, szD);
  const step = base * mult;
  const myPx = useMemo(() => new Set(s.engine.state.orders.filter((o) => o.coin === coin && o.status === 'open' && !o.trigger).map((o) => o.px)), [s.engine.state.orders, coin, book]);

  if (!book) return <div className="empty">Connecting to live {coin} order book…</div>;

  const bids = group(book.bids, step, 'bid').slice(0, ROWS);
  const asks = group(book.asks, step, 'ask').slice(0, ROWS);
  const cum = (ls: Level[]) => { let t = 0; return ls.map((l) => (t += inUsd ? l.sz * l.px : l.sz)); };
  const bidCum = cum(bids), askCum = cum(asks);
  const max = Math.max(bidCum[bidCum.length - 1] ?? 0, askCum[askCum.length - 1] ?? 0) || 1;
  const spread = asks[0] && bids[0] ? book.asks[0].px - book.bids[0].px : 0;
  const mid = book.asks[0] && book.bids[0] ? (book.asks[0].px + book.bids[0].px) / 2 : 0;
  const stepDecimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const fmtStepPx = (px: number) => px.toLocaleString('en-US', { minimumFractionDigits: Math.min(stepDecimals, pxDecimals(px, szD)), maximumFractionDigits: Math.min(stepDecimals, pxDecimals(px, szD)) });
  const fmtSize = (v: number) => (inUsd ? Math.round(v).toLocaleString('en-US') : fmtSz(v, szD));

  const row = (l: Level, total: number, side: 'bid' | 'ask') => (
    <div key={l.px} className={`row ${myPx.has(l.px) ? 'mine' : ''}`} onClick={() => bookClick.setPrice(l.px)} title={`${l.n} orders`}>
      <div className="bar" style={{ width: `${(total / max) * 100}%`, background: side === 'bid' ? 'var(--up-bg)' : 'var(--down-bg)' }} />
      <span className={side === 'bid' ? 'up' : 'down'}>{fmtStepPx(l.px)}</span>
      <span>{fmtSize(inUsd ? l.sz * l.px : l.sz)}</span>
      <span>{fmtSize(total)}</span>
    </div>
  );

  return (
    <div className="book">
      <div className="tabs" style={{ borderBottom: 0, paddingTop: 4 }}>
        <select className="btn small" value={mult} onChange={(e) => setMult(Number(e.target.value))}>
          {[1, 2, 5, 10, 100, 1000].map((x) => <option key={x} value={x}>{Number((base * x).toPrecision(6))}</option>)}
        </select>
        <div className="right">
          <button className="btn small" onClick={() => setInUsd(!inUsd)}>{inUsd ? 'USD' : coin}</button>
        </div>
      </div>
      <div className="hdr"><span>Price</span><span>Size ({inUsd ? 'USD' : coin})</span><span>Total</span></div>
      <div className="side asks">{asks.map((l, i) => ({ l, t: askCum[i] })).reverse().map(({ l, t }) => row(l, t, 'ask'))}</div>
      <div className="spread num">
        <span>Spread</span>
        <span>{fmtPx(spread, szD)} ({mid ? ((spread / mid) * 100).toFixed(3) : '0'}%)</span>
      </div>
      <div className="side">{bids.map((l, i) => row(l, bidCum[i], 'bid'))}</div>
    </div>
  );
}

function Tape() {
  const s = useStore();
  const coin = s.prefs.coin;
  const szD = s.marketsByCoin.get(coin)?.szDecimals ?? 2;
  const trades = s.trades.get(coin) ?? [];
  return (
    <div className="tape">
      <div className="row muted" style={{ paddingTop: 6 }}><span>Price</span><span>Size ({coin})</span><span>Time</span></div>
      {trades.map((t, i) => (
        <div key={i} className="row">
          <span className={t.side === 'B' ? 'up' : 'down'}>{fmtPx(t.px, szD)}</span>
          <span>{fmtSz(t.sz, szD)}</span>
          <span className="muted">{fmtTime(t.time)}</span>
        </div>
      ))}
      {!trades.length && <div className="empty">Waiting for live trades…</div>}
    </div>
  );
}
