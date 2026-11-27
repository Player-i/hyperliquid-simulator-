import { priceDecimals } from '../engine/rules';

export function pxDecimals(px: number, szDecimals: number) {
  if (!(px > 0)) return 2;
  const mag = Math.floor(Math.log10(px));
  return Math.min(Math.max(0, 4 - mag), priceDecimals(szDecimals));
}

export function fmtPx(px: number | null | undefined, szDecimals: number) {
  if (px == null || !Number.isFinite(px) || px <= 0) return '—';
  const d = pxDecimals(px, szDecimals);
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

export function fmtTime(t: number) {
  return new Date(t).toLocaleTimeString('en-US', { hour12: false });
}

export function fmtDateTime(t: number) {
  const d = new Date(t);
  return `${d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString('en-US', { hour12: false })}`;
}

export const pnlClass = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
