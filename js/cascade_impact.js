// cascade_impact.js — Cascade Impact tab: recorder + table UI + detail charts
// Depends on: state.js, utils.js, l2_model.js
// Uses Chart.js (loaded in index.html).

// ---------- in-memory observation store ----------
const impactObs = [];           // array of observation objects, newest first
const impactActive = {};        // keyed by symbol — currently recording observation

const SILENCE_WINDOW_MS  = 30000;  // new liq within 30s extends current cascade
const MIN_LIQ_USD        = 100000; // minimum liq to trigger a new observation
const TICK_INTERVAL_MS   = 200;    // sample every 200ms while recording

let _impactTickTimer = null;

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Called from strategy.js's onLiquidation wrapper (see bottom of this file)
function onImpactLiquidation(exchange, side, usdVal, price) {
  if (usdVal < MIN_LIQ_USD) return;
  const sym  = state.symbol;
  const now  = Date.now();
  const active = impactActive[sym];

  if (active && now - active.lastLiqTs < SILENCE_WINDOW_MS) {
    // Extend existing cascade
    active.cascadeSize++;
    active.totalLiqVolume += usdVal;
    active.lastLiqTs = now;
    active.liqRemaining += usdVal;   // refill the tank
    active.cascadeEvents.push([now, usdVal, exchange]);
  } else {
    // Close any open cascade for this symbol first
    if (active) _closeImpactObs(sym);

    // Open new observation
    const { terminalPrice } = computeTerminalPrice(usdVal, state.cumulativeDelta, side);
    const obs = {
      id:                   _genId(),
      asset:                sym,
      timestamp:            now,
      entryPrice:           price,
      side:                 side,   // 'long' or 'short'
      exchange:             exchange,
      cascadeSize:          1,
      initialLiqVolume:     usdVal,
      initialDelta:         state.cumulativeDelta,
      initialExpectedPrice: terminalPrice,
      totalLiqVolume:       usdVal,
      liqRemaining:         usdVal,
      lastLiqTs:            now,
      // time series
      deltaSeries:          [],
      expectedPriceSeries:  [],
      priceSeries:          [],
      liqRemainingSeries:   [],
      cascadeEvents:        [[now, usdVal, exchange]],
      // filled at close
      finalExpectedPrice:   null,
      actualTerminalPrice:  null,
      priceErrorPct:        null,
      cascadeDurationS:     null,
      absorbedByDelta:      false,
      labelFilled:          0,
    };
    impactActive[sym] = obs;
    if (!_impactTickTimer) {
      _impactTickTimer = setInterval(_tickAllActive, TICK_INTERVAL_MS);
    }
  }

  _updateImpactTable();
}

function _tickAllActive() {
  const now = Date.now();
  for (const sym of Object.keys(impactActive)) {
    const obs = impactActive[sym];
    if (!obs) continue;

    // Simulate depletion: reduce liqRemaining by ~5% per tick (rough fill rate)
    // Real fill rate is unknown from WebSocket alone, so we model it as decaying
    obs.liqRemaining = Math.max(0, obs.liqRemaining * 0.97);

    const { terminalPrice, absorbed } = computeTerminalPrice(
      obs.liqRemaining, state.cumulativeDelta, obs.side
    );

    const ts = now;
    obs.deltaSeries.push([ts, state.cumulativeDelta]);
    obs.expectedPriceSeries.push([ts, terminalPrice]);
    obs.priceSeries.push([ts, state.price]);
    obs.liqRemainingSeries.push([ts, obs.liqRemaining]);

    if (absorbed) obs.absorbedByDelta = true;

    // Auto-close when tank is nearly empty or silence timeout
    const silenceExpired = now - obs.lastLiqTs > SILENCE_WINDOW_MS;
    const tankDry = obs.liqRemaining < obs.initialLiqVolume * 0.02;
    if (silenceExpired || tankDry) {
      _closeImpactObs(sym);
    }
  }
  // Stop timer if nothing active
  if (Object.keys(impactActive).length === 0) {
    clearInterval(_impactTickTimer);
    _impactTickTimer = null;
  }
  if (_impactDetailOpen) _refreshDetailCharts();
}

