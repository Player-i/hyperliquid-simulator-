import { useState, type ReactNode } from 'react';
import type { MarginMode, Side } from '../engine/engine';
import type { ReplayResult } from '../engine/replay';
import { useStore } from '../store';
import { fmtDateTime, fmtPx, fmtSigned, fmtUsd, pnlClass } from './format';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h3>{title}</h3>
          <button className="btn small" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function LeverageModal({ coin, onClose }: { coin: string; onClose: () => void }) {
  const s = useStore();
  const e = s.engine;
  const a = e.asset(coin);
  const cur = e.levSetting(coin);
  const [lev, setLev] = useState(cur.leverage);
  const [mode, setMode] = useState<MarginMode>(cur.mode);
  const apply = () => {
    const err = e.setLeverage(coin, lev, mode);
    if (err) s.toast('reject', err); else onClose();
  };
  return (
    <Modal title={`${coin} Margin & Leverage`} onClose={onClose}>
      <div className="seg">
        <button className={mode === 'cross' ? 'active' : ''} disabled={a.onlyIsolated} onClick={() => setMode('cross')}>Cross</button>
        <button className={mode === 'isolated' ? 'active' : ''} onClick={() => setMode('isolated')}>Isolated</button>
      </div>
      <div className="muted">
        {mode === 'cross'
          ? 'All cross positions share your account balance as collateral. A loss on one can liquidate all of them.'
          : 'Margin is locked to this position only. Liquidation only loses the isolated margin.'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input className="slider" type="range" min={1} max={a.maxLeverage} value={lev} onChange={(ev) => setLev(Number(ev.target.value))} />
        <div className="field" style={{ width: 80 }}><input value={lev} onChange={(ev) => setLev(Math.max(1, Math.min(a.maxLeverage, Number(ev.target.value) || 1)))} /><span className="unit">x</span></div>
      </div>
      <div className="muted">Max leverage {a.maxLeverage}x{a.tiers.length > 1 ? ` (tiers: ${a.tiers.map((t) => `${t.maxLeverage}x ≥ ${fmtUsd(t.lowerBound, 0)}`).join(', ')})` : ''}</div>
      <button className="btn primary" onClick={apply}>Confirm</button>
    </Modal>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const st = s.engine.state.settings;
  const [bal, setBal] = useState(String(st.startingBalance));
  const [taker, setTaker] = useState(String(st.takerFee * 100));
  const [maker, setMaker] = useState(String(st.makerFee * 100));
  const [lat, setLat] = useState(String(st.latencyMs));
  const [sTaker, setSTaker] = useState(String(st.spotTakerFee * 100));
  const [sMaker, setSMaker] = useState(String(st.spotMakerFee * 100));
  const [slip, setSlip] = useState(String(st.marketSlippage * 100));
  const parsed = () => ({
    takerFee: Number(taker) / 100, makerFee: Number(maker) / 100,
    spotTakerFee: Number(sTaker) / 100, spotMakerFee: Number(sMaker) / 100, latencyMs: Math.max(0, Number(lat) || 0),
    marketSlippage: Math.max(0.001, Number(slip) / 100), startingBalance: Math.max(1, Number(bal) || 10_000),
  });
  return (
    <Modal title="Simulator Settings" onClose={onClose}>
      <div className="field"><label>Taker fee</label><input value={taker} onChange={(e) => setTaker(e.target.value)} /><span className="unit">%</span></div>
      <div className="field"><label>Maker fee</label><input value={maker} onChange={(e) => setMaker(e.target.value)} /><span className="unit">%</span></div>
      <div className="field"><label>Spot taker fee</label><input value={sTaker} onChange={(e) => setSTaker(e.target.value)} /><span className="unit">%</span></div>
      <div className="field"><label>Spot maker fee</label><input value={sMaker} onChange={(e) => setSMaker(e.target.value)} /><span className="unit">%</span></div>
      <div className="muted">Hyperliquid base tier: perps 0.045% taker / 0.015% maker, spot 0.070% / 0.040%. Higher volume tiers are cheaper; set a negative maker fee for rebates.</div>
      <div className="field"><label>Network latency</label><input value={lat} onChange={(e) => setLat(e.target.value)} /><span className="unit">ms</span></div>
      <div className="field"><label>Market order max slippage</label><input value={slip} onChange={(e) => setSlip(e.target.value)} /><span className="unit">%</span></div>
      <button className="btn" onClick={() => { s.engine.updateSettings(parsed()); onClose(); }}>Save settings</button>
      <div className="divider" />
      <div className="field"><label>Starting balance</label><input value={bal} onChange={(e) => setBal(e.target.value)} /><span className="unit">USDC</span></div>
      <button className="btn danger" onClick={() => {
        if (confirm('Reset account? This clears all positions, orders and history.')) { s.engine.reset(parsed()); onClose(); }
      }}>Reset account</button>
    </Modal>
  );
}

export function fmtDuration(ms: number) {
  const m = Math.round(ms / 60_000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d}d`, h && `${h}h`, (mm || (!d && !h)) && `${mm}m`].filter(Boolean).join(' ');
}

/** summary of what the catch-up replay did while the app was closed */
export function AwayModal({ result, onClose }: { result: ReplayResult; onClose: () => void }) {
  const r = result;
  const net = r.realized - r.fees + r.fundingNet;
  const interesting = r.events.filter((x) => x.type !== 'reject' || !/No order book/.test(x.msg));
  return (
    <Modal title={`While you were away (${fmtDuration(r.to - r.from)})`} onClose={onClose}>
      <div className="muted">
        Replayed Hyperliquid's {r.intervalMs >= 3_600_000 ? `${r.intervalMs / 3_600_000}h` : `${r.intervalMs / 60_000}m`} price history from {fmtDateTime(r.from)} to {fmtDateTime(r.to)} against your orders and positions.
      </div>
      <div className="kv"><span>Equity</span><span className="v num">{fmtUsd(r.equityBefore)} → {fmtUsd(r.equityAfter)}</span></div>
      <div className="kv"><span>Fills</span><span className="v num">{r.fills}</span></div>
      <div className="kv"><span>Realized PnL</span><span className={`v num ${pnlClass(r.realized)}`}>{fmtSigned(r.realized)}</span></div>
      <div className="kv"><span>Fees</span><span className="v num">{fmtUsd(-r.fees)}</span></div>
      <div className="kv"><span>Funding ({r.fundingCount} payments)</span><span className={`v num ${pnlClass(r.fundingNet)}`}>{fmtSigned(r.fundingNet)}</span></div>
      <div className="kv"><span>Net</span><span className={`v num ${pnlClass(net)}`}><b>{fmtSigned(net)}</b></span></div>
      {interesting.length > 0 ? (
        <div className="tablewrap" style={{ maxHeight: 260, border: '1px solid var(--border)', borderRadius: 6 }}>
          <table className="table">
            <tbody>
              {interesting.map((x, i) => (
                <tr key={i}>
                  <td className="faint">{fmtDateTime(x.time)}</td>
                  <td className={x.type === 'liquidation' ? 'down' : x.type === 'reject' ? 'warn' : ''} style={{ whiteSpace: 'normal' }}>{x.msg}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="muted">None of your orders triggered or filled.</div>}
      {r.missing.length > 0 && <div className="warn">No price history was available for: {r.missing.join(', ')}. Those were not replayed.</div>}
      <div className="faint">Limit orders fill only if the price traded through them. TP/SL and stops fire at the first minute the price crossed them; if a TP and SL fall in the same candle, the stop is assumed to hit first. Liquidations use candle closes.</div>
      <button className="btn primary" onClick={onClose}>Got it</button>
    </Modal>
  );
}

export function TransferModal({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const e = s.engine;
  const [toSpot, setToSpot] = useState(true);
  const [amt, setAmt] = useState('');
  const max = toSpot ? e.summary().available : e.spotAvailable('USDC');
  const apply = () => {
    const err = e.transfer(Number(amt) || 0, toSpot);
    if (err) s.toast('reject', err);
    else { s.toast('info', `Transferred $${Number(amt).toFixed(2)} to ${toSpot ? 'Spot' : 'Perps'}`); onClose(); }
  };
  return (
    <Modal title="Transfer USDC" onClose={onClose}>
      <div className="muted">Like on Hyperliquid, perps and spot are separate balances. Move USDC between them here.</div>
      <div className="seg">
        <button className={toSpot ? 'active' : ''} onClick={() => setToSpot(true)}>Perps → Spot</button>
        <button className={!toSpot ? 'active' : ''} onClick={() => setToSpot(false)}>Spot → Perps</button>
      </div>
      <div className="field">
        <label>Amount</label>
        <input inputMode="decimal" value={amt} onChange={(ev) => setAmt(ev.target.value)} placeholder="0.00" />
        <button className="btn small" onClick={() => setAmt(String(Math.floor(max * 100) / 100))}>Max</button>
      </div>
      <div className="kv"><span>Available</span><span className="v num">{fmtUsd(max)}</span></div>
      <button className="btn primary" onClick={apply}>Transfer</button>
    </Modal>
  );
}

/** TP/SL for a spot holding: sell triggers on the token's USDC pair */
export function SpotTpslModal({ coin, onClose }: { coin: string; onClose: () => void }) {
  const s = useStore();
  const e = s.engine;
  const a = e.asset(coin);
  const base = a.spot!.base;
  const held = e.state.spot[base] ?? 0;
  const cb = e.state.spotCost[base];
  const avg = cb && cb.sz > 0 ? cb.cost / cb.sz : 0;
  const existing = e.state.orders.filter((o) => o.coin === coin && o.kind === 'trigger' && o.side === 'A' && (o.status === 'open' || o.status === 'pending'));
  const [tp, setTp] = useState(String(existing.find((o) => o.trigger?.tpsl === 'tp')?.trigger?.triggerPx ?? ''));
  const [sl, setSl] = useState(String(existing.find((o) => o.trigger?.tpsl === 'sl')?.trigger?.triggerPx ?? ''));
  const [pct, setPct] = useState(100);
  const sz = Math.floor(held * (pct / 100) * 10 ** a.szDecimals) / 10 ** a.szDecimals;
  const mark = e.markPx(coin);
  const pnlAt = (px: number) => (avg ? (px - avg) * sz : 0);
  const apply = () => {
    const tpN = Number(tp), slN = Number(sl);
    if (tpN && tpN <= mark) return s.toast('reject', 'TP must be above the current price');
    if (slN && slN >= mark) return s.toast('reject', 'SL must be below the current price');
    for (const o of existing) e.cancelOrder(o.oid);
    for (const [px, kind] of [[tpN, 'tp'], [slN, 'sl']] as const) {
      if (!px) continue;
      const r = e.placeOrder({ coin, side: 'A', kind: 'trigger', sz, trigger: { triggerPx: px, isMarket: true, tpsl: kind } });
      if (!r.ok) s.toast('reject', `${kind.toUpperCase()}: ${r.error}`);
    }
    onClose();
  };
  return (
    <Modal title={`${base} TP/SL`} onClose={onClose}>
      <div className="kv"><span>Holding</span><span className="v num">{held} {base}</span></div>
      <div className="kv"><span>Average cost</span><span className="v num">{avg ? fmtPx(avg, a.szDecimals, true) : '—'}</span></div>
      <div className="kv"><span>Current price ({a.spot!.name})</span><span className="v num">{fmtPx(mark, a.szDecimals, true)}</span></div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="slider" type="range" min={1} max={100} value={pct} onChange={(ev) => setPct(Number(ev.target.value))} aria-label="Amount percent" />
        <span className="num">{pct}%</span>
      </div>
      <div className="kv"><span>Amount to sell</span><span className="v num">{sz} {base}</span></div>
      <div className="field"><label>TP Price</label><input value={tp} onChange={(ev) => setTp(ev.target.value)} /></div>
      {Number(tp) > 0 && avg > 0 && <div className="kv"><span>PnL at TP</span><span className="v num">{fmtUsd(pnlAt(Number(tp)))}</span></div>}
      <div className="field"><label>SL Price</label><input value={sl} onChange={(ev) => setSl(ev.target.value)} /></div>
      {Number(sl) > 0 && avg > 0 && <div className="kv"><span>PnL at SL</span><span className="v num">{fmtUsd(pnlAt(Number(sl)))}</span></div>}
      <div className="muted">Triggers on the spot mark price and sells as a market order (10% max slippage). If your {base} balance is fully sold, the other trigger is canceled.</div>
      <button className="btn primary" onClick={apply} disabled={!sz}>Confirm</button>
    </Modal>
  );
}

export function TpslModal({ coin, onClose }: { coin: string; onClose: () => void }) {
  const s = useStore();
  const e = s.engine;
  const p = e.state.positions[coin];
  const szD = e.asset(coin).szDecimals;
  const existing = e.state.orders.filter((o) => o.coin === coin && o.trigger?.positionTpsl && o.status === 'open');
  const [tp, setTp] = useState(String(existing.find((o) => o.trigger?.tpsl === 'tp')?.trigger?.triggerPx ?? ''));
  const [sl, setSl] = useState(String(existing.find((o) => o.trigger?.tpsl === 'sl')?.trigger?.triggerPx ?? ''));
  if (!p) return null;
  const exit: Side = p.szi > 0 ? 'A' : 'B';
  const pnlAt = (px: number) => p.szi * (px - p.entryPx);
  const apply = () => {
    for (const o of existing) e.cancelOrder(o.oid);
    const sz = Math.abs(p.szi);
    if (Number(tp) > 0) e.placeOrder({ coin, side: exit, kind: 'trigger', sz, trigger: { triggerPx: Number(tp), isMarket: true, tpsl: 'tp', positionTpsl: true } });
    if (Number(sl) > 0) e.placeOrder({ coin, side: exit, kind: 'trigger', sz, trigger: { triggerPx: Number(sl), isMarket: true, tpsl: 'sl', positionTpsl: true } });
    onClose();
  };
  return (
    <Modal title={`${coin} Position TP/SL`} onClose={onClose}>
      <div className="kv"><span>Entry</span><span className="v num">{fmtPx(p.entryPx, szD)}</span></div>
      <div className="kv"><span>Mark</span><span className="v num">{fmtPx(e.markPx(coin), szD)}</span></div>
      <div className="field"><label>TP Price</label><input value={tp} onChange={(ev) => setTp(ev.target.value)} /></div>
      {Number(tp) > 0 && <div className="kv"><span>Expected profit</span><span className="v num">{fmtUsd(pnlAt(Number(tp)))}</span></div>}
      <div className="field"><label>SL Price</label><input value={sl} onChange={(ev) => setSl(ev.target.value)} /></div>
      {Number(sl) > 0 && <div className="kv"><span>Expected loss</span><span className="v num">{fmtUsd(pnlAt(Number(sl)))}</span></div>}
      <div className="muted">Triggers on mark price and executes as a market order (10% max slippage) for the full position.</div>
      <button className="btn primary" onClick={apply}>Confirm</button>
    </Modal>
  );
}

export function MarginModal({ coin, onClose }: { coin: string; onClose: () => void }) {
  const s = useStore();
  const e = s.engine;
  const p = e.state.positions[coin];
  const [amt, setAmt] = useState('');
  const [add, setAdd] = useState(true);
  if (!p) return null;
  const apply = () => {
    const err = e.updateIsolatedMargin(coin, (add ? 1 : -1) * (Number(amt) || 0));
    if (err) s.toast('reject', err); else onClose();
  };
  return (
    <Modal title={`Adjust ${coin} isolated margin`} onClose={onClose}>
      <div className="seg">
        <button className={add ? 'active' : ''} onClick={() => setAdd(true)}>Add</button>
        <button className={!add ? 'active' : ''} onClick={() => setAdd(false)}>Remove</button>
      </div>
      <div className="kv"><span>Current margin</span><span className="v num">{fmtUsd(p.isoMargin)}</span></div>
      <div className="kv"><span>Available</span><span className="v num">{fmtUsd(e.summary().available)}</span></div>
      <div className="field"><label>Amount</label><input value={amt} onChange={(ev) => setAmt(ev.target.value)} /><span className="unit">USDC</span></div>
      <button className="btn primary" onClick={apply}>Confirm</button>
    </Modal>
  );
}

export function LimitCloseModal({ coin, onClose }: { coin: string; onClose: () => void }) {
  const s = useStore();
  const e = s.engine;
  const p = e.state.positions[coin];
  const szD = e.asset(coin).szDecimals;
  const [px, setPx] = useState(String(e.midPx(coin)));
  const [pct, setPct] = useState(100);
  if (!p) return null;
  const apply = () => {
    const r = e.closePosition(coin, pct / 100, Number(px));
    if (!r.ok) s.toast('reject', r.error ?? 'Rejected'); else onClose();
  };
  return (
    <Modal title={`Limit close ${coin}`} onClose={onClose}>
      <div className="field"><label>Price</label><input value={px} onChange={(ev) => setPx(ev.target.value)} /></div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input className="slider" type="range" min={1} max={100} value={pct} onChange={(ev) => setPct(Number(ev.target.value))} /><span className="num">{pct}%</span>
      </div>
      <div className="kv"><span>Size</span><span className="v num">{(Math.abs(p.szi) * pct / 100).toFixed(szD)} {coin}</span></div>
      <button className="btn primary" onClick={apply}>Place limit close</button>
    </Modal>
  );
}
