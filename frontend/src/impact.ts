/**
 * impact.ts — Impact tab rendering: table, stats, filters, pagination, detail charts.
 * Chart.js is loaded as a CDN global in index.html.
 */

import type { ImpactObs, ImpactStats } from './state';
import { fmtUSD, fmtPrice, fmtPct, el } from './utils';

declare const Chart: any;

// ---- view state ----
let _page         = 1;
const PAGE_SIZE   = 30;
let _filterAsset  = 'All';
let _filterSide   = 'All';
let _filterSize   = 'All';
let _filterStatus = 'All';
let _selectedId: string | null = null;
let _allObs: ImpactObs[] = [];
let _stats: ImpactStats  = { total: 0, recording: 0, avg_err: null, absorbed: 0 };
let _charts: Record<string, any> = {};

// ---- public API ----

export function initImpactTab(): void {
  const on = (id: string, fn: (v: string) => void) => {
    document.getElementById(id)?.addEventListener('change', e =>
      fn((e.target as HTMLSelectElement).value)
    );
  };
  on('imp-filter-asset',  v => { _filterAsset  = v; _page = 1; renderTable(); });
  on('imp-filter-side',   v => { _filterSide   = v; _page = 1; renderTable(); });
  on('imp-filter-size',   v => { _filterSize   = v; _page = 1; renderTable(); });
  on('imp-filter-status', v => { _filterStatus = v; _page = 1; renderTable(); });

  document.getElementById('imp-prev')?.addEventListener('click', () => {
    if (_page > 1) { _page--; renderTable(); }
  });
  document.getElementById('imp-next')?.addEventListener('click', () => {
    _page++; renderTable();
  });
  document.getElementById('imp-detail-close')?.addEventListener('click', closeDetail);
}

export function updateImpact(obs: ImpactObs[], stats: ImpactStats): void {
  _allObs = obs;
  _stats  = stats;
  renderStats();
  renderTable();

  // Live-refresh open detail panel
  if (_selectedId) {
    const current = obs.find(o => o.id === _selectedId);
    if (current) {
      fillDetailHeader(current);
      renderDetailCharts(current);
    }
  }

  const empty = document.getElementById('imp-empty-state');
  if (empty) empty.style.display = obs.length === 0 ? 'flex' : 'none';
}

// ---- stats bar ----

function renderStats(): void {
  setText('imp-kpi-total',     String(_stats.total));
  setText('imp-kpi-recording', String(_stats.recording));
  setText('imp-kpi-avg-err',   _stats.avg_err != null ? _stats.avg_err.toFixed(3) + '%' : '—');
  setText('imp-kpi-absorbed',  String(_stats.absorbed));
}

// ---- table ----

function filtered(): ImpactObs[] {
  return _allObs.filter(o => {
    if (_filterAsset  !== 'All' && o.asset !== _filterAsset) return false;
    if (_filterSide   !== 'All' && o.side  !== _filterSide.toLowerCase()) return false;
    if (_filterSize   !== 'All') {
      if (_filterSize === 'Single' && o.cascade_size !== 1) return false;
      if (_filterSize === 'Multi'  && o.cascade_size  <  2) return false;
    }
    if (_filterStatus !== 'All') {
      if (_filterStatus === 'Recording' && o.label_filled !== 0) return false;
      if (_filterStatus === 'Complete'  && o.label_filled !== 1) return false;
    }
    return true;
  });
}

