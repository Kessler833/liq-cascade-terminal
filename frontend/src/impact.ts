/**
 * impact.ts — Impact tab rendering: table, stats, filters, pagination, detail charts.
 * Chart.js is loaded as a CDN global in index.html.
 */

import type { ImpactObs, ImpactStats } from './state';
import { fmtUSD, fmtPrice, fmtPct, el } from './utils';
import { api } from './api';

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

// ---- selection state ----
const _checkedIds = new Set<string>();

// Track which IDs were optimistically deleted so the next WS broadcast
// (which only carries the last 50 rows) doesn't re-add them before the
// backend confirms the delete via a full sync.
const _pendingDeleteIds = new Set<string>();

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

  // Select-all checkbox
  document.getElementById('imp-chk-all')?.addEventListener('change', e => {
    const checked = (e.target as HTMLInputElement).checked;
    const page = currentPageObs();
    page.forEach(o => checked ? _checkedIds.add(o.id) : _checkedIds.delete(o.id));
    renderTable();
    syncDeleteBtn();
  });

  // Delete button
  document.getElementById('imp-delete-btn')?.addEventListener('click', deleteSelected);
}

/**
 * Called on every WS impact_update message.
 *
 * The server sends only the most recent 50 observations to keep the socket
 * payload small. We must NOT replace _allObs wholesale — that would discard
 * the older rows the frontend already holds.
 *
 * Merge strategy:
 *   1. Build a map of incoming observations keyed by id.
 *   2. Update-in-place any existing entry whose id matches (e.g. a recording
 *      obs that just closed and now has final_expected_price filled in).
 *   3. Prepend any brand-new ids that aren't in _allObs yet.
 *   4. Strip out any ids still in _pendingDeleteIds (ghost guard: the WS
 *      confirmation of a delete we already applied optimistically).
 */
export function updateImpact(obs: ImpactObs[], stats: ImpactStats): void {
  _stats = stats;

  // Build incoming map for O(1) lookup
  const incoming = new Map<string, ImpactObs>(obs.map(o => [o.id, o]));

  // 1. Update existing entries in-place
  for (let i = 0; i < _allObs.length; i++) {
    const fresh = incoming.get(_allObs[i].id);
    if (fresh) _allObs[i] = fresh;
  }

  // 2. Prepend genuinely new entries (not already in _allObs)
  const existingIds = new Set(_allObs.map(o => o.id));
  const newEntries  = obs.filter(o => !existingIds.has(o.id));
  if (newEntries.length) _allObs = [...newEntries, ..._allObs];

  // 3. Remove anything still pending deletion (guard against WS echo)
  if (_pendingDeleteIds.size) {
    _allObs = _allObs.filter(o => !_pendingDeleteIds.has(o.id));
  }

  renderStats();
  renderTable();

  // Live-refresh open detail panel
  if (_selectedId) {
    const current = _allObs.find(o => o.id === _selectedId);
    if (current) {
      fillDetailHeader(current);
      renderCutoffBanner(current);
      renderDetailCharts(current);
    }
  }

  const empty = document.getElementById('imp-empty-state');
  if (empty) empty.style.display = _allObs.length === 0 ? 'flex' : 'none';
}

// ---- selection helpers ----

function currentPageObs(): ImpactObs[] {
  const rows  = filtered();
  const start = (_page - 1) * PAGE_SIZE;
  return rows.slice(start, start + PAGE_SIZE);
}

function syncDeleteBtn(): void {
  const btn = document.getElementById('imp-delete-btn');
  const countEl = document.getElementById('imp-delete-count');
  const n = _checkedIds.size;
  if (btn)     btn.classList.toggle('visible', n > 0);
  if (countEl) countEl.textContent = String(n);

  // Sync select-all checkbox state
  const allChk = document.getElementById('imp-chk-all') as HTMLInputElement | null;
  if (!allChk) return;
  const page = currentPageObs();
  const checkedOnPage = page.filter(o => _checkedIds.has(o.id)).length;
  if (checkedOnPage === 0) {
    allChk.checked       = false;
    allChk.indeterminate = false;
  } else if (checkedOnPage === page.length) {
    allChk.checked       = true;
    allChk.indeterminate = false;
  } else {
    allChk.checked       = false;
    allChk.indeterminate = true;
  }
}

