import { useEffect, useRef } from 'react';
import { createChart, CrosshairMode, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { fetchCandles, type RawCandle } from '../api/hl';
import { store, useStore } from '../store';
import { localSec, pxDecimals } from './format';

const INTERVALS: [string, number][] = [
  ['1m', 60e3], ['5m', 300e3], ['15m', 900e3], ['1h', 3600e3], ['4h', 14400e3], ['1d', 86400e3],
];

const toBar = (c: RawCandle) => ({
  time: localSec(c.t) as UTCTimestamp,
  open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c),
});

export function Chart() {
  const s = useStore();
  const { coin, interval } = s.prefs;
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const szDecimals = s.marketsByCoin.get(coin)?.szDecimals ?? 2;
  const spot = s.marketsByCoin.get(coin)?.spot;

  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: '#0f1a1f' }, textColor: '#8ba0a7', fontSize: 11 },
      grid: { vertLines: { color: '#16262d' }, horzLines: { color: '#16262d' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1e3139' },
      timeScale: { borderColor: '#1e3139', timeVisible: true, secondsVisible: false },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#26c49a', downColor: '#ef5466', borderVisible: false, wickUpColor: '#26c49a', wickDownColor: '#ef5466',
    });
    const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; volRef.current = null; linesRef.current = []; };
  }, []);

  // load history + live stream for coin/interval
  useEffect(() => {
    const series = seriesRef.current, vol = volRef.current;
    if (!series || !vol) return;
    let cancelled = false;
    const ms = INTERVALS.find(([i]) => i === interval)?.[1] ?? 900e3;
    const end = Date.now();
    series.setData([]);
    vol.setData([]);
    fetchCandles(coin, interval, end - ms * 1000, end).then((cs) => {
      if (cancelled) return;
      series.setData(cs.map(toBar));
      vol.setData(cs.map((c) => ({ time: localSec(c.t) as UTCTimestamp, value: Number(c.v), color: Number(c.c) >= Number(c.o) ? 'rgba(38,196,154,.35)' : 'rgba(239,84,102,.35)' })));
      chartRef.current?.timeScale().scrollToRealTime();
    }).catch(() => {});
    const unsub = store.socket.subscribe({ type: 'candle', coin, interval }, (c: RawCandle) => {
      if (cancelled) return;
      try {
        series.update(toBar(c));
        vol.update({ time: localSec(c.t) as UTCTimestamp, value: Number(c.v), color: Number(c.c) >= Number(c.o) ? 'rgba(38,196,154,.35)' : 'rgba(239,84,102,.35)' });
      } catch { /* out-of-order bar before history loaded */ }
    });
    return () => { cancelled = true; unsub(); };
  }, [coin, interval]);

  // price precision
  useEffect(() => {
    const mark = s.marketsByCoin.get(coin)?.markPx ?? 0;
    const d = pxDecimals(mark, szDecimals, !!spot);
    seriesRef.current?.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: 10 ** -d } });
  }, [coin, szDecimals, s.ready, spot]);

  // overlay lines: entry, liquidation, open orders, triggers
  const e = s.engine;
  const pos = e.state.positions[coin];
  const liq = pos ? e.liqPx(pos) : null;
  const orders = e.state.orders.filter((o) => o.coin === coin && o.status === 'open');
  const spotCb = spot ? e.state.spotCost[spot.base] : undefined;
  const spotAvg = spotCb && spotCb.sz > 0 ? spotCb.cost / spotCb.sz : 0;
  const sig = JSON.stringify([spotAvg, pos?.entryPx, pos?.szi, liq && Math.round(liq * 100), orders.map((o) => [o.oid, o.px, o.sz, o.trigger?.triggerPx])]);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) series.removePriceLine(l);
    linesRef.current = [];
    const add = (price: number, color: string, title: string, style = LineStyle.Dashed) =>
      linesRef.current.push(series.createPriceLine({ price, color, title, lineStyle: style, lineWidth: 1, axisLabelVisible: true }));
    if (pos) {
      add(pos.entryPx, pos.szi > 0 ? '#26c49a' : '#ef5466', `${pos.szi > 0 ? 'Long' : 'Short'} ${Math.abs(pos.szi)}`, LineStyle.Solid);
      if (liq) add(liq, '#f0b84a', 'Liq.');
    }
    if (spotAvg) add(spotAvg, '#26c49a', `Avg cost (${spotCb!.sz.toFixed(szDecimals)} ${spot!.base})`, LineStyle.Solid);
    for (const o of orders) {
      if (o.trigger) add(o.trigger.triggerPx, '#9b8cff', `${o.trigger.tpsl.toUpperCase()} ${o.trigger.positionTpsl ? '' : o.sz}`);
      else add(o.px, o.side === 'B' ? '#26c49a' : '#ef5466', `${o.side === 'B' ? 'Buy' : 'Sell'} ${o.sz}`, LineStyle.Dotted);
    }
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="intervals">
        {INTERVALS.map(([i]) => (
          <button key={i} className={i === interval ? 'active' : ''} onClick={() => s.setInterval(i)}>{i}</button>
        ))}
      </div>
      <div className="chart" ref={el} />
    </>
  );
}