function renderTable(): void {
  const rows       = filtered();
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (_page > totalPages) _page = totalPages;
  const start = (_page - 1) * PAGE_SIZE;
  const page  = rows.slice(start, start + PAGE_SIZE);

  setText('imp-page-info', `Page ${_page} / ${totalPages}  (${rows.length} total)`);
  const prevBtn = document.getElementById('imp-prev') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('imp-next') as HTMLButtonElement | null;
  if (prevBtn) prevBtn.disabled = _page <= 1;
  if (nextBtn) nextBtn.disabled = _page >= totalPages;

  const tbody = document.getElementById('imp-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  for (const obs of page) {
    const tr = el('tr', 'imp-row' + (_selectedId === obs.id ? ' active' : ''));
    tr.dataset.id = obs.id;

    const isRec      = obs.label_filled === 0;
    const sideColor  = obs.side === 'long' ? 'var(--green)' : 'var(--red)';
    const deltaColor = (obs.initial_delta ?? 0) <= 0 ? 'var(--green)' : 'var(--red)';
    const ts         = new Date(obs.timestamp);
    const timeStr    = ts.toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    tr.innerHTML = `
      <td class="imp-td"><span class="imp-dot ${isRec ? 'recording' : 'complete'}"></span></td>
      <td class="imp-td mono" style="color:var(--text-muted);font-size:10px">${timeStr}</td>
      <td class="imp-td" style="color:var(--accent)">${obs.asset}</td>
      <td class="imp-td" style="color:${sideColor};font-weight:700">${obs.side.toUpperCase()}</td>
      <td class="imp-td">${sizeBadge(obs.cascade_size)}</td>
      <td class="imp-td mono">${fmtUSD(obs.initial_liq_volume)}</td>
      <td class="imp-td mono">${fmtUSD(obs.total_liq_volume)}</td>
      <td class="imp-td mono" style="color:${deltaColor}">${fmtUSD(obs.initial_delta ?? 0)}</td>
      <td class="imp-td mono">${fmtPrice(obs.initial_expected_price)}</td>
      <td class="imp-td mono">${obs.final_expected_price  ? fmtPrice(obs.final_expected_price)  : '—'}</td>
      <td class="imp-td mono">${obs.actual_terminal_price ? fmtPrice(obs.actual_terminal_price) : '—'}</td>
      <td class="imp-td mono" style="color:${errColor(obs.price_error_pct)}">${fmtPct(obs.price_error_pct)}</td>
      <td class="imp-td mono" style="color:var(--text-muted)">${obs.cascade_duration_s != null ? obs.cascade_duration_s.toFixed(1) + 's' : '—'}</td>
      <td class="imp-td">${obs.absorbed_by_delta ? '<span class="imp-badge cyan">ABS</span>' : '—'}</td>
    `;
    tr.addEventListener('click', () => openDetail(obs.id));
    tbody.appendChild(tr);
  }
}

// ---- detail panel ----

function openDetail(id: string): void {
  // Toggle: clicking an already-selected row closes the panel
  if (_selectedId === id) { closeDetail(); return; }

  const obs = _allObs.find(o => o.id === id);
  if (!obs) return;
  _selectedId = id;

  document.querySelectorAll('.imp-row').forEach(r =>
    r.classList.toggle('active', (r as HTMLElement).dataset.id === id)
  );
  document.getElementById('imp-detail')?.classList.add('open');

  fillDetailHeader(obs);
  renderDetailCharts(obs);
}

function closeDetail(): void {
  _selectedId = null;
  document.getElementById('imp-detail')?.classList.remove('open');
  document.querySelectorAll('.imp-row').forEach(r => r.classList.remove('active'));
  destroyCharts();
}

function fillDetailHeader(obs: ImpactObs): void {
  const sideColor = obs.side === 'long' ? 'var(--green)' : 'var(--red)';
  setText('det-imp-asset', obs.asset);
  const sideEl = document.getElementById('det-imp-side');
  if (sideEl) { sideEl.textContent = obs.side.toUpperCase(); sideEl.style.color = sideColor; }
  setText('det-imp-entry', fmtPrice(obs.entry_price));
  setText('det-imp-exch', obs.exchange.charAt(0).toUpperCase() + obs.exchange.slice(1));
  const sizeEl = document.getElementById('det-imp-size');
  if (sizeEl) sizeEl.innerHTML = sizeBadge(obs.cascade_size);
  setText('det-imp-dur', obs.cascade_duration_s != null ? obs.cascade_duration_s.toFixed(1) + 's' : 'recording…');
  const errEl = document.getElementById('det-imp-err');
  if (errEl) { errEl.textContent = fmtPct(obs.price_error_pct); errEl.style.color = errColor(obs.price_error_pct); }
  const absEl = document.getElementById('det-imp-abs');
  if (absEl) { absEl.textContent = obs.absorbed_by_delta ? 'YES' : 'NO'; absEl.style.color = obs.absorbed_by_delta ? 'var(--accent)' : 'var(--text-faint)'; }
}