function _closeImpactObs(sym) {
  const obs = impactActive[sym];
  if (!obs) return;
  obs.labelFilled       = 1;
  obs.finalExpectedPrice = obs.expectedPriceSeries.length
    ? obs.expectedPriceSeries[obs.expectedPriceSeries.length - 1][1]
    : obs.initialExpectedPrice;
  obs.actualTerminalPrice = state.price;
  obs.priceErrorPct = obs.entryPrice
    ? ((obs.actualTerminalPrice - obs.finalExpectedPrice) / obs.entryPrice * 100)
    : null;
  const firstTs = obs.cascadeEvents[0][0];
  const lastTs  = obs.cascadeEvents[obs.cascadeEvents.length - 1][0];
  obs.cascadeDurationS = (lastTs - firstTs) / 1000;
  impactObs.unshift(obs);
  delete impactActive[sym];
  _updateImpactTable();
  _updateImpactStats();
}

// Patch onLiquidation so new events flow into the recorder.
// We defer until after strategy.js runs (DOMContentLoaded).
document.addEventListener('DOMContentLoaded', () => {
  const _origOnLiq = onLiquidation;
  window.onLiquidation = function(exchange, side, usdVal, price, symbol) {
    _origOnLiq(exchange, side, usdVal, price, symbol);
    // Only record events for the currently viewed symbol
    if (state.symbol === symbol.replace('USDT','').replace('-USDT-SWAP','').replace('-USD','').replace('_USDT','')) {
      onImpactLiquidation(exchange, side, usdVal, price);
    }
  };
});

// ---------- view state ----------
let _impactPage         = 1;
const IMPACT_PAGE_SIZE  = 30;
let _impactFilterAsset  = 'All';
let _impactFilterSide   = 'All';
let _impactFilterSize   = 'All';
let _impactFilterStatus = 'All';
let _impactDetailOpen   = false;
let _impactDetailObs    = null;
let _impactCharts       = {};

// ---------- selection state ----------
// Set of observation IDs currently checked
const _impactSelected = new Set();

function _syncDeleteBtn() {
  const btn = document.getElementById('imp-delete-btn');
  const cnt = document.getElementById('imp-delete-count');
  if (!btn || !cnt) return;
  if (_impactSelected.size > 0) {
    btn.classList.add('visible');
    cnt.textContent = _impactSelected.size;
  } else {
    btn.classList.remove('visible');
    cnt.textContent = '0';
  }
  // Sync select-all checkbox state
  _syncSelectAllCheckbox();
}

function _syncSelectAllCheckbox() {
  const chkAll = document.getElementById('imp-chk-all');
  if (!chkAll) return;
  const filtered = _filteredObs();
  const total    = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / IMPACT_PAGE_SIZE));
  const start  = (_impactPage - 1) * IMPACT_PAGE_SIZE;
  const page   = filtered.slice(start, start + IMPACT_PAGE_SIZE);
  const pageIds = page.map(o => o.id);
  if (pageIds.length === 0) {
    chkAll.checked = false;
    chkAll.indeterminate = false;
    return;
  }
  const selectedOnPage = pageIds.filter(id => _impactSelected.has(id));
  if (selectedOnPage.length === 0) {
    chkAll.checked = false;
    chkAll.indeterminate = false;
  } else if (selectedOnPage.length === pageIds.length) {
    chkAll.checked = true;
    chkAll.indeterminate = false;
  } else {
    chkAll.checked = false;
    chkAll.indeterminate = true;
  }
}

function _deleteSelected() {
  if (_impactSelected.size === 0) return;

  // Close detail panel if the open obs is being deleted
  if (_impactDetailObs && _impactSelected.has(_impactDetailObs.id)) {
    _closeImpactDetail();
  }

  // Remove from impactObs (completed)
  for (let i = impactObs.length - 1; i >= 0; i--) {
    if (_impactSelected.has(impactObs[i].id)) {
      impactObs.splice(i, 1);
    }
  }

  // Remove from impactActive (recording — just close/discard)
  for (const sym of Object.keys(impactActive)) {
    if (impactActive[sym] && _impactSelected.has(impactActive[sym].id)) {
      delete impactActive[sym];
    }
  }

  _impactSelected.clear();
  _syncDeleteBtn();
  _updateImpactTable();
  _updateImpactStats();
}

