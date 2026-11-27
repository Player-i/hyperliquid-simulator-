// Hyperliquid perp tick/lot rules.
// - Sizes are rounded to `szDecimals`.
// - Prices: at most 5 significant figures and at most (6 - szDecimals) decimals.
//   Integer prices are always valid regardless of significant figures.

export const MAX_PERP_DECIMALS = 6;
export const MAX_SPOT_DECIMALS = 8;
export const MIN_ORDER_NOTIONAL = 10;

export function roundSize(sz: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.floor(sz * f + 1e-9) / f;
}

export function priceDecimals(szDecimals: number, spot = false) {
  return Math.max(0, (spot ? MAX_SPOT_DECIMALS : MAX_PERP_DECIMALS) - szDecimals);
}

export function roundPrice(px: number, szDecimals: number, mode: 'nearest' | 'down' | 'up' = 'nearest', spot = false): number {
  if (!(px > 0)) return 0;
  const mag = Math.floor(Math.log10(px));
  const decimals = Math.min(Math.max(0, 4 - mag), priceDecimals(szDecimals, spot));
  const f = 10 ** decimals;
  const x = px * f;
  const r = mode === 'down' ? Math.floor(x + 1e-9) : mode === 'up' ? Math.ceil(x - 1e-9) : Math.round(x);
  return Number((r / f).toFixed(decimals));
}

export function isValidPrice(px: number, szDecimals: number, spot = false): boolean {
  if (!(px > 0)) return false;
  if (Number.isInteger(px)) return true;
  return roundPrice(px, szDecimals, 'nearest', spot) === px;
}

export function tickFor(px: number, szDecimals: number, spot = false): number {
  if (px <= 0) return 10 ** -priceDecimals(szDecimals, spot);
  const mag = Math.floor(Math.log10(px));
  const decimals = Math.min(Math.max(0, 4 - mag), priceDecimals(szDecimals, spot));
  return 10 ** -decimals;
}
