import { useEffect, useState } from 'react';
import { store, useStore } from './store';
import { Chart } from './ui/Chart';
import { OrderBookPanel } from './ui/OrderBook';
import { OrderForm } from './ui/OrderForm';
import { BottomPanel } from './ui/BottomPanel';
import { MarketHeader } from './ui/MarketHeader';
import { SettingsModal } from './ui/Modals';
import { fmtPct, fmtUsd } from './ui/format';

export function App() {
  const s = useStore();
  const [settings, setSettings] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  useEffect(() => { store.start().catch(() => setBootError('Could not load markets from api.hyperliquid.xyz. Check your connection and reload.')); }, []);
  const sum = s.engine.summary();
  const wsColor = s.wsStatus === 'open' ? 'var(--up)' : s.wsStatus === 'connecting' ? 'var(--warn)' : 'var(--down)';

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">HL Paper Trader<span>simulated · live Hyperliquid data</span></div>
        <div className="spacer" />
        <span className="pill num">Equity {fmtUsd(sum.equity)} <span className={sum.pnlSinceStart >= 0 ? 'up' : 'down'}>({fmtPct(sum.pnlSinceStart / s.engine.state.settings.startingBalance)})</span></span>
        <span className="pill"><span className="dot" style={{ background: wsColor }} />{s.wsStatus === 'open' ? 'Live' : s.wsStatus}</span>
        <button className="btn" onClick={() => setSettings(true)}>Settings</button>
      </div>
      <div>
        {(bootError || s.error) && <div className="banner">{bootError ?? s.error}</div>}
        <div className="favbar">
          {s.prefs.favorites.map((c) => {
            const m = s.marketsByCoin.get(c);
            if (!m) return null;
            const ch = m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0;
            return (
              <button key={c} onClick={() => s.setCoin(c)}>
                <b style={{ color: c === s.prefs.coin ? 'var(--accent)' : undefined }}>{c}</b>{' '}
                <span className={ch >= 0 ? 'up' : 'down'}>{fmtPct(ch)}</span>
              </button>
            );
          })}
        </div>
        <MarketHeader />
      </div>
      {!s.ready ? <div className="empty">{bootError ? '' : 'Loading Hyperliquid markets…'}</div> : <div className="main">
        <div className="panel chartwrap"><Chart /></div>
        <div className="panel bookwrap"><OrderBookPanel /></div>
        <div className="panel formwrap"><OrderForm /></div>
        <div className="panel bottomwrap"><BottomPanel /></div>
      </div>}
      <div className="toasts">
        {s.toasts.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
      </div>
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  );
}
