import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { fmtCompact, fmtPct, fmtPx } from './format';

function useNow(ms = 1000) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return n;
}

export function MarketHeader() {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const now = useNow();
  const coin = s.prefs.coin;
  const m = s.marketsByCoin.get(coin);
  if (!m) return <div className="mkthead">Loading markets…</div>;
  const ch = m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0;
  const nextHour = Math.ceil(now / 3_600_000) * 3_600_000;
  const left = Math.max(0, nextHour - now);
  const mm = String(Math.floor(left / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0');
  return (
    <div className="mkthead">
      <button className="coinbtn" onClick={() => setOpen(!open)}>
        {coin}-USD <span className="lev">{m.maxLeverage}x</span> <span className="muted" style={{ fontSize: 12 }}>▾</span>
      </button>
      <div className="stat"><div className="k" title="Used for PnL, liquidations and TP/SL triggers">Mark</div><div className="v num">{fmtPx(m.markPx, m.szDecimals)}</div></div>
      <div className="stat"><div className="k" title="Used for funding">Oracle</div><div className="v num">{fmtPx(m.oraclePx, m.szDecimals)}</div></div>
      <div className="stat"><div className="k">24h Change</div><div className={`v num ${ch >= 0 ? 'up' : 'down'}`}>{fmtPx(Math.abs(m.markPx - m.prevDayPx), m.szDecimals)} / {fmtPct(ch)}</div></div>
      <div className="stat"><div className="k">24h Volume</div><div className="v num">{fmtCompact(m.dayNtlVlm)}</div></div>
      <div className="stat"><div className="k">Open Interest</div><div className="v num">{fmtCompact(m.openInterest * m.markPx)}</div></div>
      <div className="stat"><div className="k" title="Hourly funding rate. Positive: longs pay shorts">Funding / Countdown</div><div className="v num"><span className={m.funding >= 0 ? 'up' : 'down'}>{(m.funding * 100).toFixed(4)}%</span> {mm}:{ss}</div></div>
      {open && <MarketSelector onClose={() => setOpen(false)} />}
    </div>
  );
}

function MarketSelector({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'vol' | 'change' | 'funding' | 'oi'>('vol');
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const r = s.markets.filter((m) => !ql || m.coin.toLowerCase().includes(ql));
    const key = (m: (typeof r)[number]) =>
      sort === 'vol' ? m.dayNtlVlm : sort === 'change' ? (m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0) : sort === 'funding' ? m.funding : m.openInterest * m.markPx;
    return r.slice().sort((a, b) => key(b) - key(a));
  }, [s.markets, q, sort]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 39 }} onClick={onClose} />
      <div className="selector">
        <input className="search" autoFocus placeholder={`Search ${s.markets.length} perpetual markets`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="list">
          <table className="table">
            <thead><tr>
              <th></th><th>Symbol</th><th>Last Price</th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('change')}>24h Change</th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('funding')}>8h Funding</th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('vol')}>Volume</th>
              <th style={{ cursor: 'pointer' }} onClick={() => setSort('oi')}>Open Interest</th>
            </tr></thead>
            <tbody>
              {rows.map((m) => {
                const ch = m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0;
                const fav = s.prefs.favorites.includes(m.coin);
                return (
                  <tr key={m.coin} onClick={() => { s.setCoin(m.coin); onClose(); }}>
                    <td><button className={`star ${fav ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); s.toggleFavorite(m.coin); }}>★</button></td>
                    <td><b>{m.coin}</b>-USD <span className="faint">{m.maxLeverage}x</span></td>
                    <td className="num">{fmtPx(m.markPx, m.szDecimals)}</td>
                    <td className={`num ${ch >= 0 ? 'up' : 'down'}`}>{fmtPct(ch)}</td>
                    <td className="num">{(m.funding * 8 * 100).toFixed(4)}%</td>
                    <td className="num">{fmtCompact(m.dayNtlVlm)}</td>
                    <td className="num">{fmtCompact(m.openInterest * m.markPx)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