// ---------- stats bar ----------
function _updateImpactStats() {
  const all = _getAllObs();
  const recording = all.filter(o => o.labelFilled === 0);
  const complete  = all.filter(o => o.labelFilled === 1);
  const absorbed  = complete.filter(o => o.absorbedByDelta);
  const errors    = complete.filter(o => o.priceErrorPct !== null);
  const avgErr    = errors.length
    ? errors.reduce((s, o) => s + Math.abs(o.priceErrorPct), 0) / errors.length
    : null;

  document.getElementById('imp-kpi-total').textContent     = all.length;
  document.getElementById('imp-kpi-recording').textContent = recording.length;
  document.getElementById('imp-kpi-avg-err').textContent   = avgErr !== null ? avgErr.toFixed(3) + '%' : '\u2014';
  document.getElementById('imp-kpi-absorbed').textContent  = absorbed.length;
}

// ---------- table ----------
function _getAllObs() {
  const active = Object.values(impactActive);
  return [...active, ...impactObs];
}

function _filteredObs() {
  return _getAllObs().filter(o => {
    if (_impactFilterAsset !== 'All' && o.asset !== _impactFilterAsset) return false;
    if (_impactFilterSide !== 'All' && o.side !== _impactFilterSide.toLowerCase()) return false;
    if (_impactFilterSize !== 'All') {
      if (_impactFilterSize === 'Single' && o.cascadeSize !== 1) return false;
      if (_impactFilterSize === 'Multi'  && o.cascadeSize < 2) return false;
    }
    if (_impactFilterStatus !== 'All') {
      if (_impactFilterStatus === 'Recording' && o.labelFilled !== 0) return false;
      if (_impactFilterStatus === 'Complete'  && o.labelFilled !== 1) return false;
    }
    return true;
  });
}

function _sizeBadge(n) {
  if (n === 1) return `<span class="imp-badge gray">${n}</span>`;
  if (n === 2) return `<span class="imp-badge yellow">${n}</span>`;
  if (n === 3) return `<span class="imp-badge orange">${n}</span>`;
  return `<span class="imp-badge red">${n}</span>`;
}

function _errColor(pct) {
  if (pct === null) return 'var(--text-faint)';
  const a = Math.abs(pct);
  if (a < 0.1) return 'var(--green)';
  if (a < 0.3) return 'var(--yellow)';
  return 'var(--red)';
}

