import { useState } from 'react';
import type { Order } from '../engine/engine';
import { useStore } from '../store';
import { fmtDateTime, fmtNum, fmtPx, fmtSigned, fmtSz, fmtUsd, pnlClass } from './format';
import { LimitCloseModal, MarginModal, SpotTpslModal, TpslModal } from './Modals';

type Tab = 'balances' | 'positions' | 'orders' | 'twap' | 'trades' | 'funding' | 'history';

export function BottomPanel() {
  const s = useStore();
  const st = s.engine.state;
  const [tab, setTab] = useState<Tab>('positions');
  const [onlyCurrent, setOnlyCurrent] = useState(false);
  const tabs: [Tab, string][] = [
    ['balances', 'Balances'],
    ['positions', `Positions (${Object.keys(st.positions).length})`],
    ['orders', `Open Orders (${st.orders.filter((o) => o.status === 'open' || o.status === 'pending').length})`],
    ['twap', `TWAP (${st.twaps.filter((t) => t.status === 'running').length})`],
    ['trades', 'Trade History'],
    ['funding', 'Funding History'],
    ['history', 'Order History'],
  ];
  return (
    <>
      <div className="tabs">
        {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
        <div className="right">
          <label className="check"><input type="checkbox" checked={onlyCurrent} onChange={(e) => setOnlyCurrent(e.target.checked)} /> {s.display(s.prefs.coin)} only</label>
        </div>
      </div>
      <div className="tablewrap">
        {tab === 'balances' && <Balances />}
        {tab === 'twap' && <Twaps filter={onlyCurrent ? s.prefs.coin : null} />}
        {tab === 'positions' && <Positions filter={onlyCurrent ? s.prefs.coin : null} />}
        {tab === 'orders' && <OpenOrders filter={onlyCurrent ? s.prefs.coin : null} />}
        {tab === 'trades' && <Fills filter={onlyCurrent ? s.prefs.coin : null} />}
        {tab === 'funding' && <Funding filter={onlyCurrent ? s.prefs.coin : null} />}
        {tab === 'history' && <History filter={onlyCurrent ? s.prefs.coin : null} />}
      </div>
    </>
  );
}

function Positions({ filter }: { filter: string | null }) {
  const s = useStore();
  const e = s.engine;
  const [modal, setModal] = useState<{ kind: 'tpsl' | 'margin' | 'limit'; coin: string } | null>(null);
  const ps = Object.values(e.state.positions).filter((p) => !filter || p.coin === filter);
  if (!ps.length) return <div className="empty">No open positions</div>;
  return (
    <>
      <table className="table">
        <thead><tr><th>Coin</th><th>Size</th><th>Position Value</th><th>Entry Price</th><th>Mark Price</th><th>PnL (ROE %)</th><th>Liq. Price</th><th>Margin</th><th>Funding</th><th>TP/SL</th><th>Close</th></tr></thead>
        <tbody>
          {ps.map((p) => {
            const a = e.asset(p.coin);
            const mark = e.markPx(p.coin);
            const u = e.upnl(p);
            const margin = e.positionMargin(p);
            const initMargin = (Math.abs(p.szi) * p.entryPx) / p.leverage;
            const liq = e.liqPx(p);
            const tps = e.state.orders.filter((o) => o.coin === p.coin && o.trigger?.positionTpsl && o.status === 'open');
            const tp = tps.find((o) => o.trigger?.tpsl === 'tp')?.trigger?.triggerPx;
            const sl = tps.find((o) => o.trigger?.tpsl === 'sl')?.trigger?.triggerPx;
            return (
              <tr key={p.coin}>
                <td>
                  <button className="star" style={{ color: p.szi > 0 ? 'var(--up)' : 'var(--down)', fontWeight: 600 }} onClick={() => s.setCoin(p.coin)}>{p.coin}</button>
                  <span className="faint"> {p.leverage}x</span>
                </td>
                <td className={p.szi > 0 ? 'up' : 'down'}>{fmtSz(p.szi, a.szDecimals)} {p.coin}</td>
                <td>{fmtUsd(Math.abs(p.szi) * mark)}</td>
                <td>{fmtPx(p.entryPx, a.szDecimals)}</td>
                <td>{fmtPx(mark, a.szDecimals)}</td>
                <td className={pnlClass(u)}>{fmtSigned(u)} ({((u / initMargin) * 100).toFixed(1)}%)</td>
                <td className="warn">{liq ? fmtPx(liq, a.szDecimals) : 'N/A'}</td>
                <td>
                  {fmtUsd(margin)} <span className="faint">({p.mode === 'cross' ? 'Cross' : 'Isolated'})</span>
                  {p.mode === 'isolated' && <button className="btn small" style={{ marginLeft: 6 }} onClick={() => setModal({ kind: 'margin', coin: p.coin })}>±</button>}
                </td>
                <td className={pnlClass(-p.cumFunding)}>{fmtSigned(-p.cumFunding, 4)}</td>
                <td>
                  <span className="num">{tp ? fmtPx(tp, a.szDecimals) : '--'} / {sl ? fmtPx(sl, a.szDecimals) : '--'}</span>
                  <button className="btn small" style={{ marginLeft: 6 }} onClick={() => setModal({ kind: 'tpsl', coin: p.coin })}>✎</button>
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="btn small" onClick={() => { const r = e.closePosition(p.coin); if (!r.ok) s.toast('reject', r.error!); }}>Market</button>
                  <button className="btn small" onClick={() => setModal({ kind: 'limit', coin: p.coin })}>Limit</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {modal?.kind === 'tpsl' && <TpslModal coin={modal.coin} onClose={() => setModal(null)} />}
      {modal?.kind === 'margin' && <MarginModal coin={modal.coin} onClose={() => setModal(null)} />}
      {modal?.kind === 'limit' && <LimitCloseModal coin={modal.coin} onClose={() => setModal(null)} />}
    </>
  );
}

function orderType(o: Order) {
  if (o.trigger) {
    const base = o.trigger.tpsl === 'tp' ? 'Take Profit' : 'Stop';
    return `${base} ${o.trigger.isMarket ? 'Market' : 'Limit'}`;
  }
  if (o.kind === 'market') return 'Market';
  return `Limit${o.tif !== 'Gtc' ? ` (${o.tif})` : ''}`;
}

function OpenOrders({ filter }: { filter: string | null }) {
  const s = useStore();
  const e = s.engine;
  const os = e.state.orders.filter((o) => (o.status === 'open' || o.status === 'pending') && (!filter || o.coin === filter));
  if (!os.length) return <div className="empty">No open orders</div>;
  return (
    <table className="table">
      <thead><tr><th>Time</th><th>Type</th><th>Coin</th><th>Direction</th><th>Size</th><th>Original Size</th><th>Price</th><th>Trigger</th><th>Queue Ahead</th><th>Reduce Only</th><th><button className="btn small" onClick={() => e.cancelAll(filter ?? undefined)}>Cancel All</button></th></tr></thead>
      <tbody>
        {os.map((o) => {
          const a = e.asset(o.coin);
          return (
            <tr key={o.oid}>
              <td>{fmtDateTime(o.createdAt)}</td>
              <td>{orderType(o)}{o.status === 'pending' && <span className="faint"> (sending…)</span>}</td>
              <td>{s.display(o.coin)}</td>
              <td className={o.side === 'B' ? 'up' : 'down'}>{a.spot ? (o.side === 'B' ? 'Buy' : 'Sell') : o.side === 'B' ? (o.reduceOnly ? 'Close Short' : 'Long') : (o.reduceOnly ? 'Close Long' : 'Short')}</td>
              <td>{o.trigger?.positionTpsl ? 'Position' : fmtSz(o.sz, a.szDecimals)}</td>
              <td>{o.trigger?.positionTpsl ? '--' : fmtSz(o.origSz, a.szDecimals)}</td>
              <td>{o.kind === 'market' || o.trigger?.isMarket ? 'Market' : fmtPx(o.px, a.szDecimals, !!a.spot)}</td>
              <td>{o.trigger ? `${o.side === 'A' ? (o.trigger.tpsl === 'sl' ? '≤' : '≥') : (o.trigger.tpsl === 'sl' ? '≥' : '≤')} ${fmtPx(o.trigger.triggerPx, a.szDecimals, !!a.spot)}` : 'N/A'}</td>
              <td title="Simulated size resting ahead of you at this price">{o.kind === 'limit' && o.status === 'open' ? (Number.isFinite(o.queueAhead) ? fmtSz(o.queueAhead, a.szDecimals) : 'beyond visible book') : '--'}</td>
              <td>{o.reduceOnly ? 'Yes' : 'No'}</td>
              <td><button className="btn small" onClick={() => e.cancelOrder(o.oid)}>Cancel</button></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Fills({ filter }: { filter: string | null }) {
  const s = useStore();
  const e = s.engine;
  const fs = e.state.fills.filter((f) => !filter || f.coin === filter).slice(0, 300);
  if (!fs.length) return <div className="empty">No trades yet</div>;
  return (
    <table className="table">
      <thead><tr><th>Time</th><th>Coin</th><th>Direction</th><th>Price</th><th>Size</th><th>Trade Value</th><th>Fee</th><th>Liquidity</th><th>Closed PnL</th></tr></thead>
      <tbody>
        {fs.map((f) => {
          const a = e.assets.get(f.coin);
          return (
            <tr key={f.id}>
              <td>{fmtDateTime(f.time)}</td>
              <td>{f.label ?? f.coin}{f.twapId ? <span className="faint"> TWAP</span> : null}</td>
              <td className={f.side === 'B' ? 'up' : 'down'}>{f.liquidation ? 'Liquidation: ' : ''}{f.dir}</td>
              <td>{fmtPx(f.px, a?.szDecimals ?? 2, !!f.spot)}</td>
              <td>{fmtSz(f.sz, a?.szDecimals ?? 4)}</td>
              <td>{fmtUsd(f.px * f.sz)}</td>
              <td>{fmtUsd(f.fee, 4)}</td>
              <td className="muted">{f.liquidity === 'maker' ? 'Maker' : 'Taker'}</td>
              <td className={pnlClass(f.closedPnl)}>{f.closedPnl ? fmtSigned(f.closedPnl - f.fee) : '--'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Funding({ filter }: { filter: string | null }) {
  const s = useStore();
  const fs = s.engine.state.funding.filter((f) => !filter || f.coin === filter).slice(0, 300);
  if (!fs.length) return <div className="empty">No funding payments yet. Funding settles every hour on the hour.</div>;
  return (
    <table className="table">
      <thead><tr><th>Time</th><th>Coin</th><th>Size</th><th>Position Side</th><th>Payment</th><th>Rate</th></tr></thead>
      <tbody>
        {fs.map((f, i) => (
          <tr key={i}>
            <td>{fmtDateTime(f.time)}</td>
            <td>{f.coin}</td>
            <td>{Math.abs(f.szi)}</td>
            <td className={f.szi > 0 ? 'up' : 'down'}>{f.szi > 0 ? 'Long' : 'Short'}</td>
            <td className={pnlClass(f.payment)}>{fmtSigned(f.payment, 4)}</td>
            <td>{(f.rate * 100).toFixed(4)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function History({ filter }: { filter: string | null }) {
  const s = useStore();
  const e = s.engine;
  const hs = e.state.history.filter((h) => !filter || h.order.coin === filter).slice(-300).reverse();
  if (!hs.length) return <div className="empty">No order history</div>;
  return (
    <table className="table">
      <thead><tr><th>Time</th><th>Type</th><th>Coin</th><th>Direction</th><th>Size</th><th>Filled</th><th>Price</th><th>Status</th></tr></thead>
      <tbody>
        {hs.map((h, i) => {
          const o = h.order;
          const a = e.assets.get(o.coin);
          return (
            <tr key={i}>
              <td>{fmtDateTime(h.time)}</td>
              <td>{orderType(o)}</td>
              <td>{s.display(o.coin)}</td>
              <td className={o.side === 'B' ? 'up' : 'down'}>{o.side === 'B' ? 'Buy' : 'Sell'}</td>
              <td>{o.trigger?.positionTpsl ? 'Position' : fmtSz(o.origSz, a?.szDecimals ?? 4)}</td>
              <td>{fmtSz(o.origSz - o.sz, a?.szDecimals ?? 4)}</td>
              <td>{o.kind === 'market' ? 'Market' : fmtPx(o.px || o.trigger?.triggerPx, a?.szDecimals ?? 2, !!a?.spot)}</td>
              <td className={o.status === 'rejected' ? 'warn' : 'muted'}>{o.status}{o.statusMsg && o.statusMsg.toLowerCase() !== o.status ? ` — ${o.statusMsg}` : ''}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Balances() {
  const s = useStore();
  const e = s.engine;
  const sum = e.summary();
  const tokens = Object.entries(e.state.spot).sort((a, b) => b[1] * e.tokenPx(b[0]) - a[1] * e.tokenPx(a[0]));
  const pairFor = (token: string) => s.markets.find((m) => m.spot?.base === token && m.spot.quote === 'USDC');
  const [tpslFor, setTpslFor] = useState<string | null>(null);
  const triggersFor = (pairCoin: string) => e.state.orders.filter((o) => o.coin === pairCoin && o.kind === 'trigger' && o.side === 'A' && o.status === 'open');
  return (
    <table className="table">
      <thead><tr><th>Coin</th><th>Total Balance</th><th>Available Balance</th><th>USDC Value</th><th>Avg Cost</th><th>PnL (ROE %)</th><th>TP / SL</th><th></th></tr></thead>
      <tbody>
        <tr>
          <td>USDC <span className="faint">(Perps)</span></td>
          <td>{fmtNum(sum.perpEquity, 2)} USDC</td>
          <td>{fmtNum(sum.available, 2)} USDC</td>
          <td>{fmtUsd(sum.perpEquity)}</td>
          <td>--</td><td>--</td><td>--</td><td />
        </tr>
        {tokens.map(([t, amt]) => {
          const px = e.tokenPx(t);
          const cb = e.state.spotCost[t];
          const avg = cb && cb.sz > 0 ? cb.cost / cb.sz : 0;
          const pnl = avg ? (px - avg) * amt : 0;
          const pair = pairFor(t);
          return (
            <tr key={t}>
              <td>{t} <span className="faint">(Spot)</span></td>
              <td>{fmtNum(amt, 8)} {t}</td>
              <td>{fmtNum(e.spotAvailable(t), 8)} {t}</td>
              <td>{px ? fmtUsd(amt * px) : '—'}</td>
              <td>{avg ? fmtPx(avg, pair?.szDecimals ?? 2, true) : '--'}</td>
              <td className={pnlClass(pnl)}>{avg ? `${fmtSigned(pnl)} (${((px / avg - 1) * 100).toFixed(1)}%)` : '--'}</td>
              <td>
                {pair ? (() => {
                  const trg = triggersFor(pair.coin);
                  const tp = trg.find((o) => o.trigger?.tpsl === 'tp')?.trigger?.triggerPx;
                  const sl = trg.find((o) => o.trigger?.tpsl === 'sl')?.trigger?.triggerPx;
                  return (
                    <>
                      <span className="num">{tp ? fmtPx(tp, pair.szDecimals, true) : '--'} / {sl ? fmtPx(sl, pair.szDecimals, true) : '--'}</span>
                      <button className="btn small" style={{ marginLeft: 6 }} aria-label={`Set ${t} TP/SL`} onClick={() => setTpslFor(pair.coin)}>✎</button>
                    </>
                  );
                })() : '--'}
              </td>
              <td>{pair && <button className="btn small" onClick={() => s.setCoin(pair.coin)}>Trade</button>}</td>
            </tr>
          );
        })}
        {tpslFor && <tr><td colSpan={8} style={{ padding: 0, border: 0 }}><SpotTpslModal coin={tpslFor} onClose={() => setTpslFor(null)} /></td></tr>}
        {!tokens.length && <tr><td colSpan={8} className="muted">No spot balances. Use “Transfer Perps ⇄ Spot” to fund your spot account.</td></tr>}
      </tbody>
    </table>
  );
}

function Twaps({ filter }: { filter: string | null }) {
  const s = useStore();
  const e = s.engine;
  const ts = e.state.twaps.filter((t) => !filter || t.coin === filter).slice(0, 200);
  if (!ts.length) return <div className="empty">No TWAP orders. Pick “TWAP” under Pro in the order form.</div>;
  return (
    <table className="table">
      <thead><tr><th>Started</th><th>Coin</th><th>Side</th><th>Size</th><th>Executed</th><th>Avg Price</th><th>Running Time / Total</th><th>Reduce Only</th><th>Randomize</th><th>Status</th><th></th></tr></thead>
      <tbody>
        {ts.map((t) => {
          const a = e.assets.get(t.coin);
          const szD = a?.szDecimals ?? 4;
          const end = t.endedAt ?? Date.now();
          const ran = Math.min(t.durationMs, end - t.startedAt);
          const mins = (ms: number) => `${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
          return (
            <tr key={t.id}>
              <td>{fmtDateTime(t.startedAt)}</td>
              <td>{s.display(t.coin)}</td>
              <td className={t.side === 'B' ? 'up' : 'down'}>{t.side === 'B' ? 'Buy' : 'Sell'}</td>
              <td>{fmtSz(t.totalSz, szD)}</td>
              <td>{fmtSz(t.filledSz, szD)} ({((t.filledSz / t.totalSz) * 100).toFixed(0)}%)</td>
              <td>{t.filledSz ? fmtPx(t.notional / t.filledSz, szD, !!a?.spot) : '--'}</td>
              <td>{mins(ran)} / {mins(t.durationMs)}</td>
              <td>{t.reduceOnly ? 'Yes' : 'No'}</td>
              <td>{t.randomize ? 'Yes' : 'No'}</td>
              <td className={t.status === 'running' ? 'up' : 'muted'}>{t.status}{t.lastMsg ? <span className="warn"> — {t.lastMsg}</span> : null}</td>
              <td>{t.status === 'running' && <button className="btn small" onClick={() => e.cancelTwap(t.id)}>Cancel</button>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
