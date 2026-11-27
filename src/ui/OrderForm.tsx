import { useEffect, useState } from 'react';
import { TWAP_INTERVAL_MS, type Side, type Tif } from '../engine/engine';
import { MIN_ORDER_NOTIONAL, roundSize } from '../engine/rules';
import { useStore } from '../store';
import { fmtNum, fmtPx, fmtUsd } from './format';
import { bookClick } from './OrderBook';
import { LeverageModal, TransferModal } from './Modals';

type OType = 'market' | 'limit' | 'stop-market' | 'stop-limit' | 'tp-market' | 'tp-limit' | 'twap' | 'scale';

const TYPE_LABEL: Record<OType, string> = {
  market: 'Market', limit: 'Limit', 'stop-market': 'Stop Market', 'stop-limit': 'Stop Limit',
  'tp-market': 'Take Profit Market', 'tp-limit': 'Take Profit Limit', twap: 'TWAP', scale: 'Scale',
};
const PRO_TYPES: OType[] = ['scale', 'stop-market', 'stop-limit', 'tp-market', 'tp-limit', 'twap'];

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
  const [twapH, setTwapH] = useState('0');
  const [twapM, setTwapM] = useState('30');
  const [randomize, setRandomize] = useState(false);
  const [scStart, setScStart] = useState('');
  const [scEnd, setScEnd] = useState('');
  const [scN, setScN] = useState('10');
  const [scSkew, setScSkew] = useState('1');
  const [levOpen, setLevOpen] = useState(false);
  const [xferOpen, setXferOpen] = useState(false);
  const spot = m?.spot;

  useEffect(() => { setPxStr(''); setTrigStr(''); setSzStr(''); setPct(0); setTpStr(''); setSlStr(''); setScStart(''); setScEnd(''); }, [coin]);
  useEffect(() => { if (spot) setReduceOnly(false); }, [spot]);
  useEffect(() => {
    bookClick.setPrice = (px) => {
      if (type === 'scale') { if (!scStart) setScStart(String(px)); else setScEnd(String(px)); return; }
      setPxStr(String(px));
      if (type === 'market' || type === 'twap') setType('limit');
    };
  }, [type, scStart]);

  if (!m) return <div className="empty">Loading markets…</div>;
  const szD = m.szDecimals;
  const sp = !!spot;
  const book = e.books.get(coin);
  const mid = e.midPx(coin);
  const ls = e.levSetting(coin);
  const pos = sp ? undefined : e.state.positions[coin];
  const sum = e.summary();
  const isTwap = type === 'twap';
  const isScale = type === 'scale';
  const isTrigger = type.startsWith('stop') || type.startsWith('tp');
  const needsLimitPx = type === 'limit' || type.endsWith('-limit');
  const limitPx = Number(pxStr) || 0;
  const triggerPx = Number(trigStr) || 0;
  const scStartPx = Number(scStart) || 0, scEndPx = Number(scEnd) || 0;
  const scN_ = Math.floor(Number(scN) || 0), scSkew_ = Number(scSkew) || 0;
  const refPx = needsLimitPx ? limitPx || mid
    : isTrigger ? triggerPx || mid
    : isScale ? (scStartPx && scEndPx ? (scStartPx + scEndPx) / 2 : scStartPx || mid)
    : isTwap ? mid
    : side === 'B' ? book?.asks[0]?.px ?? mid : book?.bids[0]?.px ?? mid;
  const baseName = spot?.base ?? coin;
  const quoteName = spot?.quote ?? 'USD';
  const takerFee = sp ? e.state.settings.spotTakerFee : e.state.settings.takerFee;
  const makerFee = sp ? e.state.settings.spotMakerFee : e.state.settings.makerFee;

  // what you can trade right now
  let available: number; // in quote (buy) or USD margin
  let availLabel: string;
  let maxSz: number;
  const opp = pos && Math.sign(pos.szi) === (side === 'B' ? -1 : 1) ? Math.abs(pos.szi) : 0;
  if (sp) {
    if (side === 'B') {
      available = e.spotAvailable(spot!.quote);
      availLabel = `${fmtNum(available, 2)} ${spot!.quote}`;
      maxSz = refPx ? roundSize(available / refPx, szD) : 0;
    } else {
      available = e.spotAvailable(spot!.base);
      availLabel = `${fmtNum(available, szD)} ${spot!.base}`;
      maxSz = roundSize(available, szD);
    }
  } else {
    available = sum.available;
    availLabel = fmtUsd(available);
    maxSz = reduceOnly ? opp : roundSize((sum.available * ls.leverage) / (refPx * (1 + takerFee * ls.leverage)) + opp, szD);
  }

  const sz = (() => {
    const v = Number(szStr) || 0;
    return roundSize(unit === 'usd' ? (refPx ? v / refPx : 0) : v, szD);
  })();
  const ladder = isScale && sz > 0 ? e.scaleLadder(coin, sz, scStartPx, scEndPx, scN_, scSkew_) : [];
  const notional = isScale && ladder.length ? ladder.reduce((a, l) => a + l.px * l.sz, 0) : sz * refPx;
  const scaleAvg = ladder.length ? notional / sz : 0;
  // TP/SL attached to an entry: perps any side; spot only on buys (it sells what you bought)
  const canAttachTpsl = !isTrigger && !isTwap && !isScale && !reduceOnly && (!sp || side === 'B');
  const incSz = Math.max(0, sz - opp);
  const marginReq = sp ? 0 : (incSz * refPx) / ls.leverage;
  const est = (type === 'market' || isTwap) && sz > 0 ? e.estimateTaker(coin, side, isTwap ? sz / twapSlices() : sz) : null;
  const feeRate = type === 'market' || isTwap || (type === 'limit' && tif === 'Ioc') ? takerFee : makerFee;

  function twapSlices() {
    const mins = (Number(twapH) || 0) * 60 + (Number(twapM) || 0);
    return Math.max(1, (mins * 60_000) / TWAP_INTERVAL_MS);
  }
  const twapMinutes = (Number(twapH) || 0) * 60 + (Number(twapM) || 0);

  // estimated liquidation price of the resulting perp position
  let estLiq: number | null = null;
  if (!sp && sz > 0 && !reduceOnly && refPx) {
    const sign = side === 'B' ? 1 : -1;
    const curSz = pos?.szi ?? 0;
    const newSz = curSz + sign * sz;
    if (Math.abs(newSz) > 1e-12) {
      const fillPx = est?.avgPx ?? refPx;
      const entry = curSz !== 0 && Math.sign(newSz) === Math.sign(curSz)
        ? Math.abs(newSz) > Math.abs(curSz) ? (Math.abs(curSz) * pos!.entryPx + sz * fillPx) / Math.abs(newSz) : pos!.entryPx
        : fillPx;
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
    // TP/SL activate when the entry fills, sized to what was filled (spot: what you received)
    const attached = tpsl && canAttachTpsl ? { tp: Number(tpStr) || undefined, sl: Number(slStr) || undefined } : undefined;
    let r;
    if (isScale) r = e.placeScale({ coin, side, sz, startPx: scStartPx, endPx: scEndPx, n: scN_, skew: scSkew_, reduceOnly });
    else if (isTwap) r = e.placeTwap({ coin, side, sz, minutes: twapMinutes, randomize, reduceOnly });
    else if (type === 'market') r = e.placeOrder({ coin, side, sz, reduceOnly, kind: 'market', tpsl: attached });
    else if (type === 'limit') r = e.placeOrder({ coin, side, sz, reduceOnly, kind: 'limit', px: limitPx, tif, tpsl: attached });
    else {
      r = e.placeOrder({
        coin, side, sz, reduceOnly, kind: 'trigger', px: needsLimitPx ? limitPx : 0,
        trigger: { triggerPx, isMarket: !needsLimitPx, tpsl: type.startsWith('tp') ? 'tp' : 'sl' },
      });
    }
    if (!r.ok) { s.toast('reject', r.error ?? 'Rejected'); return; }
    setSzStr('');
    setPct(0);
  };

  let error: string | null = null;
  if (sz > 0 && !reduceOnly && notional < MIN_ORDER_NOTIONAL) error = `Minimum order value is $${MIN_ORDER_NOTIONAL}`;
  if (needsLimitPx && !limitPx) error = 'Enter a price';
  if (isTrigger && !triggerPx) error = 'Enter a trigger price';
  if (isTwap && (twapMinutes < 5 || twapMinutes > 1440)) error = 'Duration must be 5m – 24h';
  else if (isTwap && sz > 0 && !reduceOnly && notional / twapSlices() < MIN_ORDER_NOTIONAL) error = `Sub-orders must be ≥ $${MIN_ORDER_NOTIONAL}`;
  if (sp && sz > maxSz + 1e-12) error = `Insufficient ${side === 'B' ? quoteName : baseName}`;
  if (!sp && !reduceOnly && marginReq > sum.available + 1e-9 && sz > 0) error = 'Insufficient margin';
  if (reduceOnly && !opp) error = 'No position to reduce';
  if (isScale) {
    if (!scStartPx || !scEndPx) error = 'Enter start and end prices';
    else if (scN_ < 2 || scN_ > 100) error = 'Total orders must be 2 – 100';
    else if (!(scSkew_ >= 0.01 && scSkew_ <= 100)) error = 'Size skew must be 0.01 – 100';
    else if (sz > 0 && !reduceOnly && ladder.some((l) => l.px * l.sz < MIN_ORDER_NOTIONAL)) error = `Each order must be ≥ $${MIN_ORDER_NOTIONAL}`;
  }
  if (tpsl && canAttachTpsl) {
    const tp = Number(tpStr), sl = Number(slStr);
    const ref = type === 'limit' ? limitPx : mid;
    if (side === 'B' && ((tp && tp <= ref) || (sl && sl >= ref))) error = 'Long TP must be above and SL below entry';
    if (side === 'A' && ((tp && tp >= ref) || (sl && sl <= ref))) error = 'Short TP must be below and SL above entry';
  }

  const proTypes = PRO_TYPES;
  const isPro = proTypes.includes(type);
  const buyLabel = sp ? 'Buy' : 'Buy / Long';
  const sellLabel = sp ? 'Sell' : 'Sell / Short';

  return (
    <div className="form">
      {sp ? (
        <button className="btn" onClick={() => setXferOpen(true)}>Transfer USDC between Perps ⇄ Spot</button>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" style={{ flex: 1 }} onClick={() => setLevOpen(true)}>{ls.mode === 'cross' ? 'Cross' : 'Isolated'}</button>
          <button className="btn" style={{ flex: 1 }} onClick={() => setLevOpen(true)}>{ls.leverage}x</button>
        </div>
      )}
      <div className="seg">
        {(['market', 'limit'] as OType[]).map((t) => (
          <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>{TYPE_LABEL[t]}</button>
        ))}
        <select
          aria-label="Pro order types"
          style={{ background: isPro ? 'var(--bg)' : 'none', border: 0, borderRadius: 6, color: isPro ? 'var(--text)' : 'var(--muted)', textAlign: 'center' }}
          value={isPro ? type : ''}
          onChange={(ev) => setType(ev.target.value as OType)}
        >
          <option value="" disabled>Pro</option>
          {proTypes.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div className="seg">
        <button className={`buy ${side === 'B' ? 'active' : ''}`} onClick={() => setSide('B')}>{buyLabel}</button>
        <button className={`sell ${side === 'A' ? 'active' : ''}`} onClick={() => setSide('A')}>{sellLabel}</button>
      </div>

      <div className="kv"><span>Available to Trade</span><span className="v num">{availLabel}</span></div>
      {sp ? (
        <div className="kv"><span>{side === 'B' ? `${baseName} balance` : `${quoteName} balance`}</span><span className="v num">{fmtNum(e.state.spot[side === 'B' ? baseName : quoteName] ?? 0, side === 'B' ? szD : 2)}</span></div>
      ) : (
        <div className="kv"><span>Current Position</span><span className={`v num ${pos ? (pos.szi > 0 ? 'up' : 'down') : ''}`}>{pos ? `${pos.szi.toFixed(szD)} ${coin}` : `0 ${coin}`}</span></div>
      )}
      {sp && side === 'B' && !(e.state.spot[quoteName] > 0) && (
        <div className="muted">Your spot account has no {quoteName}. {quoteName === 'USDC' ? 'Transfer USDC from Perps to start trading spot.' : `Buy ${quoteName} on its USDC market first.`}</div>
      )}

      {isTrigger && (
        <div className="field">
          <label>Trigger Price</label>
          <input inputMode="decimal" value={trigStr} onChange={(ev) => setTrigStr(ev.target.value)} placeholder={fmtPx(e.markPx(coin), szD, sp)} />
          <span className="unit">{sp ? quoteName : 'USD'}</span>
        </div>
      )}
      {isTrigger && (
        <div className="faint">
          {side === 'A'
            ? (type.startsWith('tp') ? 'Sells when the mark price rises to the trigger.' : 'Sells when the mark price falls to the trigger.')
            : (type.startsWith('tp') ? 'Buys when the mark price falls to the trigger.' : 'Buys when the mark price rises to the trigger.')}
          {sp && side === 'A' ? ` Sells up to your ${baseName} balance at trigger time; canceled if you sell it all.` : ''}
        </div>
      )}
      {isScale && (
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}><label>Start</label><input inputMode="decimal" value={scStart} onChange={(ev) => setScStart(ev.target.value)} placeholder={fmtPx(mid, szD, sp)} /></div>
          <div className="field" style={{ flex: 1 }}><label>End</label><input inputMode="decimal" value={scEnd} onChange={(ev) => setScEnd(ev.target.value)} /></div>
        </div>
      )}
      {needsLimitPx && (
        <div className="field">
          <label>Price</label>
          <input inputMode="decimal" value={pxStr} onChange={(ev) => setPxStr(ev.target.value)} onBlur={() => limitPx && setPxStr(String(e.roundPx(coin, limitPx)))} />
          <button className="btn small" onClick={() => setPxStr(String(e.roundPx(coin, mid)))}>Mid</button>
        </div>
      )}
      <div className="field">
        <label>Size</label>
        <input inputMode="decimal" value={szStr} onChange={(ev) => { setSzStr(ev.target.value); setPct(0); }} placeholder="0" />
        <select aria-label="Size unit" value={unit} onChange={(ev) => { setUnit(ev.target.value as 'coin' | 'usd'); setSzStr(''); setPct(0); }}>
          <option value="usd">{quoteName}</option>
          <option value="coin">{baseName}</option>
        </select>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input className="slider" type="range" min={0} max={100} value={pct} onChange={(ev) => setFromPct(Number(ev.target.value))} aria-label="Size percent" />
        <span className="num muted" style={{ width: 36, textAlign: 'right' }}>{pct}%</span>
      </div>
      {unit === 'usd' && sz > 0 && <div className="kv"><span>Size in {baseName}</span><span className="v num">{sz.toFixed(szD)}</span></div>}

      {isScale && (
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}><label>Total orders</label><input inputMode="numeric" value={scN} onChange={(ev) => setScN(ev.target.value)} /></div>
          <div className="field" style={{ flex: 1 }} title="Size of the last order ÷ size of the first. 1 = equal sizes"><label>Size skew</label><input inputMode="decimal" value={scSkew} onChange={(ev) => setScSkew(ev.target.value)} /></div>
        </div>
      )}
      {isTwap && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="field" style={{ flex: 1 }}><label>Hours</label><input inputMode="numeric" value={twapH} onChange={(ev) => setTwapH(ev.target.value)} /></div>
            <div className="field" style={{ flex: 1 }}><label>Minutes</label><input inputMode="numeric" value={twapM} onChange={(ev) => setTwapM(ev.target.value)} /></div>
          </div>
          <label className="check"><input type="checkbox" checked={randomize} onChange={(ev) => setRandomize(ev.target.checked)} /> Randomize sub-order sizes</label>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {!sp ? <label className="check"><input type="checkbox" checked={reduceOnly} onChange={(ev) => setReduceOnly(ev.target.checked)} /> Reduce Only</label> : <span />}
        {type === 'limit' && (
          <select className="btn small" value={tif} onChange={(ev) => setTif(ev.target.value as Tif)} aria-label="Time in force">
            <option value="Gtc">GTC</option>
            <option value="Alo">ALO (Post only)</option>
            <option value="Ioc">IOC</option>
          </select>
        )}
      </div>
      {canAttachTpsl && (
        <label className="check"><input type="checkbox" checked={tpsl} onChange={(ev) => setTpsl(ev.target.checked)} /> Take Profit / Stop Loss</label>
      )}
      {tpsl && canAttachTpsl && (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="field" style={{ flex: 1 }}><label>TP</label><input inputMode="decimal" value={tpStr} onChange={(ev) => setTpStr(ev.target.value)} /></div>
            <div className="field" style={{ flex: 1 }}><label>SL</label><input inputMode="decimal" value={slStr} onChange={(ev) => setSlStr(ev.target.value)} /></div>
          </div>
          <div className="faint">
            Activates when this order fills. {sp ? `Sells the ${baseName} you receive (after fees) as a market order.` : 'Closes the whole position as a market order.'}
          </div>
        </>
      )}

      <button className={`submit ${side === 'B' ? 'buy' : 'sell'}`} disabled={!sz || !!error} onClick={submit}>
        {error && sz ? error : `${side === 'B' ? buyLabel : sellLabel}${type !== 'market' ? ` (${TYPE_LABEL[type]})` : ''}`}
      </button>

      {!sp && !isTwap && <div className="kv"><span>Liquidation Price</span><span className="v num warn">{estLiq ? fmtPx(estLiq, szD) : 'N/A'}</span></div>}
      <div className="kv"><span>Order Value</span><span className="v num">{sz ? fmtUsd(notional) : 'N/A'}</span></div>
      {!sp && <div className="kv"><span>Margin Required</span><span className="v num">{sz ? fmtUsd(marginReq) : 'N/A'}</span></div>}
      {isScale && ladder.length > 0 && (
        <>
          <div className="kv"><span>Average price</span><span className="v num">{fmtPx(scaleAvg, szD, sp)}</span></div>
          <div className="kv"><span>First order</span><span className="v num">{ladder[0].sz.toFixed(szD)} @ {fmtPx(ladder[0].px, szD, sp)}</span></div>
          <div className="kv"><span>Last order</span><span className="v num">{ladder[ladder.length - 1].sz.toFixed(szD)} @ {fmtPx(ladder[ladder.length - 1].px, szD, sp)}</span></div>
        </>
      )}
      {isTwap && (
        <>
          <div className="kv"><span>Sub-orders</span><span className="v num">{twapSlices()} × every 30s</span></div>
          <div className="kv"><span>Size per sub-order</span><span className="v num">{sz ? `${(sz / twapSlices()).toFixed(szD)} ${baseName} (${fmtUsd(notional / twapSlices())})` : 'N/A'}</span></div>
          <div className="kv"><span>Max slippage per sub-order</span><span className="v num">3%</span></div>
        </>
      )}
      {(type === 'market' || isTwap) && (
        <div className="kv"><span>{isTwap ? 'Est. Slippage per sub-order' : 'Est. Slippage'}</span><span className="v num">{est ? `${(est.slippage * 100).toFixed(4)}%${est.filled < (isTwap ? sz / twapSlices() : sz) ? ' (book too thin!)' : ''}` : 'N/A'}</span></div>
      )}
      {type === 'market' && est && <div className="kv"><span>Est. Avg Fill</span><span className="v num">{fmtPx(est.avgPx, szD, sp)}</span></div>}
      <div className="kv"><span>Fees (taker / maker)</span><span className="v num">{(takerFee * 100).toFixed(4)}% / {(makerFee * 100).toFixed(4)}%</span></div>

      <div className="divider" />
      <Account onTransfer={() => setXferOpen(true)} />
      {levOpen && <LeverageModal coin={coin} onClose={() => setLevOpen(false)} />}
      {xferOpen && <TransferModal onClose={() => setXferOpen(false)} />}
    </div>
  );
}