function _updateImpactTable() {
  const filtered = _filteredObs();
  const total     = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / IMPACT_PAGE_SIZE));
  if (_impactPage > totalPages) _impactPage = totalPages;
  const start = (_impactPage - 1) * IMPACT_PAGE_SIZE;
  const page  = filtered.slice(start, start + IMPACT_PAGE_SIZE);

  document.getElementById('imp-page-info').textContent =
    `Page ${_impactPage} / ${totalPages}  (${total} total)`;
  document.getElementById('imp-prev').disabled = _impactPage <= 1;
  document.getElementById('imp-next').disabled = _impactPage >= totalPages;

  const tbody = document.getElementById('imp-tbody');
  tbody.innerHTML = '';

  const nowTs = Date.now();
  page.forEach(obs => {
    const isSelected = _impactSelected.has(obs.id);
    const tr = document.createElement('tr');
    tr.className = 'imp-row'
      + (_impactDetailObs && _impactDetailObs.id === obs.id ? ' active' : '')
      + (isSelected ? ' selected' : '');
    tr.dataset.id = obs.id;

    const isRec = obs.labelFilled === 0;
    const statusHtml = isRec
      ? `<span class="imp-dot recording"></span>`
      : `<span class="imp-dot complete"></span>`;

    const ts = new Date(obs.timestamp);
    const timeStr = ts.toLocaleTimeString('en-US', {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const dateStr = ts.toLocaleDateString('en-US', {month:'2-digit',day:'2-digit'});

    const sideColor = obs.side === 'long' ? 'var(--green)' : 'var(--red)';
    const deltaColor = obs.initialDelta <= 0 ? 'var(--green)' : 'var(--red)';

    const initialExpFmt  = formatPrice(obs.initialExpectedPrice);
    const finalExpFmt    = obs.finalExpectedPrice  ? formatPrice(obs.finalExpectedPrice)  : '\u2014';
    const actualFmt      = obs.actualTerminalPrice ? formatPrice(obs.actualTerminalPrice) : '\u2014';
    const errFmt         = obs.priceErrorPct !== null ? obs.priceErrorPct.toFixed(3)+'%' : '\u2014';
    const errColor       = _errColor(obs.priceErrorPct);
    const durFmt         = obs.cascadeDurationS !== null ? obs.cascadeDurationS.toFixed(1)+'s' : '\u2014';
    const absHtml        = obs.absorbedByDelta
      ? `<span class="imp-badge cyan">ABS</span>` : '\u2014';
    const chkChecked     = isSelected ? 'checked' : '';

    tr.innerHTML = `
      <td class="imp-td-check"><input type="checkbox" class="imp-chk" data-id="${obs.id}" ${chkChecked}></td>
      <td class="imp-td">${statusHtml}</td>
      <td class="imp-td mono" style="color:var(--text-muted);font-size:10px">${dateStr} ${timeStr}</td>
      <td class="imp-td" style="color:var(--accent)">${obs.asset}</td>
      <td class="imp-td" style="color:${sideColor};font-weight:700">${obs.side.toUpperCase()}</td>
      <td class="imp-td">${_sizeBadge(obs.cascadeSize)}</td>
      <td class="imp-td mono">${formatUSD(obs.initialLiqVolume)}</td>
      <td class="imp-td mono">${formatUSD(obs.totalLiqVolume)}</td>
      <td class="imp-td mono" style="color:${deltaColor}">${formatUSD(obs.initialDelta)}</td>
      <td class="imp-td mono">${initialExpFmt}</td>
      <td class="imp-td mono">${finalExpFmt}</td>
      <td class="imp-td mono">${actualFmt}</td>
      <td class="imp-td mono" style="color:${errColor}">${errFmt}</td>
      <td class="imp-td mono" style="color:var(--text-muted)">${durFmt}</td>
      <td class="imp-td">${absHtml}</td>
    `;

    // Checkbox: toggle selection without opening detail
    const chk = tr.querySelector('.imp-chk');
    chk.addEventListener('click', e => {
      e.stopPropagation();
      const id = e.target.dataset.id;
      if (e.target.checked) {
        _impactSelected.add(id);
      } else {
        _impactSelected.delete(id);
      }
      tr.classList.toggle('selected', e.target.checked);
      _syncDeleteBtn();
    });

    // Row click (not on checkbox) opens detail
    tr.addEventListener('click', e => {
      if (e.target.classList.contains('imp-chk')) return;
      _openImpactDetail(obs.id);
    });

    tbody.appendChild(tr);
  });

  _syncDeleteBtn();
  _updateImpactStats();
}

// ---------- detail panel ----------
function _openImpactDetail(id) {
  const obs = _getAllObs().find(o => o.id === id);
  if (!obs) return;
  _impactDetailObs = obs;
  _impactDetailOpen = true;

  document.querySelectorAll('.imp-row').forEach(r =>
    r.classList.toggle('active', r.dataset.id === id)
  );

  const panel = document.getElementById('imp-detail');
  panel.classList.add('open');

  // Header
  const sideColor = obs.side === 'long' ? 'var(--green)' : 'var(--red)';
  document.getElementById('det-imp-asset').textContent = obs.asset;
  document.getElementById('det-imp-side').textContent  = obs.side.toUpperCase();
  document.getElementById('det-imp-side').style.color  = sideColor;
  document.getElementById('det-imp-entry').textContent = formatPrice(obs.entryPrice);
  document.getElementById('det-imp-exch').textContent  = obs.exchange.charAt(0).toUpperCase() + obs.exchange.slice(1);
  document.getElementById('det-imp-size').innerHTML    = _sizeBadge(obs.cascadeSize);
  document.getElementById('det-imp-dur').textContent   = obs.cascadeDurationS !== null ? obs.cascadeDurationS.toFixed(1)+'s' : 'recording\u2026';
  document.getElementById('det-imp-err').textContent   = obs.priceErrorPct !== null ? obs.priceErrorPct.toFixed(3)+'%' : '\u2014';
  document.getElementById('det-imp-err').style.color   = _errColor(obs.priceErrorPct);
  document.getElementById('det-imp-abs').textContent   = obs.absorbedByDelta ? 'YES' : 'NO';
  document.getElementById('det-imp-abs').style.color   = obs.absorbedByDelta ? 'var(--accent)' : 'var(--text-faint)';

  _renderImpactCharts(obs);
}

function _closeImpactDetail() {
  _impactDetailOpen = false;
  _impactDetailObs  = null;
  document.getElementById('imp-detail').classList.remove('open');
  Object.values(_impactCharts).forEach(c => c.destroy());
  _impactCharts = {};
}

function _elapsedLabels(series, originTs) {
  return series.map(([ts]) => ((ts - originTs) / 1000).toFixed(1) + 's');
}

function _cascadeMarkers(obs, chartInstance, xLabels) {
  // returns annotation plugin lines if available, otherwise no-op
  // We'll draw them as vertical ReferenceLine via manual dataset approach:
  // Add a scatter dataset with one point per cascade event at y = NaN (invisible)
  // and label them. Chart.js annotation plugin is cleaner but we use CDN vanilla.
  // Simple approach: return array of {xLabel, text, color}
  return obs.cascadeEvents.slice(1).map(([ts, vol]) => {
    const label = ((ts - obs.timestamp) / 1000).toFixed(1) + 's';
    return { label, text: '+' + formatUSD(vol) };
  });
}

function _renderImpactCharts(obs) {
  Object.values(_impactCharts).forEach(c => c.destroy());
  _impactCharts = {};

  const originTs = obs.timestamp;

  // ---- Chart 1: Volume Delta over time ----
  if (obs.deltaSeries.length > 1) {
    const labels = _elapsedLabels(obs.deltaSeries, originTs);
    const data   = obs.deltaSeries.map(([,v]) => v);
    const colors = data.map(v => v <= 0 ? 'rgba(0,230,118,0.8)' : 'rgba(255,61,90,0.8)');
    const bgColors = data.map(v => v <= 0 ? 'rgba(0,230,118,0.07)' : 'rgba(255,61,90,0.07)');
    _impactCharts.delta = new Chart(
      document.getElementById('imp-chart-delta').getContext('2d'),
      {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              type: 'line',
              data,
              borderColor: 'rgba(0,212,255,0.6)',
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.3,
              fill: false,
              yAxisID: 'y',
            },
            {
              type: 'bar',
              data,
              backgroundColor: bgColors,
              borderColor: colors,
              borderWidth: 1,
              yAxisID: 'y',
            },
          ],
        },
        options: _chartOpts('Delta (USD)', v => formatUSD(v)),
      }
    );
  }

  // ---- Chart 2: Predicted Terminal Price over time ----
  if (obs.expectedPriceSeries.length > 1) {
    const labels = _elapsedLabels(obs.expectedPriceSeries, originTs);
    const data   = obs.expectedPriceSeries.map(([,v]) => v);
    const opts   = _chartOpts('Predicted Terminal Price', v => formatPrice(v));
    // Add entry_price and actual_terminal_price as annotations via extra datasets
    const extraDatasets = [
      {
        label: 'Entry',
        data: labels.map(() => obs.entryPrice),
        borderColor: 'rgba(122,132,153,0.5)',
        borderWidth: 1,
        borderDash: [4, 4],
        pointRadius: 0,
        tension: 0,
        fill: false,
      }
    ];
    if (obs.actualTerminalPrice) {
      extraDatasets.push({
        label: 'Actual',
        data: labels.map(() => obs.actualTerminalPrice),
        borderColor: 'rgba(0,230,118,0.5)',
        borderWidth: 1,
        borderDash: [3, 3],
        pointRadius: 0,
        tension: 0,
        fill: false,
      });
    }
    _impactCharts.expected = new Chart(
      document.getElementById('imp-chart-expected').getContext('2d'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              data,
              borderColor: obs.side === 'long' ? 'rgba(255,61,90,0.85)' : 'rgba(0,230,118,0.85)',
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.25,
              fill: false,
            },
            ...extraDatasets,
          ],
        },
        options: opts,
      }
    );
  }

  // ---- Chart 3: Actual Price Movement ----
  if (obs.priceSeries.length > 1) {
    const labels = _elapsedLabels(obs.priceSeries, originTs);
    const data   = obs.priceSeries.map(([,v]) => v);
    const opts   = _chartOpts('Actual Price', v => formatPrice(v));
    const extras = [
      {
        label: 'Entry',
        data: labels.map(() => obs.entryPrice),
        borderColor: 'rgba(122,132,153,0.5)',
        borderWidth: 1,
        borderDash: [4, 4],
        pointRadius: 0,
        tension: 0,
        fill: false,
      }
    ];
    if (obs.finalExpectedPrice) {
      extras.push({
        label: 'Model Stop',
        data: labels.map(() => obs.finalExpectedPrice),
        borderColor: 'rgba(255,157,0,0.6)',
        borderWidth: 1,
        borderDash: [3, 3],
        pointRadius: 0,
        tension: 0,
        fill: false,
      });
    }
    _impactCharts.price = new Chart(
      document.getElementById('imp-chart-price').getContext('2d'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              data,
              borderColor: 'var(--accent)',
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.25,
              fill: {
                target: 1,
                above: obs.side === 'long' ? 'rgba(255,61,90,0.05)' : 'rgba(0,230,118,0.05)',
                below: obs.side === 'long' ? 'rgba(255,61,90,0.05)' : 'rgba(0,230,118,0.05)',
              },
            },
            ...extras,
          ],
        },
        options: opts,
      }
    );
  }

  // ---- Chart 4: LIQ Remaining (depleting tank) ----
  if (obs.liqRemainingSeries.length > 1) {
    const labels = _elapsedLabels(obs.liqRemainingSeries, originTs);
    const data   = obs.liqRemainingSeries.map(([,v]) => v);
    const fillColor = obs.side === 'long' ? 'rgba(255,61,90,0.18)' : 'rgba(0,230,118,0.18)';
    const lineColor = obs.side === 'long' ? 'rgba(255,61,90,0.85)' : 'rgba(0,230,118,0.85)';
    _impactCharts.tank = new Chart(
      document.getElementById('imp-chart-tank').getContext('2d'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              data,
              borderColor: lineColor,
              borderWidth: 1.5,
              pointRadius: 0,
              tension: 0.2,
              fill: 'origin',
              backgroundColor: fillColor,
            },
            {
              label: 'Exhausted',
              data: labels.map(() => 0),
              borderColor: 'rgba(122,132,153,0.35)',
              borderWidth: 1,
              borderDash: [4, 4],
              pointRadius: 0,
              tension: 0,
              fill: false,
            },
          ],
        },
        options: _chartOpts('LIQ Remaining (USD)', v => formatUSD(v)),
      }
    );
  }
}