async function deleteSelected(): Promise<void> {
  if (_checkedIds.size === 0) return;

  const ids = [..._checkedIds];

  // Mark as pending so the imminent WS echo doesn't re-add them
  ids.forEach(id => _pendingDeleteIds.add(id));

  // Optimistic: remove from local view immediately so the UI feels instant
  _allObs = _allObs.filter(o => !_checkedIds.has(o.id));
  if (_selectedId && _checkedIds.has(_selectedId)) closeDetail();
  _checkedIds.clear();

  // Reset to page 1 so we never land on a now-empty ghost page
  _page = 1;

  renderStats();
  renderTable();
  syncDeleteBtn();

  // Persist to backend
  try {
    await api.deleteImpact(ids);
    // Backend confirmed — safe to clear the pending guard
    ids.forEach(id => _pendingDeleteIds.delete(id));
  } catch (err) {
    console.error('[impact] deleteImpact API call failed:', err);
    // Keep _pendingDeleteIds populated — WS will re-sync state
    // and the guard will keep the UI consistent until that happens.
  }
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
    const isChecked  = _checkedIds.has(obs.id);
    const tr = el('tr', 'imp-row' + (_selectedId === obs.id ? ' active' : '') + (isChecked ? ' selected' : ''));
    tr.dataset.id = obs.id;

    const isRec      = obs.label_filled === 0;
    const sideColor  = obs.side === 'long' ? 'var(--green)' : 'var(--red)';
    const deltaColor = (obs.initial_delta ?? 0) <= 0 ? 'var(--green)' : 'var(--red)';
    const ts         = new Date(obs.timestamp);
    const timeStr    = ts.toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const cutoffBadge = (isRec && obs.beyond_cutoff)
      ? ' <span class="imp-badge amber" title="Terminal price estimate crossed book depth cutoff — fewer exchanges contributing">CUTOFF</span>'
      : '';

    // Checkbox cell
    const tdChk = el('td', 'imp-td imp-td-check');
    const chk   = document.createElement('input');
    chk.type    = 'checkbox';
    chk.className = 'imp-chk';
    chk.checked   = isChecked;
    chk.addEventListener('change', e => {
      e.stopPropagation();
      if ((e.target as HTMLInputElement).checked) {
        _checkedIds.add(obs.id);
        tr.classList.add('selected');
      } else {
        _checkedIds.delete(obs.id);
        tr.classList.remove('selected');
      }
      syncDeleteBtn();
    });
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    tr.insertAdjacentHTML('beforeend', `
      <td class="imp-td"><span class="imp-dot ${isRec ? 'recording' : 'complete'}"></span>${cutoffBadge}</td>
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
    `);
    tr.addEventListener('click', () => openDetail(obs.id));
    tbody.appendChild(tr);
  }

  syncDeleteBtn();
}

// ---- detail panel ----

const PANEL_OPEN_DELAY_MS = 280;

function openDetail(id: string): void {
  if (_selectedId === id) { closeDetail(); return; }

  const obs = _allObs.find(o => o.id === id);
  if (!obs) return;

  const wasOpen = _selectedId !== null;
  _selectedId = id;

  document.querySelectorAll('.imp-row').forEach(r =>
    r.classList.toggle('active', (r as HTMLElement).dataset.id === id)
  );
  document.getElementById('imp-detail')?.classList.add('open');

  fillDetailHeader(obs);
  renderCutoffBanner(obs);

  const delay = wasOpen ? 0 : PANEL_OPEN_DELAY_MS;
  setTimeout(() => {
    if (_selectedId !== id) return;
    const current = _allObs.find(o => o.id === _selectedId);
    if (current) renderDetailCharts(current);
  }, delay);
}