// ---- detail charts ----

function destroyCharts(): void {
  for (const c of Object.values(_charts)) c?.destroy?.();
  _charts = {};
}

function renderDetailCharts(obs: ImpactObs): void {
  if (typeof Chart === 'undefined') return;
  destroyCharts();

  const origin         = obs.timestamp;
  const cascadeEvents  = obs.cascade_events ?? [];

  // ---- Chart 1: Volume Delta ----
  const deltaSeries = obs.delta_series;
  if (deltaSeries && deltaSeries.length > 1) {
    const labels = elapsedLabels(deltaSeries, origin);
    const data   = deltaSeries.map(([, v]) => v);
    _charts.delta = new Chart(
      ctx('imp-chart-delta'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              data,
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.3,
              fill: { target: { value: 0 }, above: 'rgba(255,61,90,0.07)', below: 'rgba(0,230,118,0.07)' },
              segment: {
                borderColor: (c: any) => c.p0.parsed.y <= 0 ? 'rgba(0,230,118,0.8)' : 'rgba(255,61,90,0.8)',
              },
            },
            refLine(labels, 0, 'rgba(122,132,153,0.3)', ''),
            ...cascadeAnnotations(cascadeEvents, deltaSeries, origin),
          ],
        },
        options: chartOpts('Delta (USD)', fmtUSD),
      }
    );
  }

  // ---- Chart 2: Predicted Terminal Price ----
  const expSeries = obs.expected_price_series;
  if (expSeries && expSeries.length > 1) {
    const labels = elapsedLabels(expSeries, origin);
    const data   = expSeries.map(([, v]) => v);
    const sideLineColor = obs.side === 'long' ? 'rgba(255,61,90,0.85)' : 'rgba(0,230,118,0.85)';
    _charts.expected = new Chart(
      ctx('imp-chart-expected'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor: sideLineColor, borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false },
            refLine(labels, obs.entry_price, 'rgba(122,132,153,0.5)', 'Entry'),
            ...(obs.actual_terminal_price != null
              ? [refLine(labels, obs.actual_terminal_price, 'rgba(0,230,118,0.55)', 'Actual')]
              : []),
            ...cascadeAnnotations(cascadeEvents, expSeries, origin),
          ],
        },
        options: chartOpts('Predicted price', fmtPrice),
      }
    );
  }

  // ---- Chart 3: Actual Price ----
  const priceSeries = obs.price_series;
  if (priceSeries && priceSeries.length > 1) {
    const labels = elapsedLabels(priceSeries, origin);
    const data   = priceSeries.map(([, v]) => v);
    _charts.price = new Chart(
      ctx('imp-chart-price'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor: 'rgba(0,212,255,0.85)', borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false },
            refLine(labels, obs.entry_price, 'rgba(122,132,153,0.5)', 'Entry'),
            ...(obs.final_expected_price != null
              ? [refLine(labels, obs.final_expected_price, 'rgba(255,157,0,0.6)', 'Model stop')]
              : []),
            ...cascadeAnnotations(cascadeEvents, priceSeries, origin),
          ],
        },
        options: chartOpts('Price', fmtPrice),
      }
    );
  }

  // ---- Chart 4: LIQ Remaining (depleting tank) ----
  const liqSeries = obs.liq_remaining_series;
  if (liqSeries && liqSeries.length > 1) {
    const labels    = elapsedLabels(liqSeries, origin);
    const data      = liqSeries.map(([, v]) => v);
    const fillColor = obs.side === 'long' ? 'rgba(255,61,90,0.18)' : 'rgba(0,230,118,0.18)';
    const lineColor = obs.side === 'long' ? 'rgba(255,61,90,0.85)'  : 'rgba(0,230,118,0.85)';
    _charts.tank = new Chart(
      ctx('imp-chart-tank'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor: lineColor, borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: 'origin', backgroundColor: fillColor },
            refLine(labels, 0, 'rgba(122,132,153,0.35)', 'Exhausted'),
            ...cascadeAnnotations(cascadeEvents, liqSeries, origin),
          ],
        },
        options: chartOpts('LIQ remaining (USD)', fmtUSD),
      }
    );
  }
}

