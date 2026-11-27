import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { Fill, FundingEvent } from '../engine/engine';
import { useStore } from '../store';
import { fmtDate, fmtDateTime, fmtPx, fmtSigned, fmtSz, fmtUsd, localSec, pnlClass } from './format';

// ------------------------------------------------------------------ data model

type Market = 'all' | 'perp' | 'spot';
type Dir = 'all' | 'long' | 'short';
type Preset = '1d' | '7d' | '30d' | '90d' | 'ytd' | 'all' | 'custom';

interface LedgerRow {
  time: number;
  coin: string;
  label: string;
  spot: boolean;
  type: 'trade' | 'funding';
  dir: string;
  long: boolean;
  sz: number;
  px: number;
  volume: number;
  realized: number;
  fee: number;
  funding: number;
  net: number;
  closing: boolean;
  group: string; // order id / twap id: fills of one order form one trade
  liquidity?: string;
}

interface ClosedTrade {
  time: number; coin: string; label: string; spot: boolean; long: boolean; dir: string;
  sz: number; avgPx: number; realized: number; fee: number; net: number;
}

const DAY = 86_400_000;

function isClosing(f: Fill) {
  return f.spot ? f.side === 'A' : f.dir.startsWith('Close') || f.dir.includes('>') || !!f.liquidation;
}
function isLongExposure(f: Fill) {
  if (f.spot) return true;
  // the side of the position this fill opened or closed
  if (f.dir === 'Open Long' || f.dir === 'Close Long' || f.dir === 'Long > Short') return true;
  if (f.dir === 'Open Short' || f.dir === 'Close Short' || f.dir === 'Short > Long') return false;
  return f.side === 'B';
}

function toLedger(fills: Fill[], funding: FundingEvent[], label: (c: string) => string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const f of fills) {
    rows.push({
      time: f.time, coin: f.coin, label: f.label ?? label(f.coin), spot: !!f.spot, type: 'trade',
      dir: f.liquidation ? `Liquidation: ${f.dir}` : f.dir, long: isLongExposure(f), sz: f.sz, px: f.px,
      volume: f.sz * f.px, realized: f.closedPnl, fee: f.fee, funding: 0, net: f.closedPnl - f.fee,
      closing: isClosing(f), group: f.twapId ? `t${f.twapId}` : `o${f.oid}`, liquidity: f.liquidity,
    });
  }
  for (const x of funding) {
    rows.push({
      time: x.time, coin: x.coin, label: label(x.coin), spot: false, type: 'funding', dir: 'Funding',
      long: x.szi > 0, sz: Math.abs(x.szi), px: 0, volume: 0, realized: 0, fee: 0, funding: x.payment, net: x.payment,
      closing: false, group: '',
    });
  }
  return rows.sort((a, b) => a.time - b.time);
}

function closedTrades(rows: LedgerRow[]): ClosedTrade[] {
  const by = new Map<string, ClosedTrade & { notional: number }>();
  for (const r of rows) {
    if (r.type !== 'trade' || !r.closing) continue;
    const k = `${r.coin}|${r.group}`;
    let t = by.get(k);
    if (!t) {
      t = { time: r.time, coin: r.coin, label: r.label, spot: r.spot, long: r.long, dir: r.dir, sz: 0, avgPx: 0, realized: 0, fee: 0, net: 0, notional: 0 };
      by.set(k, t);
    }
    t.time = Math.max(t.time, r.time);
    t.sz += r.sz;
    t.notional += r.sz * r.px;
    t.realized += r.realized;
    t.fee += r.fee;
    t.net = t.realized - t.fee;
  }
  return [...by.values()].map((t) => ({ ...t, avgPx: t.sz ? t.notional / t.sz : 0 })).sort((a, b) => b.time - a.time);
}