function closeDetail(): void {
  _selectedId = null;
  document.getElementById('imp-detail')?.classList.remove('open');
  document.querySelectorAll('.imp-row').forEach(r => r.classList.remove('active'));
  destroyCharts();
  const banner = document.getElementById('imp-cutoff-banner');
  if (banner) banner.style.display = 'none';
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

// ---- cutoff banner ----

function renderCutoffBanner(obs: ImpactObs): void {
  let banner = document.getElementById('imp-cutoff-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'imp-cutoff-banner';
    banner.style.cssText = [
      'display:none',
      'align-items:center',
      'gap:8px',
      'padding:6px 14px',
      'background:rgba(255,157,0,0.10)',
      'border-bottom:1px solid rgba(255,157,0,0.35)',
      'font-size:11px',
      'color:#ffa040',
      'font-family:monospace',
      'animation:imp-cutoff-pulse 1.6s ease-in-out infinite',
      'flex-shrink:0',
    ].join(';');

    if (!document.getElementById('imp-cutoff-keyframes')) {
      const style = document.createElement('style');
      style.id = 'imp-cutoff-keyframes';
      style.textContent = `
        @keyframes imp-cutoff-pulse {
          0%,100% { opacity:1; }
          50%      { opacity:0.55; }
        }
        .imp-badge.amber {
          background: rgba(255,157,0,0.18);
          color: #ffa040;
          border: 1px solid rgba(255,157,0,0.35);
          padding: 1px 5px;
          border-radius: 3px;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.05em;
          animation: imp-cutoff-pulse 1.6s ease-in-out infinite;
        }
      `;
      document.head.appendChild(style);
    }

    const header = document.getElementById('imp-detail-header');
    if (header) header.insertAdjacentElement('afterend', banner);
  }

  if (obs.beyond_cutoff && obs.label_filled === 0) {
    const priceStr = obs.cutoff_price != null ? fmtPrice(obs.cutoff_price) : 'unknown';
    banner.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffa040" stroke-width="2" style="flex-shrink:0">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>
        <strong>Beyond book depth</strong> — prediction crossed data cutoff at
        <strong>${priceStr}</strong>. Fewer than all exchanges contribute below
        this level; estimate is extrapolated and less reliable.
      </span>
    `;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

// ---- detail charts ----

function destroyCharts(): void {
  for (const c of Object.values(_charts)) c?.destroy?.();
  _charts = {};
  for (const id of ['imp-chart-delta', 'imp-chart-expected', 'imp-chart-price', 'imp-chart-tank']) {
    const canvas = document.getElementById(id) as HTMLCanvasElement | null;
    if (canvas) {
      const c2d = canvas.getContext('2d');
      if (c2d) c2d.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
}

function getCanvas(id: string): HTMLCanvasElement | null {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null;
  if (!canvas) return null;
  if (typeof Chart !== 'undefined') {
    Chart.getChart(canvas)?.destroy();
  }
  return canvas;
}

function renderDetailCharts(obs: ImpactObs): void {
  if (typeof Chart === 'undefined') return;
  destroyCharts();

  const origin        = obs.timestamp;
  const cascadeEvents = obs.cascade_events ?? [];

  const deltaSeries = obs.delta_series;
  if (deltaSeries && deltaSeries.length > 1) {
    const labels = elapsedLabels(deltaSeries, origin);
    const data   = deltaSeries.map(([, v]) => v);
    const canvas = getCanvas('imp-chart-delta');
    if (canvas) {
      _charts.delta = new Chart(canvas, {
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
            refLine(labels, 0, 'rgba(122,132,153,0.3)'),
            ...cascadeAnnotations(cascadeEvents, deltaSeries, origin),
          ],
        },
        options: chartOpts('Delta (USD)', fmtUSD),
      });
    }
  }

  const expSeries = obs.expected_price_series;
  if (expSeries && expSeries.length > 1) {
    const labels        = elapsedLabels(expSeries, origin);
    const data          = expSeries.map(([, v]) => v);
    const sideLineColor = obs.side === 'long' ? 'rgba(255,61,90,0.85)' : 'rgba(0,230,118,0.85)';

    const cutoffDatasets: object[] = [];
    if (obs.cutoff_price != null) {
      cutoffDatasets.push(refLine(labels, obs.cutoff_price, 'rgba(255,157,0,0.75)'));
      const crossIdx = data.findIndex(v =>
        obs.side === 'long' ? v < obs.cutoff_price! : v > obs.cutoff_price!
      );
      if (crossIdx >= 0) {
        const crossPointData = labels.map((_, i) => i === crossIdx ? obs.cutoff_price : null);
        cutoffDatasets.push({
          type: 'scatter',
          label: 'Cutoff crossed',
          data: crossPointData,
          pointRadius: labels.map((_, i) => i === crossIdx ? 10 : 0),
          pointStyle: 'line',
          rotation: 90,
          borderColor: 'rgba(255,157,0,0.9)',
          borderWidth: 2,
          fill: false,
          parsing: false,
        });
      }
    }

    const canvas = getCanvas('imp-chart-expected');
    if (canvas) {
      const opts = chartOptsWithCutoffPlugin('Predicted price', fmtPrice, obs.cutoff_price, labels) as any;
      const instancePlugins: object[] = [];
      if (opts._cutoffPlugin) {
        instancePlugins.push(opts._cutoffPlugin);
        delete opts._cutoffPlugin;
      }
      _charts.expected = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor: sideLineColor, borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false },
            refLine(labels, obs.entry_price, 'rgba(122,132,153,0.5)'),
            ...(obs.actual_terminal_price != null
              ? [refLine(labels, obs.actual_terminal_price, 'rgba(0,230,118,0.55)')]
              : []),
            ...cutoffDatasets,
            ...cascadeAnnotations(cascadeEvents, expSeries, origin),
          ],
        },
        options: opts,
        plugins: instancePlugins,
      });
    }
  }

  const priceSeries = obs.price_series;
  if (priceSeries && priceSeries.length > 1) {
    const labels = elapsedLabels(priceSeries, origin);
    const data   = priceSeries.map(([, v]) => v);
    const canvas = getCanvas('imp-chart-price');
    if (canvas) {
      _charts.price = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor: 'rgba(0,212,255,0.85)', borderWidth: 1.5, pointRadius: 0, tension: 0.25, fill: false },
            refLine(labels, obs.entry_price, 'rgba(122,132,153,0.5)'),
            ...(obs.final_expected_price != null
              ? [refLine(labels, obs.final_expected_price, 'rgba(255,157,0,0.6)')]
              : []),
            ...cascadeAnnotations(cascadeEvents, priceSeries, origin),
          ],
        },
        options: chartOpts('Price', fmtPrice),
      });
    }
  }

  const liqSeries = obs.liq_remaining_series;
  if (liqSeries && liqSeries.length > 1) {
    const labels    = elapsedLabels(liqSeries, origin);
    const data      = liqSeries.map(([, v]) => v);
    const fillColor = obs.side === 'long' ? 'rgba(255,61,90,0.18)' : 'rgba(0,230,118,0.18)';
    const lineColor = obs.side === 'long' ? 'rgba(255,61,90,0.85)'  : 'rgba(0,230,118,0.85)';
    const canvas = getCanvas('imp-chart-tank');
    if (canvas) {
      _charts.tank = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor: lineColor, borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: 'origin', backgroundColor: fillColor },
            refLine(labels, 0, 'rgba(122,132,153,0.35)'),
            ...cascadeAnnotations(cascadeEvents, liqSeries, origin),
          ],
        },
        options: chartOpts('LIQ remaining (USD)', fmtUSD),
      });
    }
  }
}

// ---- chart helpers ----

type TimeSeries = [number, number][];

function elapsedLabels(series: TimeSeries, origin: number): string[] {
  return series.map(([t]) => ((t - origin) / 1000).toFixed(1) + 's');
}

function cascadeAnnotations(
  events: [number, number, string][],
  series: TimeSeries,
  origin: number,
): object[] {
  if (events.length <= 1 || series.length === 0) return [];
  const labels = elapsedLabels(series, origin);
  return events.slice(1).map(([ts, vol]) => {
    const elapsed = ((ts - origin) / 1000).toFixed(1) + 's';
    const idx = labels.findIndex(l => parseFloat(l) >= parseFloat(elapsed));
    const targetLabel = idx >= 0 ? labels[idx] : labels[labels.length - 1];
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

function refLine(labels: string[], value: number, color: string): object {
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
        ticks: { color: '#3d4455', font: { size: 9 }, maxTicksLimit: 6, maxRotation: 0 },
        grid: { color: '#1a1e2a' },
      },
      y: {
        ticks: { color: '#3d4455', font: { size: 9 }, callback: tickFmt },
        grid: { color: '#1a1e2a' },
      },
    },
  };
}

function chartOptsWithCutoffPlugin(
  yLabel: string,
  tickFmt: (v: number) => string,
  cutoffPrice: number | null,
  labels: string[],
): object {
  const base = chartOpts(yLabel, tickFmt) as any;
  if (cutoffPrice == null) return base;

  base._cutoffPlugin = {
    id: 'cutoffRegion',
    afterDraw(chart: any) {
      if (cutoffPrice == null) return;
      const { ctx: c, scales: { x, y } } = chart;
      if (!x || !y) return;
      const mainDs = chart.data.datasets[0];
      if (!mainDs) return;
      const vals: (number | null)[] = mainDs.data;

      let crossIdx = -1;
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v == null) continue;
        if (v < cutoffPrice || v > cutoffPrice) { crossIdx = i; break; }
      }
      if (crossIdx < 0 || crossIdx >= labels.length) return;

      const xPos  = x.getPixelForIndex(crossIdx);
      const right = x.right;
      const top   = y.top;
      const bot   = y.bottom;

      c.save();
      c.fillStyle = 'rgba(255,157,0,0.06)';
      c.fillRect(xPos, top, right - xPos, bot - top);
      c.setLineDash([4, 4]);
      c.strokeStyle = 'rgba(255,157,0,0.7)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(xPos, top);
      c.lineTo(xPos, bot);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = 'rgba(255,157,0,0.9)';
      c.font = '9px monospace';
      c.textAlign = 'left';
      c.fillText('Book depth limit', xPos + 4, top + 12);
      c.restore();
    },
  };

  return base;
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
