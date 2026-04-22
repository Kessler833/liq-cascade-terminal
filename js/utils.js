function formatPrice(p) {
  if (!p) return '—';
  if (p >= 10000) return p.toLocaleString('en-US',{maximumFractionDigits:1});
  if (p >= 100) return p.toLocaleString('en-US',{maximumFractionDigits:2});
  return p.toLocaleString('en-US',{maximumFractionDigits:3});
}

function formatUSD(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v<0?'-':'')+'$'+(a/1e9).toFixed(2)+'B';
  if (a >= 1e6) return (v<0?'-':'')+'$'+(a/1e6).toFixed(2)+'M';
  if (a >= 1e3) return (v<0?'-':'')+'$'+(a/1e3).toFixed(1)+'K';
  return (v<0?'-':'')+'$'+a.toFixed(0);
}

function niceStep(range, maxTicks) {
  const rawStep = range / maxTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  for (const f of [1,2,2.5,5,10]) { if (f*mag >= rawStep) return f*mag; }
  return 10*mag;
}

function getVisibleCandles() {
  const all = state.candles;
  if (!all.length) return [];
  const end = Math.max(0, all.length - state.viewOffset);
  const start = Math.max(0, end - state.viewWidth);
  return all.slice(start, end);
}