function rangeFor(p: Preset, from: string, to: string, createdAt: number): [number, number] {
  const now = Date.now();
  switch (p) {
    case '1d': return [now - DAY, now];
    case '7d': return [now - 7 * DAY, now];
    case '30d': return [now - 30 * DAY, now];
    case '90d': return [now - 90 * DAY, now];
    case 'ytd': return [new Date(new Date().getFullYear(), 0, 1).getTime(), now];
    case 'all': return [Math.min(createdAt, now), now];
    case 'custom': {
      const a = from ? new Date(`${from}T00:00:00`).getTime() : createdAt;
      const b = to ? new Date(`${to}T23:59:59.999`).getTime() : now;
      return [a, b];
    }
  }
}

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.map((v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ charts

type Pt = { time: number; value: number };

function MiniChart({ title, subtitle, data, kind, fmt, empty }: {
  title: string; subtitle?: string; data: Pt[]; kind: 'line' | 'bars'; fmt: (v: number) => string; empty: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | null>(null);
  const [hover, setHover] = useState<{ t: number; v: number } | null>(null);
  const fmtRef = useRef(fmt);
  fmtRef.current = fmt;

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#8ba0a7', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: '#16262d' } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: kind === 'line', secondsVisible: false },
      crosshair: { horzLine: { visible: false, labelVisible: false } },
      localization: { priceFormatter: (v: number) => fmtRef.current(v) },
      handleScroll: false,
      handleScale: false,
    });
    const s = kind === 'line'
      ? c.addLineSeries({ color: '#4fd1c5', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4 })
      : c.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, base: 0 });
    c.subscribeCrosshairMove((p) => {
      const d = p.time !== undefined ? (p.seriesData.get(s) as { value?: number } | undefined) : undefined;
      setHover(d?.value !== undefined ? { t: p.time as number, v: d.value } : null);
    });
    chart.current = c;
    series.current = s;
    return () => { c.remove(); chart.current = null; series.current = null; };
  }, [kind]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    if (kind === 'bars') {
      (s as ISeriesApi<'Histogram'>).setData(data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value, color: p.value >= 0 ? '#26c49a' : '#ef5466' })));
    } else {
      (s as ISeriesApi<'Line'>).setData(data.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    const ts = chart.current?.timeScale();
    if (kind === 'bars' && ts && el.current) {
      // keep bars thin even when there are only a few days
      const spacing = Math.max(3, Math.min(18, (el.current.clientWidth - 80) / Math.max(data.length + 2, 1)));
      ts.applyOptions({ barSpacing: spacing, rightOffset: 1 });
      ts.scrollToRealTime();
    } else ts?.fitContent();
  }, [data, kind]);

  const last = data[data.length - 1];
  const shown = hover ?? (last ? { t: last.time, v: last.value } : null);
  const when = (t: Time | number) => {
    // times are already shifted to local; format them as UTC to read back local wall-clock
    const d = new Date((t as number) * 1000);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return kind === 'bars' ? date : `${date} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };
  return (
    <div className="card chartcard">
      <div className="cardhead">
        <div>
          <div className="cardtitle">{title}</div>
          {subtitle && <div className="faint">{subtitle}</div>}
        </div>
        {shown && (
          <div style={{ textAlign: 'right' }}>
            <div className={`num ${kind === 'bars' || title.includes('PnL') ? pnlClass(shown.v) : ''}`} style={{ fontSize: 15, fontWeight: 600 }}>{fmt(shown.v)}</div>
            <div className="faint num">{when(shown.t)}{hover ? '' : ' · latest'}</div>
          </div>
        )}
      </div>
      <div className="minichart" ref={el} style={{ visibility: data.length ? 'visible' : 'hidden' }} />
      {!data.length && <div className="empty" style={{ marginTop: -180 }}>{empty}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ page

export function Portfolio() {
  const s = useStore();
  const e = s.engine;
  const st = e.state;
  const [preset, setPreset] = useState<Preset>('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [market, setMarket] = useState<Market>('all');
  const [coin, setCoin] = useState('all');
  const [dir, setDir] = useState<Dir>('all');
  const [withFunding, setWithFunding] = useState(true);
  const [tab, setTab] = useState<'trades' | 'coins' | 'days' | 'ledger'>('coins');
  const [coinSort, setCoinSort] = useState<'net' | 'volume' | 'trades'>('net');

  const [t0, t1] = rangeFor(preset, from, to, st.createdAt);
  const ledger = useMemo(() => toLedger(st.fills, st.funding, (c) => s.display(c)), [st.fills, st.funding, st.fills.length, st.funding.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const coins = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of ledger) m.set(r.coin, r.label);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [ledger]);

  const rows = ledger.filter((r) =>
    r.time >= t0 && r.time <= t1
    && (market === 'all' || (market === 'spot') === r.spot)
    && (coin === 'all' || r.coin === coin)
    && (dir === 'all' || (dir === 'long') === r.long)
    && (withFunding || r.type !== 'funding'));

  // ---- stats
  let realized = 0, fees = 0, funding = 0, volume = 0, makerVol = 0;
  for (const r of rows) {
    realized += r.realized; fees += r.fee; funding += r.funding; volume += r.volume;
    if (r.liquidity === 'maker') makerVol += r.volume;
  }
  const net = realized - fees + funding;
  const trades = closedTrades(rows);
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net < 0);
  const grossWin = wins.reduce((a, t) => a + t.net, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.net, 0);
  const best = trades.reduce<ClosedTrade | null>((b, t) => (!b || t.net > b.net ? t : b), null);
  const worst = trades.reduce<ClosedTrade | null>((b, t) => (!b || t.net < b.net ? t : b), null);

  // ---- cumulative pnl series (one point per second)
  const cum: Pt[] = [];
  {
    let acc = 0;
    cum.push({ time: localSec(Math.max(t0, st.createdAt)), value: 0 });
    for (const r of rows) {
      acc += r.net;
      const t = localSec(r.time);
      if (cum.length && cum[cum.length - 1].time >= t) cum[cum.length - 1] = { time: cum[cum.length - 1].time, value: acc };
      else cum.push({ time: t, value: acc });
    }
    if (rows.length) cum.push({ time: Math.max(localSec(Math.min(t1, Date.now())), cum[cum.length - 1].time + 1), value: acc });
  }

  // ---- daily buckets (local dates)
  const days = new Map<string, { date: string; net: number; realized: number; fees: number; funding: number; volume: number; trades: number }>();
  for (const r of rows) {
    const d = fmtDate(r.time);
    let x = days.get(d);
    if (!x) { x = { date: d, net: 0, realized: 0, fees: 0, funding: 0, volume: 0, trades: 0 }; days.set(d, x); }
    x.net += r.net; x.realized += r.realized; x.fees += r.fee; x.funding += r.funding; x.volume += r.volume;
  }
  for (const t of trades) { const x = days.get(fmtDate(t.time)); if (x) x.trades++; }
  const dayList = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const daily: Pt[] = dayList.map((d) => ({ time: Math.floor(new Date(`${d.date}T00:00:00Z`).getTime() / 1000), value: d.net }));
  const greenDays = dayList.filter((d) => d.net > 0).length;

  // ---- equity curve (account-wide)
  const eqPts: Pt[] = [];
  for (const [t, v] of st.equityHist) {
    if (t < t0 || t > t1) continue;
    const ts = localSec(t);
    if (eqPts.length && eqPts[eqPts.length - 1].time >= ts) continue;
    eqPts.push({ time: ts, value: v });
  }
  {
    // live point so the curve reflects the latest fills, not just the last minute sample
    const now = Date.now();
    if (now >= t0 && now <= t1 + 60_000) {
      const ts = localSec(now);
      const live = { time: ts, value: e.summary().equity };
      if (eqPts.length && eqPts[eqPts.length - 1].time >= ts) eqPts[eqPts.length - 1] = live;
      else eqPts.push(live);
    }
  }
  let peak = -Infinity, maxDd = 0, maxDdPct = 0;
  for (const p of eqPts) {
    peak = Math.max(peak, p.value);
    if (peak - p.value > maxDd) { maxDd = peak - p.value; maxDdPct = peak > 0 ? maxDd / peak : 0; }
  }
  const eqChange = eqPts.length > 1 ? eqPts[eqPts.length - 1].value - eqPts[0].value : 0;

  // ---- by coin
  const byCoin = new Map<string, { coin: string; label: string; spot: boolean; net: number; realized: number; fees: number; funding: number; volume: number; trades: number; wins: number }>();
  for (const r of rows) {
    let x = byCoin.get(r.coin);
    if (!x) { x = { coin: r.coin, label: r.label, spot: r.spot, net: 0, realized: 0, fees: 0, funding: 0, volume: 0, trades: 0, wins: 0 }; byCoin.set(r.coin, x); }
    x.net += r.net; x.realized += r.realized; x.fees += r.fee; x.funding += r.funding; x.volume += r.volume;
  }
  for (const t of trades) { const x = byCoin.get(t.coin); if (x) { x.trades++; if (t.net > 0) x.wins++; } }
  const coinList = [...byCoin.values()].sort((a, b) => coinSort === 'net' ? b.net - a.net : coinSort === 'volume' ? b.volume - a.volume : b.trades - a.trades);

  const exportCsv = () => downloadCsv(`pnl-${fmtDate(t0)}-to-${fmtDate(t1)}.csv`, [
    ['time', 'market', 'coin', 'type', 'direction', 'size', 'price', 'volume_usd', 'realized_pnl', 'fee', 'funding', 'net', 'liquidity'],
    ...rows.map((r) => [new Date(r.time).toISOString(), r.spot ? 'spot' : 'perp', r.label, r.type, r.dir, r.sz, r.px, r.volume.toFixed(2), r.realized.toFixed(6), r.fee.toFixed(6), r.funding.toFixed(6), r.net.toFixed(6), r.liquidity ?? '']),
  ]);

  const PRESETS: [Preset, string][] = [['1d', '24H'], ['7d', '7D'], ['30d', '30D'], ['90d', '90D'], ['ytd', 'YTD'], ['all', 'All time']];
  const stat = (k: string, v: string, cls = '', hint?: string) => (
    <div className="card stat-tile" title={hint}>
      <div className="muted">{k}</div>
      <div className={`num tile-v ${cls}`}>{v}</div>
    </div>
  );

  return (
    <div className="portfolio">
      <div className="filters">
        <div className="seg" style={{ display: 'inline-grid' }}>
          {PRESETS.map(([p, l]) => <button key={p} className={preset === p ? 'active' : ''} onClick={() => setPreset(p)}>{l}</button>)}
        </div>
        <div className="field datefield">
          <label>From</label>
          <input type="date" value={preset === 'custom' ? from : fmtDate(t0)} max={to || undefined} onChange={(ev) => { setPreset('custom'); setFrom(ev.target.value); if (!to) setTo(fmtDate(t1)); }} />
        </div>
        <div className="field datefield">
          <label>To</label>
          <input type="date" value={preset === 'custom' ? to : fmtDate(t1)} min={from || undefined} onChange={(ev) => { setPreset('custom'); setTo(ev.target.value); if (!from) setFrom(fmtDate(t0)); }} />
        </div>
        <select className="btn" value={market} onChange={(ev) => { setMarket(ev.target.value as Market); setCoin('all'); }} aria-label="Market type">
          <option value="all">Perps + Spot</option>
          <option value="perp">Perps</option>
          <option value="spot">Spot</option>
        </select>
        <select className="btn" value={coin} onChange={(ev) => setCoin(ev.target.value)} aria-label="Coin">
          <option value="all">All coins</option>
          {coins.filter(([c]) => market === 'all' || (market === 'spot') === e.isSpot(c)).map(([c, l]) => <option key={c} value={c}>{l}</option>)}
        </select>
        <select className="btn" value={dir} onChange={(ev) => setDir(ev.target.value as Dir)} aria-label="Direction">
          <option value="all">Longs + Shorts</option>
          <option value="long">Longs only</option>
          <option value="short">Shorts only</option>
        </select>
        <label className="check"><input type="checkbox" checked={withFunding} onChange={(ev) => setWithFunding(ev.target.checked)} /> Include funding</label>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
      </div>

      <div className="tiles">
        {stat('Net PnL', fmtSigned(net), pnlClass(net), 'Realized PnL − fees + funding')}
        {stat('Realized PnL', fmtSigned(realized), pnlClass(realized), 'Closed PnL before fees')}
        {stat('Fees Paid', fmtUsd(-fees), fees > 0 ? 'down' : '')}
        {stat('Funding', fmtSigned(funding), pnlClass(funding))}
        {stat('Volume', fmtUsd(volume, 0), '', `Maker share ${volume ? ((makerVol / volume) * 100).toFixed(0) : 0}%`)}
        {stat('Closed Trades', String(trades.length), '', `${wins.length} wins · ${losses.length} losses`)}
        {stat('Win Rate', trades.length ? `${((wins.length / trades.length) * 100).toFixed(1)}%` : '—')}
        {stat('Profit Factor', grossLoss ? (grossWin / grossLoss).toFixed(2) : grossWin ? '∞' : '—', '', 'Gross wins ÷ gross losses (after fees)')}
        {stat('Avg Win / Avg Loss', `${wins.length ? fmtUsd(grossWin / wins.length) : '—'} / ${losses.length ? fmtUsd(-grossLoss / losses.length) : '—'}`)}
        {stat('Best / Worst Trade', `${best ? fmtSigned(best.net) : '—'} / ${worst ? fmtSigned(worst.net) : '—'}`)}
        {stat('Green Days', dayList.length ? `${greenDays} / ${dayList.length}` : '—')}
        {stat('Max Drawdown', eqPts.length > 1 ? `${fmtUsd(-maxDd)} (${(maxDdPct * 100).toFixed(2)}%)` : '—', maxDd > 0 ? 'down' : '', 'Peak-to-trough on account equity in this range')}
      </div>

      <div className="charts">
        <MiniChart title="Cumulative Net PnL" subtitle="Follows all filters above" data={cum.length > 1 ? cum : []} kind="line" fmt={(v) => fmtSigned(v)} empty="No trades in this range" />
        <MiniChart title="Daily Net PnL" subtitle="Local days · follows all filters" data={daily} kind="bars" fmt={(v) => fmtSigned(v)} empty="No trades in this range" />
        <MiniChart title="Account Equity" subtitle={`Whole account (date range only) · ${eqChange >= 0 ? '+' : ''}${fmtUsd(eqChange)} in range`} data={eqPts.length > 1 ? eqPts : []} kind="line" fmt={(v) => fmtUsd(v)} empty="Equity is sampled every minute while the app is open" />
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="tabs">
          <button className={tab === 'coins' ? 'active' : ''} onClick={() => setTab('coins')}>By Coin</button>
          <button className={tab === 'days' ? 'active' : ''} onClick={() => setTab('days')}>By Day</button>
          <button className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>Closed Trades ({trades.length})</button>
          <button className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}>Ledger ({rows.length})</button>
          {tab === 'coins' && (
            <div className="right">
              <select className="btn small" value={coinSort} onChange={(ev) => setCoinSort(ev.target.value as typeof coinSort)} aria-label="Sort by">
                <option value="net">Sort: Net PnL</option>
                <option value="volume">Sort: Volume</option>
                <option value="trades">Sort: Trades</option>
              </select>
            </div>
          )}
        </div>
        <div className="tablewrap" style={{ maxHeight: 520 }}>
          {tab === 'coins' && (coinList.length ? (
            <table className="table">
              <thead><tr><th>Coin</th><th>Market</th><th>Closed Trades</th><th>Win Rate</th><th>Volume</th><th>Realized</th><th>Fees</th><th>Funding</th><th>Net PnL</th></tr></thead>
              <tbody>
                {coinList.map((c) => (
                  <tr key={c.coin} style={{ cursor: 'pointer' }} onClick={() => setCoin(c.coin)} title="Filter to this coin">
                    <td><b>{c.label}</b></td>
                    <td className="muted">{c.spot ? 'Spot' : 'Perp'}</td>
                    <td>{c.trades}</td>
                    <td>{c.trades ? `${((c.wins / c.trades) * 100).toFixed(0)}%` : '—'}</td>
                    <td>{fmtUsd(c.volume, 0)}</td>
                    <td className={pnlClass(c.realized)}>{fmtSigned(c.realized)}</td>
                    <td>{fmtUsd(-c.fees)}</td>
                    <td className={pnlClass(c.funding)}>{c.spot ? '—' : fmtSigned(c.funding)}</td>
                    <td className={pnlClass(c.net)}><b>{fmtSigned(c.net)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty">No activity in this range</div>)}
          {tab === 'days' && (dayList.length ? (
            <table className="table">
              <thead><tr><th>Date</th><th>Closed Trades</th><th>Volume</th><th>Realized</th><th>Fees</th><th>Funding</th><th>Net PnL</th></tr></thead>
              <tbody>
                {dayList.slice().reverse().map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td><td>{d.trades}</td><td>{fmtUsd(d.volume, 0)}</td>
                    <td className={pnlClass(d.realized)}>{fmtSigned(d.realized)}</td>
                    <td>{fmtUsd(-d.fees)}</td>
                    <td className={pnlClass(d.funding)}>{fmtSigned(d.funding)}</td>
                    <td className={pnlClass(d.net)}><b>{fmtSigned(d.net)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty">No activity in this range</div>)}
          {tab === 'trades' && (trades.length ? (
            <table className="table">
              <thead><tr><th>Closed</th><th>Coin</th><th>Side</th><th>Action</th><th>Size</th><th>Avg Exit Price</th><th>Realized</th><th>Close Fees</th><th>Net</th></tr></thead>
              <tbody>
                {trades.slice(0, 1000).map((t, i) => {
                  const a = e.assets.get(t.coin);
                  return (
                    <tr key={i}>
                      <td>{fmtDateTime(t.time)}</td>
                      <td>{t.label}</td>
                      <td className={t.long ? 'up' : 'down'}>{t.spot ? 'Spot' : t.long ? 'Long' : 'Short'}</td>
                      <td className="muted">{t.dir}</td>
                      <td>{fmtSz(t.sz, a?.szDecimals ?? 4)}</td>
                      <td>{fmtPx(t.avgPx, a?.szDecimals ?? 2, t.spot)}</td>
                      <td className={pnlClass(t.realized)}>{fmtSigned(t.realized)}</td>
                      <td>{fmtUsd(-t.fee, 4)}</td>
                      <td className={pnlClass(t.net)}><b>{fmtSigned(t.net)}</b></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="empty">No closed trades in this range</div>)}
          {tab === 'ledger' && (rows.length ? (
            <table className="table">
              <thead><tr><th>Time</th><th>Coin</th><th>Type</th><th>Direction</th><th>Size</th><th>Price</th><th>Realized</th><th>Fee</th><th>Funding</th><th>Net</th></tr></thead>
              <tbody>
                {rows.slice(-1000).reverse().map((r, i) => {
                  const a = e.assets.get(r.coin);
                  return (
                    <tr key={i}>
                      <td>{fmtDateTime(r.time)}</td>
                      <td>{r.label}</td>
                      <td className="muted">{r.type === 'funding' ? 'Funding' : r.liquidity === 'maker' ? 'Fill (maker)' : 'Fill (taker)'}</td>
                      <td className={r.long ? 'up' : 'down'}>{r.dir}</td>
                      <td>{fmtSz(r.sz, a?.szDecimals ?? 4)}</td>
                      <td>{r.px ? fmtPx(r.px, a?.szDecimals ?? 2, r.spot) : '—'}</td>
                      <td className={pnlClass(r.realized)}>{r.realized ? fmtSigned(r.realized) : '—'}</td>
                      <td>{r.fee ? fmtUsd(-r.fee, 4) : '—'}</td>
                      <td className={pnlClass(r.funding)}>{r.funding ? fmtSigned(r.funding, 4) : '—'}</td>
                      <td className={pnlClass(r.net)}>{fmtSigned(r.net, 4)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="empty">No activity in this range</div>)}
        </div>
      </div>
      <div className="faint" style={{ padding: '4px 2px 16px' }}>
        Net PnL = realized PnL − all fees (opening and closing) + funding. A “closed trade” is one closing order (or one TWAP); its net counts only the fees of that closing order.
      </div>
    </div>
  );
}