// Shared Chart.js options factory
function _chartOpts(yLabel, tickFmt) {
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
        callbacks: {
          label: item => yLabel + ': ' + tickFmt(item.raw),
        },
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

// Live refresh charts while an observation is recording
function _refreshDetailCharts() {
  if (!_impactDetailObs || !_impactDetailOpen) return;
  const obs = _getAllObs().find(o => o.id === _impactDetailObs.id);
  if (!obs) return;
  _renderImpactCharts(obs);
  // Refresh header fields too
  document.getElementById('det-imp-dur').textContent =
    obs.cascadeDurationS !== null ? obs.cascadeDurationS.toFixed(1)+'s' : 'recording\u2026';
  document.getElementById('det-imp-err').textContent =
    obs.priceErrorPct !== null ? obs.priceErrorPct.toFixed(3)+'%' : '\u2014';
  document.getElementById('det-imp-err').style.color = _errColor(obs.priceErrorPct);
  document.getElementById('det-imp-size').innerHTML = _sizeBadge(obs.cascadeSize);
}

// ---------- tab init ----------
function initImpactTab() {
  document.getElementById('imp-filter-asset').addEventListener('change', e => {
    _impactFilterAsset = e.target.value; _impactPage = 1; _updateImpactTable();
  });
  document.getElementById('imp-filter-side').addEventListener('change', e => {
    _impactFilterSide = e.target.value; _impactPage = 1; _updateImpactTable();
  });
  document.getElementById('imp-filter-size').addEventListener('change', e => {
    _impactFilterSize = e.target.value; _impactPage = 1; _updateImpactTable();
  });
  document.getElementById('imp-filter-status').addEventListener('change', e => {
    _impactFilterStatus = e.target.value; _impactPage = 1; _updateImpactTable();
  });
  document.getElementById('imp-prev').addEventListener('click', () => {
    if (_impactPage > 1) { _impactPage--; _updateImpactTable(); }
  });
  document.getElementById('imp-next').addEventListener('click', () => {
    _impactPage++; _updateImpactTable();
  });
  document.getElementById('imp-detail-close').addEventListener('click', _closeImpactDetail);

  // Select-all checkbox in thead
  document.getElementById('imp-chk-all').addEventListener('change', e => {
    const filtered = _filteredObs();
    const total    = filtered.length;
    const start    = (_impactPage - 1) * IMPACT_PAGE_SIZE;
    const page     = filtered.slice(start, start + IMPACT_PAGE_SIZE);
    page.forEach(obs => {
      if (e.target.checked) {
        _impactSelected.add(obs.id);
      } else {
        _impactSelected.delete(obs.id);
      }
    });
    _updateImpactTable();
    _syncDeleteBtn();
  });

  // Delete selected button
  document.getElementById('imp-delete-btn').addEventListener('click', _deleteSelected);

  _updateImpactStats();
  _updateImpactTable();
}