function Account({ onTransfer }: { onTransfer: () => void }) {
  const s = useStore();
  const sum = s.engine.summary();
  return (
    <div className="acct" style={{ padding: 0 }}>
      <div className="sectiontitle">Account Equity</div>
      <div className="kv"><span>Total Equity</span><span className="v num">{fmtUsd(sum.equity)}</span></div>
      <div className="kv"><span>Perps Equity</span><span className="v num">{fmtUsd(sum.perpEquity)}</span></div>
      <div className="kv"><span>Spot Value</span><span className="v num">{fmtUsd(sum.spotValue)}</span></div>
      <div className="kv"><span>Unrealized PnL (perps)</span><span className={`v num ${sum.upnl >= 0 ? 'up' : 'down'}`}>{fmtUsd(sum.upnl)}</span></div>
      <div className="kv"><span>PnL Since Start</span><span className={`v num ${sum.pnlSinceStart >= 0 ? 'up' : 'down'}`}>{fmtUsd(sum.pnlSinceStart)}</span></div>
      <button className="btn small" onClick={onTransfer}>Transfer Perps ⇄ Spot</button>
      <div className="sectiontitle">Perps Overview</div>
      <div className="kv"><span>Balance (USDC)</span><span className="v num">{fmtUsd(sum.cash)}</span></div>
      <div className="kv"><span>Cross Margin Ratio</span><span className={`v num ${sum.crossMarginRatio > 0.7 ? 'down' : ''}`}>{(sum.crossMarginRatio * 100).toFixed(2)}%</span></div>
      <div className="kv"><span>Maintenance Margin</span><span className="v num">{fmtUsd(sum.crossMaint)}</span></div>
      <div className="kv"><span>Cross Account Leverage</span><span className="v num">{sum.accountLeverage.toFixed(2)}x</span></div>
    </div>
  );
}
