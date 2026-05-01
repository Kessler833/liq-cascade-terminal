/**
 * impact.ts — Impact tab: table, stats, filters, pagination, detail charts.
 *
 * v2 additions:
 *   - lambda_ratio_at_onset column in table
 *   - l2_structural_price shown in detail header (structural vs corrected prediction)
 *   - lambda ratio colour-coded: green ≤ 1.5x, yellow ≤ 3x, red > 3x
 */

import type { ImpactObs, ImpactStats } from './state';
import { fmtUSD, fmtDelta, fmtPrice, fmtPct, el } from './utils';
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
const _checkedIds = new Set<string>();
const _deletedIds = new Set<string>();

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

  document.getElementById('imp-chk-all')?.addEventListener('change', e => {
    const checked = (e.target as HTMLInputElement).checked;
    currentPageObs().forEach(o => checked ? _checkedIds.add(o.id) : _checkedIds.delete(o.id));
    renderTable();
    syncDeleteBtn();
  });

  document.getElementById('imp-delete-btn')?.addEventListener('click', deleteSelected);
}

export function updateImpact(obs: ImpactObs[], stats: ImpactStats): void {
  _stats = stats;
  const incoming = new Map<string, ImpactObs>(obs.map(o => [o.id, o]));

  for (let i = 0; i < _allObs.length; i++) {
    const fresh = incoming.get(_allObs[i].id);
    if (fresh) _allObs[i] = fresh;
  }

  const existingIds = new Set(_allObs.map(o => o.id));
  const newEntries  = obs.filter(o => !existingIds.has(o.id) && !_deletedIds.has(o.id));
  if (newEntries.length) _allObs = [...newEntries, ..._allObs];

  if (_deletedIds.size) {
    _allObs = _allObs.filter(o => !_deletedIds.has(o.id));
  }

  renderStats();
  renderTable();

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

// ---- selection ----

function currentPageObs(): ImpactObs[] {
  const rows  = filtered();
  const start = (_page - 1) * PAGE_SIZE;
  return rows.slice(start, start + PAGE_SIZE);
}

function syncDeleteBtn(): void {
  const btn     = document.getElementById('imp-delete-btn');
  const countEl = document.getElementById('imp-delete-count');
  const n       = _checkedIds.size;
  if (btn)     btn.classList.toggle('visible', n > 0);
  if (countEl) countEl.textContent = String(n);

  const allChk = document.getElementById('imp-chk-all') as HTMLInputElement | null;
  if (!allChk) return;
  const page            = currentPageObs();
  const checkedOnPage   = page.filter(o => _checkedIds.has(o.id)).length;
  if (checkedOnPage === 0) {
    allChk.checked = false; allChk.indeterminate = false;
  } else if (checkedOnPage === page.length) {
    allChk.checked = true; allChk.indeterminate = false;
  } else {
    allChk.checked = false; allChk.indeterminate = true;
  }
}

async function deleteSelected(): Promise<void> {
  if (_checkedIds.size === 0) return;
  const ids = [..._checkedIds];
  ids.forEach(id => _deletedIds.add(id));
  _allObs = _allObs.filter(o => !_checkedIds.has(o.id));
  if (_selectedId && _checkedIds.has(_selectedId)) closeDetail();
  _checkedIds.clear();
  _page = 1;
  renderStats(); renderTable(); syncDeleteBtn();
  try {
    await api.deleteImpact(ids);
  } catch (err) {
    console.error('[impact] deleteImpact failed:', err);
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

function deltaInFavour(side: string, delta: number): boolean {
  if (side === 'long')  return delta < 0;
  if (side === 'short') return delta > 0;
  return false;
}

function finalExpMatchesEnd(obs: ImpactObs): boolean {
  if (obs.final_expected_price == null || obs.tank_empty_price == null) return true;
  const ref = obs.tank_empty_price;
  if (ref === 0) return true;
  const pctDiff = Math.abs(obs.final_expected_price - ref) / ref;
  return pctDiff < 0.005;
}

/** Colour for lambda ratio: green ≤ 1.5x normal, yellow ≤ 3x, red > 3x */
function lambdaColor(ratio: number | null): string {
  if (ratio == null) return 'var(--text-faint)';
  if (ratio <= 1.5)  return 'var(--text-muted)';
  if (ratio <= 3.0)  return 'var(--yellow)';
  return 'var(--red)';
}

function fmtLambdaRatio(ratio: number | null): string {
  if (ratio == null) return '—';
  return ratio.toFixed(2) + 'x';
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
    const isChecked = _checkedIds.has(obs.id);
    const tr = el('tr', 'imp-row'
      + (_selectedId === obs.id ? ' active' : '')
      + (isChecked ? ' selected' : ''));
    tr.dataset.id = obs.id;

    const isRec     = obs.label_filled === 0;
    const sideColor = obs.side === 'long' ? 'var(--green)' : 'var(--red)';

    const delta        = obs.initial_delta ?? 0;
    const deltaFavour  = deltaInFavour(obs.side, delta);
    const deltaColor   = deltaFavour ? 'var(--green)' : 'var(--red)';

    const finalExpGood  = finalExpMatchesEnd(obs);
    const finalExpColor = (obs.final_expected_price == null)
      ? 'var(--text-faint)'
      : finalExpGood ? 'var(--text-muted)' : 'var(--red)';

    const ts        = new Date(obs.timestamp);
    const timeStr   = ts.toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const cutoffBadge = (isRec && obs.beyond_cutoff)
      ? ' <span class="imp-badge amber" title="Terminal estimate crossed book depth cutoff">CUTOFF</span>'
      : '';

    const diffFmt  = obs.price_difference != null
      ? (obs.price_difference >= 0 ? '+' : '') + fmtPrice(Math.abs(obs.price_difference))
      : '—';
    const diffExpected = obs.side === 'long'
      ? (obs.price_difference ?? 0) < 0
      : (obs.price_difference ?? 0) > 0;
    const diffColor = obs.price_difference == null
      ? 'var(--text-faint)'
      : diffExpected ? 'var(--green)' : 'var(--red)';

    const durFmt = obs.cascade_duration_s != null
      ? obs.cascade_duration_s.toFixed(1) + 's'
      : isRec ? 'recording…' : '—';

    const lamColor = lambdaColor(obs.lambda_ratio_at_onset);
    const lamFmt   = fmtLambdaRatio(obs.lambda_ratio_at_onset);

    const tdChk = el('td', 'imp-td imp-td-check');
    const chk   = document.createElement('input');
    chk.type      = 'checkbox';
    chk.className = 'imp-chk';
    chk.checked   = isChecked;
    chk.addEventListener('change', e => {
      e.stopPropagation();
      if ((e.target as HTMLInputElement).checked) {
        _checkedIds.add(obs.id); tr.classList.add('selected');
      } else {
        _checkedIds.delete(obs.id); tr.classList.remove('selected');
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
      <td class="imp-td mono" style="color:${deltaColor}">${fmtDelta(delta)}</td>
      <td class="imp-td mono" style="color:${lamColor}" title="Kyle's lambda ratio at cascade onset">${lamFmt}</td>
      <td class="imp-td mono">${fmtPrice(obs.initial_expected_price)}</td>
      <td class="imp-td mono" style="color:${finalExpColor}">${obs.final_expected_price ? fmtPrice(obs.final_expected_price) : '—'}</td>
      <td class="imp-td mono" style="color:var(--text-muted)">${fmtPrice(obs.entry_price)}</td>
      <td class="imp-td mono" style="color:var(--text-muted)">${obs.tank_empty_price ? fmtPrice(obs.tank_empty_price) : '—'}</td>
      <td class="imp-td mono" style="color:${diffColor}">${diffFmt}</td>
      <td class="imp-td mono" style="color:${errColor(obs.price_error_pct)}">${fmtPct(obs.price_error_pct)}</td>
      <td class="imp-td mono" style="color:var(--text-muted)">${durFmt}</td>
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

  if (wasOpen) {
    const current = _allObs.find(o => o.id === id);
    if (current) renderDetailCharts(current);
  } else {
    setTimeout(() => {
      if (_selectedId !== id) return;
      const current = _allObs.find(o => o.id === _selectedId);
      if (current) renderDetailCharts(current);
    }, PANEL_OPEN_DELAY_MS);
  }
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

  // ── Lambda context ───────────────────────────────────────────────────────
  let lamEl = document.getElementById('det-imp-lambda');
  if (!lamEl) {
    // Inject into det-meta if not in HTML yet
    const meta = document.querySelector('.imp-det-meta');
    if (meta) {
      const kv = document.createElement('div');
      kv.className = 'imp-det-kv';
      kv.innerHTML = `<span class="imp-det-k">λ Ratio</span><span class="imp-det-v" id="det-imp-lambda">—</span>`;
      meta.appendChild(kv);
      lamEl = document.getElementById('det-imp-lambda');
    }
  }
  if (lamEl) {
    lamEl.textContent = fmtLambdaRatio(obs.lambda_ratio_at_onset);
    lamEl.style.color = lambdaColor(obs.lambda_ratio_at_onset);
  }

  // ── L2 structural vs corrected ───────────────────────────────────────────
  let structEl = document.getElementById('det-imp-structural');
  if (!structEl) {
    const meta = document.querySelector('.imp-det-meta');
    if (meta) {
      const kv = document.createElement('div');
      kv.className = 'imp-det-kv';
      kv.innerHTML = `<span class="imp-det-k">L2 Struct.</span><span class="imp-det-v" id="det-imp-structural" style="color:var(--text-faint)">—</span>`;
      meta.appendChild(kv);
      structEl = document.getElementById('det-imp-structural');
    }
  }
  if (structEl) {
    structEl.textContent = obs.l2_structural_price != null ? fmtPrice(obs.l2_structural_price) : '—';
  }
}

function renderCutoffBanner(obs: ImpactObs): void {
  let banner = document.getElementById('imp-cutoff-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'imp-cutoff-banner';
    banner.style.cssText = [
      'display:none','align-items:center','gap:8px','padding:6px 14px',
      'background:rgba(255,157,0,0.10)','border-bottom:1px solid rgba(255,157,0,0.35)',
      'font-size:11px','color:#ffa040','font-family:monospace',
      'animation:imp-cutoff-pulse 1.6s ease-in-out infinite','flex-shrink:0',
    ].join(';');
    if (!document.getElementById('imp-cutoff-keyframes')) {
      const style = document.createElement('style');
      style.id = 'imp-cutoff-keyframes';
      style.textContent = `
        @keyframes imp-cutoff-pulse { 0%,100%{opacity:1} 50%{opacity:0.55} }
        .imp-badge.amber {
          background:rgba(255,157,0,0.18); color:#ffa040;
          border:1px solid rgba(255,157,0,0.35); padding:1px 5px;
          border-radius:3px; font-size:9px; font-weight:700; letter-spacing:0.05em;
          animation:imp-cutoff-pulse 1.6s ease-in-out infinite;
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
      <span><strong>Beyond book depth</strong> — prediction crossed data cutoff at
      <strong>${priceStr}</strong>. Estimate extrapolated, less reliable.</span>`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

// ---- detail charts ----

function destroyCharts(): void {
  for (const c of Object.values(_charts)) c?.destroy?.();
  _charts = {};
  for (const id of ['imp-chart-delta', 'imp-chart-price-exp', 'imp-chart-tank', 'imp-chart-lambda']) {
    const canvas = document.getElementById(id) as HTMLCanvasElement | null;
    if (canvas) { const c2d = canvas.getContext('2d'); if (c2d) c2d.clearRect(0, 0, canvas.width, canvas.height); }
  }
}

function getCanvas(id: string): HTMLCanvasElement | null {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null;
  if (!canvas) return null;
  if (typeof Chart !== 'undefined') Chart.getChart(canvas)?.destroy();
  return canvas;
}

type TimeSeries = [number, number][];

function elapsedLabels(series: TimeSeries, origin: number): string[] {
  return series.map(([t]) => ((t - origin) / 1000).toFixed(1) + 's');
}

function refLine(labels: string[], value: number, color: string): object {
  return {
    data: labels.map(() => value),
    borderColor: color, borderWidth: 1, borderDash: [4, 4],
    pointRadius: 0, tension: 0, fill: false,
  };
}

function cascadeLinePlugin(
  events: [number, number, string][],
  series: TimeSeries,
  origin: number,
): object {
  if (events.length <= 1 || !series.length) return {};
  const labels = elapsedLabels(series, origin);
  const joinIndices: number[] = events.slice(1).map(([ts]) => {
    const elapsed = ((ts - origin) / 1000).toFixed(1) + 's';
    const idx = labels.findIndex(l => parseFloat(l) >= parseFloat(elapsed));
    return idx >= 0 ? idx : labels.length - 1;
  });
  return {
    id: 'cascadeLines',
    afterDraw(chart: any) {
      const ctx   = chart.ctx as CanvasRenderingContext2D;
      const xAxis = chart.scales['x'];
      const yAxis = chart.scales['y'];
      if (!xAxis || !yAxis) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,157,0,0.55)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([3, 4]);
      for (let i = 0; i < joinIndices.length; i++) {
        const idx = joinIndices[i];
        const x   = xAxis.getPixelForTick(idx);
        if (x == null || isNaN(x)) continue;
        ctx.beginPath();
        ctx.moveTo(x, yAxis.top);
        ctx.lineTo(x, yAxis.bottom);
        ctx.stroke();
        const vol = events[i + 1][1];
        ctx.fillStyle = 'rgba(255,157,0,0.75)';
        ctx.font = '9px monospace';
        ctx.fillText('+' + fmtUSD(vol), x + 3, yAxis.top + 10);
      }
      ctx.restore();
    },
  };
}

function chartOpts(yLabel: string, tickFmt: (v: number) => string): object {
  return {
    animation: false, responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0e1014', borderColor: '#1f2430', borderWidth: 1,
        titleColor: '#e2e8f0', bodyColor: '#7a8499',
        callbacks: { label: (item: any) => `${yLabel}: ${tickFmt(item.raw)}` },
      },
    },
    scales: {
      x: { ticks: { color: '#3d4455', font: { size: 9 }, maxTicksLimit: 6, maxRotation: 0 }, grid: { color: '#1a1e2a' } },
      y: { ticks: { color: '#3d4455', font: { size: 9 }, callback: tickFmt }, grid: { color: '#1a1e2a' } },
    },
  };
}

function renderDetailCharts(obs: ImpactObs): void {
  if (typeof Chart === 'undefined') return;
  destroyCharts();

  const origin        = obs.timestamp;
  const cascadeEvents = obs.cascade_events ?? [];

  // Chart 1: delta
  const deltaSeries = obs.delta_series;
  if (deltaSeries && deltaSeries.length >= 1) {
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
              data, borderWidth: 1.5, pointRadius: 0, tension: 0.3,
              fill: { target: { value: 0 }, above: 'rgba(255,61,90,0.07)', below: 'rgba(0,230,118,0.07)' },
              segment: { borderColor: (c: any) => c.p0.parsed.y <= 0 ? 'rgba(0,230,118,0.8)' : 'rgba(255,61,90,0.8)' },
            },
            refLine(labels, 0, 'rgba(122,132,153,0.3)'),
          ],
        },
        options: chartOpts('Delta tick (USD)', fmtUSD),
        plugins: [cascadeLinePlugin(cascadeEvents, deltaSeries, origin)],
      });
    }
  }

  // Chart 2: predicted vs actual price
  const expSeries   = obs.expected_price_series;
  const priceSeries = obs.price_series;

  if ((expSeries && expSeries.length >= 1) || (priceSeries && priceSeries.length >= 1)) {
    const longerSeries = (expSeries?.length ?? 0) >= (priceSeries?.length ?? 0)
      ? expSeries! : priceSeries!;
    const labels    = elapsedLabels(longerSeries, origin);
    const sideColor = obs.side === 'long' ? 'rgba(255,61,90,0.9)' : 'rgba(0,230,118,0.9)';

    const priceData: (number | null)[] = labels.map((_, i) =>
      priceSeries && i < priceSeries.length ? priceSeries[i][1] : null);
    const expData: (number | null)[] = labels.map((_, i) =>
      expSeries && i < expSeries.length ? expSeries[i][1] : null);

    // L2 structural as a reference line (where book alone predicted)
    const structuralRef = obs.l2_structural_price != null
      ? [refLine(labels, obs.l2_structural_price, 'rgba(168,85,247,0.35)')]
      : [];

    const canvas = getCanvas('imp-chart-price-exp');
    if (canvas) {
      _charts.priceExp = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Actual',    data: priceData, borderColor: 'rgba(0,212,255,0.9)',  borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false, spanGaps: true },
            { label: 'Predicted', data: expData,   borderColor: sideColor,              borderWidth: 2, pointRadius: 0, tension: 0.25, fill: false, spanGaps: true },
            refLine(labels, obs.entry_price, 'rgba(122,132,153,0.4)'),
            ...(obs.tank_empty_price != null ? [refLine(labels, obs.tank_empty_price, 'rgba(255,157,0,0.55)')] : []),
            ...(obs.final_expected_price != null ? [refLine(labels, obs.final_expected_price, 'rgba(168,85,247,0.4)')] : []),
            ...structuralRef,
          ],
        },
        options: {
          animation: false, responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: true, labels: { color: '#7a8499', font: { size: 9 }, boxWidth: 20, padding: 6, filter: (item: any) => item.datasetIndex < 2 } },
            tooltip: {
              backgroundColor: '#0e1014', borderColor: '#1f2430', borderWidth: 1,
              titleColor: '#e2e8f0', bodyColor: '#7a8499',
              callbacks: { label: (item: any) => { if (item.raw == null) return null; const names = ['Actual','Predicted']; const name = names[item.datasetIndex]; return name ? `${name}: ${fmtPrice(item.raw)}` : fmtPrice(item.raw); } },
            },
          },
          scales: {
            x: { ticks: { color: '#3d4455', font: { size: 9 }, maxTicksLimit: 6, maxRotation: 0 }, grid: { color: '#1a1e2a' } },
            y: { ticks: { color: '#3d4455', font: { size: 9 }, callback: fmtPrice }, grid: { color: '#1a1e2a' } },
          },
        },
        plugins: [cascadeLinePlugin(cascadeEvents, longerSeries, origin)],
      });
    }
  }

  // Chart 3: liq remaining tank
  const liqSeries = obs.liq_remaining_series;
  if (liqSeries && liqSeries.length >= 1) {
    const labels    = elapsedLabels(liqSeries, origin);
    const data      = liqSeries.map(([, v]) => v);
    const fillColor = obs.side === 'long' ? 'rgba(255,61,90,0.18)' : 'rgba(0,230,118,0.18)';
    const lineColor = obs.side === 'long' ? 'rgba(255,61,90,0.85)' : 'rgba(0,230,118,0.85)';
    const canvas    = getCanvas('imp-chart-tank');
    if (canvas) {
      _charts.tank = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor: lineColor, borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: 'origin', backgroundColor: fillColor },
            refLine(labels, 0, 'rgba(122,132,153,0.35)'),
          ],
        },
        options: chartOpts('LIQ remaining (USD)', fmtUSD),
        plugins: [cascadeLinePlugin(cascadeEvents, liqSeries, origin)],
      });
    }
  }

  // ── Chart 4: Kyle's lambda ratio over cascade ─────────────────────────────
  const lambdaSeries = obs.lambda_series;
  if (lambdaSeries && lambdaSeries.length >= 1) {
    const labels = elapsedLabels(lambdaSeries, origin);
    const data   = lambdaSeries.map(([, v]) => v);
    const canvas = getCanvas('imp-chart-lambda');
    if (canvas) {
      _charts.lambda = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              data,
              borderColor:     'rgba(255,157,0,0.9)',
              borderWidth:     1.5,
              pointRadius:     0,
              tension:         0.3,
              fill:            { target: { value: 1.0 }, above: 'rgba(255,157,0,0.08)', below: 'rgba(0,212,255,0.06)' },
              segment: {
                borderColor: (c: any) => c.p0.parsed.y > 1.0
                  ? 'rgba(255,157,0,0.9)'
                  : 'rgba(0,212,255,0.7)',
              },
            },
            // Baseline at 1.0
            refLine(labels, 1.0, 'rgba(122,132,153,0.4)'),
            // Cascade threshold at ~4.0 (approximate visual guide)
            refLine(labels, 4.0, 'rgba(255,61,90,0.25)'),
          ],
        },
        options: {
          ...chartOpts('λ ratio', (v: number) => v.toFixed(2) + 'x'),
          plugins: {
            ...(chartOpts('λ ratio', (v: number) => v.toFixed(2) + 'x') as any).plugins,
            annotation: undefined,
          },
        },
        plugins: [cascadeLinePlugin(cascadeEvents, lambdaSeries, origin)],
      });
    }
  }
}

// ---- helpers ----

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
