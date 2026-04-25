/** Formatting + small DOM helpers. */

export function fmtUSD(v: number, compact = true): string {
  if (!compact) return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3)  return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function fmtDelta(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  const abs  = Math.abs(v);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtPrice(v: number): string {
  if (v >= 1000) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

export function fmtPct(v: number | null): string {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(3) + '%';
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls: string, html = ''
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  return e;
}

export function sizeClass(usd: number): string {
  if (usd >= 1e7) return 'liq-whale';
  if (usd >= 1e6) return 'liq-large';
  if (usd >= 5e5) return 'liq-med';
  return 'liq-small';
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
