import { priceDecimals } from '../engine/rules';

export function pxDecimals(px: number, szDecimals: number, spot = false) {
  if (!(px > 0)) return 2;
  const mag = Math.floor(Math.log10(px));
  return Math.min(Math.max(0, 4 - mag), priceDecimals(szDecimals, spot));
}

export function fmtPx(px: number | null | undefined, szDecimals: number, spot = false) {
  if (px == null || !Number.isFinite(px) || px <= 0) return '—';
  const d = pxDecimals(px, szDecimals, spot);
  return px.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtSz(sz: number, szDecimals: number) {
  return sz.toLocaleString('en-US', { minimumFractionDigits: szDecimals, maximumFractionDigits: szDecimals });
}

export function fmtUsd(v: number, d = 2) {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${v < 0 ? '-' : ''}$${s}`;
}

export function fmtSigned(v: number, d = 2) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function fmtPct(v: number, d = 2) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
}

export function fmtCompact(v: number) {
  return '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
}

export function fmtNum(v: number, maxD = 6) {
  return v.toLocaleString('en-US', { maximumFractionDigits: maxD });
}

export function fmtDate(t: number) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** lightweight-charts renders UTC; shift timestamps so the axis shows local time */
export function localSec(t: number) {
  return Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / 1000);
}

export function fmtTime(t: number) {
  return new Date(t).toLocaleTimeString('en-US', { hour12: false });
}

export function fmtDateTime(t: number) {
  const d = new Date(t);
  return `${d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString('en-US', { hour12: false })}`;
}

export const pnlClass = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
