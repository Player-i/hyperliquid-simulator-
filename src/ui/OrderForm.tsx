import { useEffect, useState } from 'react';
import type { Side, Tif } from '../engine/engine';
import { MIN_ORDER_NOTIONAL, roundPrice, roundSize } from '../engine/rules';
import { useStore } from '../store';
import { fmtPx, fmtUsd } from './format';
import { bookClick } from './OrderBook';
import { LeverageModal } from './Modals';

type OType = 'market' | 'limit' | 'stop-market' | 'stop-limit' | 'tp-market' | 'tp-limit';

const TYPE_LABEL: Record<OType, string> = {
  market: 'Market', limit: 'Limit', 'stop-market': 'Stop Market', 'stop-limit': 'Stop Limit', 'tp-market': 'Take Profit Market', 'tp-limit': 'Take Profit Limit',
};

export function OrderForm() {
  const s = useStore();
  const e = s.engine;
  const coin = s.prefs.coin;
  const m = s.marketsByCoin.get(coin);
  const [side, setSide] = useState<Side>('B');
  const [type, setType] = useState<OType>('market');
  const [pxStr, setPxStr] = useState('');
  const [trigStr, setTrigStr] = useState('');
  const [szStr, setSzStr] = useState('');
  const [unit, setUnit] = useState<'coin' | 'usd'>('usd');
  const [pct, setPct] = useState(0);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tif, setTif] = useState<Tif>('Gtc');
  const [tpsl, setTpsl] = useState(false);
  const [tpStr, setTpStr] = useState('');
  const [slStr, setSlStr] = useState('');
  const [levOpen, setLevOpen] = useState(false);

  useEffect(() => { setPxStr(''); setTrigStr(''); setSzStr(''); setPct(0); setTpStr(''); setSlStr(''); }, [coin]);
  useEffect(() => {
    bookClick.setPrice = (px) => { setPxStr(String(px)); if (type === 'market') setType('limit'); };
  }, [type]);

  if (!m) return <div className="empty">Loading markets…</div>;
  const szD = m.szDecimals;
  const book = e.books.get(coin);
  const mid = e.midPx(coin);
  const ls = e.levSetting(coin);
  const pos = e.state.positions[coin];
  const sum = e.summary();
  const isTrigger = type.startsWith('stop') || type.startsWith('tp');
  const needsLimitPx = type === 'limit' || type.endsWith('-limit');
  const limitPx = Number(pxStr) || 0;
  const triggerPx = Number(trigStr) || 0;
  const refPx = needsLimitPx ? limitPx || mid : isTrigger ? triggerPx || mid : side === 'B' ? book?.asks[0]?.px ?? mid : book?.bids[0]?.px ?? mid;

  // max size: available margin * leverage, plus whatever closes an opposite position
  const opp = pos && Math.sign(pos.szi) === (side === 'B' ? -1 : 1) ? Math.abs(pos.szi) : 0;
  const maxSz = reduceOnly ? opp : roundSize((sum.available * ls.leverage) / (refPx * (1 + e.state.settings.takerFee * ls.leverage)) + opp, szD);

  const sz = (() => {
    const v = Number(szStr) || 0;
    return roundSize(unit === 'usd' ? (refPx ? v / refPx : 0) : v, szD);
  })();
  const notional = sz * refPx;
  const incSz = Math.max(0, sz - opp);
  const marginReq = (incSz * refPx) / ls.leverage;
  const est = type === 'market' && sz > 0 ? e.estimateTaker(coin, side, sz) : null;
  const feeRate = type === 'market' || (type === 'limit' && tif === 'Ioc') ? e.state.settings.takerFee : e.state.settings.makerFee;

  // estimated liquidation price of the resulting position
  let estLiq: number | null = null;
  if (sz > 0 && !reduceOnly && refPx) {
    const sign = side === 'B' ? 1 : -1;
    const curSz = pos?.szi ?? 0;
    const newSz = curSz + sign * sz;
    if (Math.abs(newSz) > 1e-12) {
      const entry = Math.sign(newSz) === Math.sign(curSz) && curSz !== 0 && Math.abs(newSz) > Math.abs(curSz)
        ? (Math.abs(curSz) * pos!.entryPx + sz * (est?.avgPx ?? refPx)) / Math.abs(newSz)
        : Math.sign(newSz) === Math.sign(curSz) ? pos!.entryPx : est?.avgPx ?? refPx;
      const absSz = Math.abs(newSz), ss = Math.sign(newSz);
      const l = e.mmr(coin, absSz * refPx);
      let av: number;
      if (ls.mode === 'isolated') av = (absSz * entry) / ls.leverage + absSz * ss * (refPx - entry);
      else {
        const otherMaint = sum.crossMaint - (pos && pos.mode === 'cross' ? e.positionMaint(pos) : 0);
        const otherUpnl = sum.crossAccountValue - sum.cash - (pos && pos.mode === 'cross' ? e.upnl(pos) : 0);
        av = sum.cash + otherUpnl - otherMaint + ss * absSz * (refPx - entry) - notional * feeRate;
      }
      const p = (refPx - (ss * av) / absSz) / (1 - ss * l);
      estLiq = p > 0 ? p : null;
    }
  }

  const setFromPct = (p: number) => {
    setPct(p);
    const target = roundSize((maxSz * p) / 100, szD);
    setSzStr(unit === 'usd' ? (target * refPx).toFixed(2) : String(target));
  };

  const submit = () => {
    const base = { coin, side, sz, reduceOnly };
    let r;
    if (type === 'market') r = e.placeOrder({ ...base, kind: 'market' });
    else if (type === 'limit') r = e.placeOrder({ ...base, kind: 'limit', px: limitPx, tif });
    else {
      // trigger orders: tp/sl relative to the direction of the order
      const tpslKind = type.startsWith('tp') ? 'tp' : 'sl';
      r = e.placeOrder({
        ...base, kind: 'trigger', px: needsLimitPx ? limitPx : 0,
        trigger: { triggerPx, isMarket: !needsLimitPx, tpsl: tpslKind },
      });
    }
    if (!r.ok) { s.toast('reject', r.error ?? 'Rejected'); return; }
    if (tpsl && !isTrigger && !reduceOnly) {
      const exit: Side = side === 'B' ? 'A' : 'B';
      const tp = Number(tpStr), sl = Number(slStr);
      if (tp > 0) e.placeOrder({ coin, side: exit, kind: 'trigger', sz, trigger: { triggerPx: tp, isMarket: true, tpsl: 'tp', positionTpsl: true } });
      if (sl > 0) e.placeOrder({ coin, side: exit, kind: 'trigger', sz, trigger: { triggerPx: sl, isMarket: true, tpsl: 'sl', positionTpsl: true } });
    }
    setSzStr('');
    setPct(0);
  };

  let error: string | null = null;
  if (sz > 0 && !reduceOnly && notional < MIN_ORDER_NOTIONAL) error = `Minimum order value is $${MIN_ORDER_NOTIONAL}`;
  if (needsLimitPx && !limitPx) error = 'Enter a price';
  if (isTrigger && !triggerPx) error = 'Enter a trigger price';
  if (!reduceOnly && marginReq > sum.available + 1e-9 && sz > 0) error = 'Insufficient margin';
  if (reduceOnly && !opp) error = 'No position to reduce';

  return (
    <div className="form">
      <div className="row2" style={{ display: 'flex', gap: 8 }}>
        <button className="btn" style={{ flex: 1 }} onClick={() => setLevOpen(true)}>{ls.mode === 'cross' ? 'Cross' : 'Isolated'}</button>
        <button className="btn" style={{ flex: 1 }} onClick={() => setLevOpen(true)}>{ls.leverage}x</button>
      </div>
      <div className="seg">
        {(['market', 'limit'] as OType[]).map((t) => (
          <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>{TYPE_LABEL[t]}</button>
        ))}
        <select
          className={isTrigger ? 'active' : ''}
          style={{ background: isTrigger ? 'var(--bg)' : 'none', border: 0, borderRadius: 6, color: isTrigger ? 'var(--text)' : 'var(--muted)', textAlign: 'center' }}
          value={isTrigger ? type : ''}
          onChange={(ev) => setType(ev.target.value as OType)}
        >
          <option value="" disabled>Pro</option>
          {(['stop-market', 'stop-limit', 'tp-market', 'tp-limit'] as OType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div className="seg">
        <button className={`buy ${side === 'B' ? 'active' : ''}`} onClick={() => setSide('B')}>Buy / Long</button>
        <button className={`sell ${side === 'A' ? 'active' : ''}`} onClick={() => setSide('A')}>Sell / Short</button>
      </div>

      <div className="kv"><span>Available to Trade</span><span className="v num">{fmtUsd(sum.available)}</span></div>
      <div className="kv"><span>Current Position</span><span className={`v num ${pos ? (pos.szi > 0 ? 'up' : 'down') : ''}`}>{pos ? `${pos.szi.toFixed(szD)} ${coin}` : `0 ${coin}`}</span></div>

      {isTrigger && (
        <div className="field">
          <label>Trigger Price</label>
          <input inputMode="decimal" value={trigStr} onChange={(ev) => setTrigStr(ev.target.value)} placeholder={fmtPx(e.markPx(coin), szD)} />
          <span className="unit">USD</span>
        </div>
      )}
      {needsLimitPx && (
        <div className="field">
          <label>Price</label>
          <input inputMode="decimal" value={pxStr} onChange={(ev) => setPxStr(ev.target.value)} onBlur={() => limitPx && setPxStr(String(roundPrice(limitPx, szD)))} />
          <button className="btn small" onClick={() => setPxStr(String(roundPrice(mid, szD)))}>Mid</button>
        </div>
      )}
      <div className="field">
        <label>Size</label>
        <input inputMode="decimal" value={szStr} onChange={(ev) => { setSzStr(ev.target.value); setPct(0); }} placeholder="0" />
        <select value={unit} onChange={(ev) => { setUnit(ev.target.value as 'coin' | 'usd'); setSzStr(''); setPct(0); }}>
          <option value="usd">USD</option>
          <option value="coin">{coin}</option>
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input className="slider" type="range" min={0} max={100} value={pct} onChange={(ev) => setFromPct(Number(ev.target.value))} />
        <span className="num muted" style={{ width: 36, textAlign: 'right' }}>{pct}%</span>
      </div>
      {unit === 'usd' && sz > 0 && <div className="kv"><span>Size in {coin}</span><span className="v num">{sz.toFixed(szD)}</span></div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label className="check"><input type="checkbox" checked={reduceOnly} onChange={(ev) => setReduceOnly(ev.target.checked)} /> Reduce Only</label>
        {type === 'limit' && (
          <select className="btn small" value={tif} onChange={(ev) => setTif(ev.target.value as Tif)}>
            <option value="Gtc">GTC</option>
            <option value="Alo">ALO (Post only)</option>
            <option value="Ioc">IOC</option>
          </select>
        )}
      </div>
      {!isTrigger && !reduceOnly && (
        <label className="check"><input type="checkbox" checked={tpsl} onChange={(ev) => setTpsl(ev.target.checked)} /> Take Profit / Stop Loss</label>
      )}
      {tpsl && !isTrigger && !reduceOnly && (
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}><label>TP</label><input inputMode="decimal" value={tpStr} onChange={(ev) => setTpStr(ev.target.value)} /></div>
          <div className="field" style={{ flex: 1 }}><label>SL</label><input inputMode="decimal" value={slStr} onChange={(ev) => setSlStr(ev.target.value)} /></div>
        </div>
      )}

      <button className={`submit ${side === 'B' ? 'buy' : 'sell'}`} disabled={!sz || !!error} onClick={submit}>
        {error && sz ? error : `${side === 'B' ? 'Buy / Long' : 'Sell / Short'}${type !== 'market' ? ` (${TYPE_LABEL[type]})` : ''}`}
      </button>

      <div className="kv"><span>Liquidation Price</span><span className="v num warn">{estLiq ? fmtPx(estLiq, szD) : 'N/A'}</span></div>
      <div className="kv"><span>Order Value</span><span className="v num">{sz ? fmtUsd(notional) : 'N/A'}</span></div>
      <div className="kv"><span>Margin Required</span><span className="v num">{sz ? fmtUsd(marginReq) : 'N/A'}</span></div>
      {type === 'market' && (
        <div className="kv"><span>Est. Slippage</span><span className="v num">{est ? `${(est.slippage * 100).toFixed(4)}%${est.filled < sz ? ' (book too thin!)' : ''}` : 'N/A'}</span></div>
      )}
      {type === 'market' && est && <div className="kv"><span>Est. Avg Fill</span><span className="v num">{fmtPx(est.avgPx, szD)}</span></div>}
      <div className="kv"><span>Fees</span><span className="v num">{(e.state.settings.takerFee * 100).toFixed(4)}% / {(e.state.settings.makerFee * 100).toFixed(4)}%</span></div>

      <div className="divider" />
      <Account />
      {levOpen && <LeverageModal coin={coin} onClose={() => setLevOpen(false)} />}
    </div>
  );
}

function Account() {
  const s = useStore();
  const sum = s.engine.summary();
  return (
    <div className="acct" style={{ padding: 0 }}>
      <div className="sectiontitle">Account Equity</div>
      <div className="kv"><span>Equity</span><span className="v num">{fmtUsd(sum.equity)}</span></div>
      <div className="kv"><span>Balance (USDC)</span><span className="v num">{fmtUsd(sum.cash)}</span></div>
      <div className="kv"><span>Unrealized PnL</span><span className={`v num ${sum.upnl >= 0 ? 'up' : 'down'}`}>{fmtUsd(sum.upnl)}</span></div>
      <div className="kv"><span>PnL Since Start</span><span className={`v num ${sum.pnlSinceStart >= 0 ? 'up' : 'down'}`}>{fmtUsd(sum.pnlSinceStart)}</span></div>
      <div className="sectiontitle">Perps Overview</div>
      <div className="kv"><span>Cross Margin Ratio</span><span className={`v num ${sum.crossMarginRatio > 0.7 ? 'down' : ''}`}>{(sum.crossMarginRatio * 100).toFixed(2)}%</span></div>
      <div className="kv"><span>Maintenance Margin</span><span className="v num">{fmtUsd(sum.crossMaint)}</span></div>
      <div className="kv"><span>Cross Account Leverage</span><span className="v num">{sum.accountLeverage.toFixed(2)}x</span></div>
    </div>
  );
}
