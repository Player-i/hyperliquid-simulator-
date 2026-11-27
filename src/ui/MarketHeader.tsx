import { useEffect, useMemo, useState } from 'react';
import { useStore, type MarketRow } from '../store';
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
  const sp = !!m.spot;
  const ch = m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0;
  const nextHour = Math.ceil(now / 3_600_000) * 3_600_000;
  const left = Math.max(0, nextHour - now);
  const mm = String(Math.floor(left / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0');
  return (
    <div className="mkthead">
      <button className="coinbtn" onClick={() => setOpen(!open)}>
        {m.display} <span className="lev">{sp ? 'Spot' : `${m.maxLeverage}x`}</span>
        {m.dex && <span className="lev" title={`HIP-3 market deployed by ${s.hip3Dexes.find((d) => d.name === m.dex)?.fullName ?? m.dex}. Isolated margin only.`}>{m.dex} · isolated</span>} <span className="muted" style={{ fontSize: 12 }}>▾</span>
      </button>
      <div className="stat"><div className="k" title={sp ? 'Spot mark price' : 'Used for PnL, liquidations and TP/SL triggers'}>{sp ? 'Price' : 'Mark'}</div><div className="v num">{fmtPx(m.markPx, m.szDecimals, sp)}</div></div>
      {!sp && <div className="stat"><div className="k" title="Used for funding">Oracle</div><div className="v num">{fmtPx(m.oraclePx, m.szDecimals)}</div></div>}
      <div className="stat"><div className="k">24h Change</div><div className={`v num ${ch >= 0 ? 'up' : 'down'}`}>{fmtPx(Math.abs(m.markPx - m.prevDayPx), m.szDecimals, sp)} / {fmtPct(ch)}</div></div>
      <div className="stat"><div className="k">24h Volume</div><div className="v num">{fmtCompact(m.dayNtlVlm)}</div></div>
      {sp ? (
        <div className="stat"><div className="k">Market Cap</div><div className="v num">{m.circulatingSupply ? fmtCompact(m.circulatingSupply * m.markPx) : '—'}</div></div>
      ) : (
        <>
          <div className="stat"><div className="k">Open Interest</div><div className="v num">{fmtCompact(m.openInterest * m.markPx)}</div></div>
          <div className="stat"><div className="k" title="Hourly funding rate. Positive: longs pay shorts">Funding / Countdown</div><div className="v num"><span className={m.funding >= 0 ? 'up' : 'down'}>{(m.funding * 100).toFixed(4)}%</span> {mm}:{ss}</div></div>
        </>
      )}
      {open && <MarketSelector initialTab={sp ? 'spot' : m.dex ? 'hip3' : 'perps'} onClose={() => setOpen(false)} />}
    </div>
  );
}

type SelTab = 'perps' | 'hip3' | 'spot' | 'fav';
function MarketSelector({ onClose, initialTab }: { onClose: () => void; initialTab: SelTab }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<SelTab>(initialTab);
  const [dex, setDex] = useState('all');
  const [sort, setSort] = useState<'vol' | 'change' | 'funding' | 'oi'>('vol');
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const r = s.markets.filter((m) => {
      const inTab = tab === 'fav' ? s.prefs.favorites.includes(m.coin)
        : tab === 'spot' ? !!m.spot
        : tab === 'hip3' ? !!m.dex && (dex === 'all' || m.dex === dex)
        : !m.spot && !m.dex;
      // typing searches every market (perps, stocks/HIP-3 and spot), whatever tab is open
      if (ql) return m.display.toLowerCase().includes(ql) || m.coin.toLowerCase() === ql;
      return inTab;
    });
    const key = (m: MarketRow) =>
      sort === 'vol' ? m.dayNtlVlm : sort === 'change' ? (m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0)
        : sort === 'funding' ? m.funding : m.spot ? (m.circulatingSupply ?? 0) * m.markPx : m.openInterest * m.markPx;
    return r.sort((a, b) => key(b) - key(a));
  }, [s.markets, q, sort, tab, dex, s.prefs.favorites]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const spotTab = tab === 'spot';
  const sortTh = (k: typeof sort, label: string) => (
    <th style={{ cursor: 'pointer' }} onClick={() => setSort(k)}>{label}{sort === k ? ' ▾' : ''}</th>
  );
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 39 }} onClick={onClose} />
      <div className="selector">
        <input className="search" autoFocus placeholder="Search all markets: BTC, TSLA, NVDA, HYPE…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="tabs">
          <button className={tab === 'fav' ? 'active' : ''} onClick={() => setTab('fav')}>Favorites</button>
          <button className={tab === 'perps' ? 'active' : ''} onClick={() => setTab('perps')}>Perps</button>
          <button className={tab === 'hip3' ? 'active' : ''} onClick={() => setTab('hip3')}>Stocks &amp; HIP-3</button>
          <button className={tab === 'spot' ? 'active' : ''} onClick={() => setTab('spot')}>Spot</button>
        </div>
        {tab === 'hip3' && (
          <div className="tabs" style={{ flexWrap: 'wrap' }}>
            <button className={dex === 'all' ? 'active' : ''} onClick={() => setDex('all')}>All</button>
            {s.hip3Dexes.filter((d) => s.markets.some((m) => m.dex === d.name)).map((d) => (
              <button key={d.name} className={dex === d.name ? 'active' : ''} onClick={() => setDex(d.name)} title={d.fullName}>{d.name}</button>
            ))}
          </div>
        )}
        <div className="list">
          <table className="table">
            <thead><tr>
              <th></th><th>Symbol</th><th>Last Price</th>
              {sortTh('change', '24h Change')}
              {!spotTab && sortTh('funding', '8h Funding')}
              {sortTh('vol', 'Volume')}
              {sortTh('oi', spotTab ? 'Market Cap' : 'Open Interest')}
            </tr></thead>
            <tbody>
              {rows.map((m) => {
                const ch = m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0;
                const fav = s.prefs.favorites.includes(m.coin);
                return (
                  <tr key={m.coin} onClick={() => { s.setCoin(m.coin); onClose(); }}>
                    <td><button className={`star ${fav ? 'on' : ''}`} aria-label="Favorite" onClick={(e) => { e.stopPropagation(); s.toggleFavorite(m.coin); }}>★</button></td>
                    <td><b>{m.display}</b> <span className="faint">{m.spot ? 'Spot' : m.dex ? `${m.maxLeverage}x · HIP-3` : `${m.maxLeverage}x`}</span></td>
                    <td className="num">{fmtPx(m.markPx, m.szDecimals, !!m.spot)}</td>
                    <td className={`num ${ch >= 0 ? 'up' : 'down'}`}>{fmtPct(ch)}</td>
                    {!spotTab && <td className="num">{m.spot ? '—' : `${(m.funding * 8 * 100).toFixed(4)}%`}</td>}
                    <td className="num">{fmtCompact(m.dayNtlVlm)}</td>
                    <td className="num">{m.spot ? (m.circulatingSupply ? fmtCompact(m.circulatingSupply * m.markPx) : '—') : fmtCompact(m.openInterest * m.markPx)}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} className="empty">No markets</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