// ---- chart helpers ----

type TimeSeries = [number, number][];

function elapsedLabels(series: TimeSeries, origin: number): string[] {
  return series.map(([t]) => ((t - origin) / 1000).toFixed(1) + 's');
}

/** Build vertical-line markers for cascade join events as thin scatter points */
function cascadeAnnotations(
  events: [number, number, string][],
  series: TimeSeries,
  origin: number,
): object[] {
  if (events.length <= 1 || series.length === 0) return [];

  // For each cascade event after the first, find the closest series label index
  // and inject a vertical scatter marker at that x position.
  const labels = elapsedLabels(series, origin);

  return events.slice(1).map(([ts, vol]) => {
    const elapsed = ((ts - origin) / 1000).toFixed(1) + 's';
    // Find nearest label
    const idx = labels.findIndex(l => parseFloat(l) >= parseFloat(elapsed));
    const targetLabel = idx >= 0 ? labels[idx] : labels[labels.length - 1];
    // Build a point dataset that only has a value at the marker position
    const pointData = labels.map(l => (l === targetLabel ? 0 : null));
    return {
      type: 'scatter',
      label: '+' + fmtUSD(vol),
      data: pointData,
      pointRadius: 8,
      pointStyle: 'line',
      rotation: 90,
      borderColor: 'rgba(255,157,0,0.7)',
      borderWidth: 1.5,
      fill: false,
      parsing: false,
    };
  });
}

function refLine(labels: string[], value: number, color: string, _label: string): object {
  return {
    data: labels.map(() => value),
    borderColor: color,
    borderWidth: 1,
    borderDash: [4, 4],
    pointRadius: 0,
    tension: 0,
    fill: false,
  };
}

function chartOpts(yLabel: string, tickFmt: (v: number) => string): object {
  return {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0e1014',
        borderColor: '#1f2430',
        borderWidth: 1,
        titleColor: '#e2e8f0',
        bodyColor: '#7a8499',
        callbacks: { label: (item: any) => `${yLabel}: ${tickFmt(item.raw)}` },
      },
    },
    scales: {
      x: {
        ticks: { color: '#3d4455', font: { size: 9 }, maxTicksLimit: 8, maxRotation: 0 },
        grid: { color: '#1a1e2a' },
      },
      y: {
        ticks: { color: '#3d4455', font: { size: 9 }, callback: tickFmt },
        grid: { color: '#1a1e2a' },
      },
    },
  };
}

function ctx(id: string): CanvasRenderingContext2D {
  return (document.getElementById(id) as HTMLCanvasElement).getContext('2d')!;
}

// ---- misc helpers ----

function sizeBadge(n: number): string {
  if (n === 1) return `<span class="imp-badge gray">${n}</span>`;
  if (n === 2) return `<span class="imp-badge yellow">${n}</span>`;
  if (n === 3) return `<span class="imp-badge orange">${n}</span>`;
  return `<span class="imp-badge red">${n}</span>`;
}

function errColor(pct: number | null): string {
  if (pct == null) return 'var(--text-faint)';
  const a = Math.abs(pct);
  if (a < 0.1) return 'var(--green)';
  if (a < 0.3) return 'var(--yellow)';
  return 'var(--red)';
}

function setText(id: string, val: string): void {
  const e = document.getElementById(id);
  if (e) e.textContent = val;
}
