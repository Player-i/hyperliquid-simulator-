import { useState, type ReactNode } from 'react';
import type { MarginMode, Side } from '../engine/engine';
import { useStore } from '../store';
import { fmtPx, fmtUsd } from './format';

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
