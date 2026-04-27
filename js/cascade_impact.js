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
    // Extend existing cascade — refill the tank
    active.cascadeSize++;
    active.totalLiqVolume += usdVal;
    active.lastLiqTs = now;
    active.liqRemaining += usdVal;
    active.cascadeEvents.push([now, usdVal, exchange]);
  } else {
    // Close any open cascade for this symbol first
    if (active) _closeImpactObs(sym);

    // Open new observation — tank starts at raw liq size, no delta mixed in
    const { terminalPrice } = computeTerminalPrice(usdVal, 0, side);
    const obs = {
      id:                   _genId(),
      asset:                sym,
      timestamp:            now,
      entryPrice:           price,
      side:                 side,
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
      // internal tick state
      _lastDelta:           state.cumulativeDelta,
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

    // ── Step 1: Update tank with this tick's real market flow ──────────────
    // delta_tick = increment since last tick (not the full accumulated second).
    // Long liq: positive delta (net buying) drains tank.
    // Negative delta (net selling = same direction as forced flow) refills it.
    const currentDelta = state.cumulativeDelta;
    const lastDelta    = obs._lastDelta || currentDelta;
    const deltaTick    = currentDelta - lastDelta;
    obs._lastDelta     = currentDelta;

    const direction    = obs.side === 'long' ? 1 : -1;
    const prevRemaining = obs.liqRemaining;
    obs.liqRemaining   = Math.max(0, obs.liqRemaining - direction * deltaTick);

    if (obs.liqRemaining < obs.initialLiqVolume * 0.01) {
      obs.absorbedByDelta = true;
    }

    // ── Step 2: Read-only bucket walk — purely a prediction ────────────────
    // Uses current liq_remaining. Changes nothing.
    const { terminalPrice } = computeTerminalPrice(obs.liqRemaining, 0, obs.side);

    obs.deltaSeries.push([now, deltaTick]);
    obs.expectedPriceSeries.push([now, terminalPrice]);
    obs.priceSeries.push([now, state.price]);
    obs.liqRemainingSeries.push([now, obs.liqRemaining]);

    // Only silence closes the observation — tank hitting zero does NOT close it
    // because a new cascade cluster may arrive and refill it.
    const silenceExpired = now - obs.lastLiqTs > SILENCE_WINDOW_MS;
    if (silenceExpired) {
      _closeImpactObs(sym);
    }
  }

  if (Object.keys(impactActive).length === 0) {
    clearInterval(_impactTickTimer);
    _impactTickTimer = null;
  }
  if (_impactDetailOpen) _refreshDetailCharts();
}

function _closeImpactObs(sym) {
  const obs = impactActive[sym];
  if (!obs) return;

  obs.labelFilled         = 1;
  obs.actualTerminalPrice = state.price;
  obs.finalExpectedPrice  = obs.expectedPriceSeries.length
    ? obs.expectedPriceSeries[obs.expectedPriceSeries.length - 1][1]
    : obs.initialExpectedPrice;

  // Duration: first liq → observation close
  const firstTs = obs.cascadeEvents[0][0];
  obs.cascadeDurationS = (Date.now() - firstTs) / 1000;

  // Error %: how much did the prediction drift from first to last tick?
  // (finalExpected - initialExpected) / entryPrice × 100
  // NOT vs actual price — that belongs in the Diff column.
  obs.priceErrorPct = (obs.entryPrice && obs.finalExpectedPrice !== null && obs.initialExpectedPrice !== null)
    ? ((obs.finalExpectedPrice - obs.initialExpectedPrice) / obs.entryPrice * 100)
    : null;

  impactObs.unshift(obs);
  delete impactActive[sym];
  _updateImpactTable();
  _updateImpactStats();
}

// Patch onLiquidation so new events flow into the recorder.
document.addEventListener('DOMContentLoaded', () => {
  const _origOnLiq = onLiquidation;
  window.onLiquidation = function(exchange, side, usdVal, price, symbol) {
    _origOnLiq(exchange, side, usdVal, price, symbol);
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
  _syncSelectAllCheckbox();
}

function _syncSelectAllCheckbox() {
  const chkAll = document.getElementById('imp-chk-all');
  if (!chkAll) return;
  const filtered = _filteredObs();
  const start  = (_impactPage - 1) * IMPACT_PAGE_SIZE;
  const page   = filtered.slice(start, start + IMPACT_PAGE_SIZE);
  const pageIds = page.map(o => o.id);
  if (pageIds.length === 0) {
    chkAll.checked = false; chkAll.indeterminate = false; return;
  }
  const selectedOnPage = pageIds.filter(id => _impactSelected.has(id));
  if (selectedOnPage.length === 0) {
    chkAll.checked = false; chkAll.indeterminate = false;
  } else if (selectedOnPage.length === pageIds.length) {
    chkAll.checked = true; chkAll.indeterminate = false;
  } else {
    chkAll.checked = false; chkAll.indeterminate = true;
  }
}

function _deleteSelected() {
  if (_impactSelected.size === 0) return;
  if (_impactDetailObs && _impactSelected.has(_impactDetailObs.id)) _closeImpactDetail();
  for (let i = impactObs.length - 1; i >= 0; i--) {
    if (_impactSelected.has(impactObs[i].id)) impactObs.splice(i, 1);
  }
  for (const sym of Object.keys(impactActive)) {
    if (impactActive[sym] && _impactSelected.has(impactActive[sym].id)) delete impactActive[sym];
  }
  _impactSelected.clear();
  _syncDeleteBtn();
  _updateImpactTable();
  _updateImpactStats();
}

// ---------- stats bar ----------
function _updateImpactStats() {
  const all       = _getAllObs();
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
  return [...Object.values(impactActive), ...impactObs];
}

function _filteredObs() {
  return _getAllObs().filter(o => {
    if (_impactFilterAsset !== 'All' && o.asset !== _impactFilterAsset) return false;
    if (_impactFilterSide  !== 'All' && o.side  !== _impactFilterSide.toLowerCase()) return false;
    if (_impactFilterSize  !== 'All') {
      if (_impactFilterSize === 'Single' && o.cascadeSize !== 1) return false;
      if (_impactFilterSize === 'Multi'  && o.cascadeSize  <  2) return false;
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
  const filtered   = _filteredObs();
  const total      = filtered.length;
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

  page.forEach(obs => {
    const isSelected = _impactSelected.has(obs.id);
    const tr = document.createElement('tr');
    tr.className = 'imp-row'
      + (_impactDetailObs && _impactDetailObs.id === obs.id ? ' active' : '')
      + (isSelected ? ' selected' : '');
    tr.dataset.id = obs.id;

    const isRec      = obs.labelFilled === 0;
    const sideColor  = obs.side === 'long' ? 'var(--green)' : 'var(--red)';
    const deltaColor = obs.initialDelta <= 0 ? 'var(--green)' : 'var(--red)';

    const ts      = new Date(obs.timestamp);
    const timeStr = ts.toLocaleTimeString('en-US', {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const dateStr = ts.toLocaleDateString('en-US', {month:'2-digit',day:'2-digit'});

    const statusHtml    = isRec ? `<span class="imp-dot recording"></span>` : `<span class="imp-dot complete"></span>`;
    const initialExpFmt = formatPrice(obs.initialExpectedPrice);
    const finalExpFmt   = obs.finalExpectedPrice ? formatPrice(obs.finalExpectedPrice) : '\u2014';
    const errFmt        = obs.priceErrorPct !== null ? obs.priceErrorPct.toFixed(3)+'%' : '\u2014';
    const errColor      = _errColor(obs.priceErrorPct);
    const durFmt        = obs.cascadeDurationS !== null ? obs.cascadeDurationS.toFixed(1)+'s' : '\u2014';
    const absHtml       = obs.absorbedByDelta ? `<span class="imp-badge cyan">ABS</span>` : '\u2014';

    // ── New columns: Start / End / Diff ────────────────────────────────────
    const startFmt     = formatPrice(obs.entryPrice);
    const endFmt       = obs.actualTerminalPrice ? formatPrice(obs.actualTerminalPrice) : '\u2014';
    const diffVal      = obs.actualTerminalPrice != null ? obs.actualTerminalPrice - obs.entryPrice : null;
    const diffFmt      = diffVal !== null ? (diffVal >= 0 ? '+' : '') + formatPrice(Math.abs(diffVal)) : '\u2014';
    const diffExpected = obs.side === 'long' ? (diffVal ?? 0) < 0 : (diffVal ?? 0) > 0;
    const diffColor    = diffVal === null ? 'var(--text-faint)' : diffExpected ? 'var(--green)' : 'var(--red)';
    // ───────────────────────────────────────────────────────────────────────

    const chkChecked = isSelected ? 'checked' : '';

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
      <td class="imp-td mono" style="color:var(--text-muted)">${startFmt}</td>
      <td class="imp-td mono" style="color:var(--text-muted)">${endFmt}</td>
      <td class="imp-td mono" style="color:${diffColor}">${diffFmt}</td>
      <td class="imp-td mono" style="color:${errColor}">${errFmt}</td>
      <td class="imp-td mono" style="color:var(--text-muted)">${durFmt}</td>
      <td class="imp-td">${absHtml}</td>
    `;

    const chk = tr.querySelector('.imp-chk');
    chk.addEventListener('click', e => {
      e.stopPropagation();
      const id = e.target.dataset.id;
      if (e.target.checked) { _impactSelected.add(id); } else { _impactSelected.delete(id); }
      tr.classList.toggle('selected', e.target.checked);
      _syncDeleteBtn();
    });

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
  _impactDetailObs  = obs;
  _impactDetailOpen = true;

  document.querySelectorAll('.imp-row').forEach(r =>
    r.classList.toggle('active', r.dataset.id === id)
  );
  document.getElementById('imp-detail').classList.add('open');

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

function _renderImpactCharts(obs) {
  Object.values(_impactCharts).forEach(c => c.destroy());
  _impactCharts = {};
  const originTs = obs.timestamp;

  // Chart 1: per-tick delta (flow that drains/refills the tank)
  if (obs.deltaSeries.length > 1) {
    const labels = _elapsedLabels(obs.deltaSeries, originTs);
    const data   = obs.deltaSeries.map(([,v]) => v);
    _impactCharts.delta = new Chart(
      document.getElementById('imp-chart-delta').getContext('2d'),
      {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { type:'line', data, borderColor:'rgba(0,212,255,0.6)', borderWidth:1.5, pointRadius:0, tension:0.3, fill:false },
            { type:'bar',  data, backgroundColor: data.map(v => v<=0?'rgba(0,230,118,0.07)':'rgba(255,61,90,0.07)'),
                                 borderColor: data.map(v => v<=0?'rgba(0,230,118,0.8)':'rgba(255,61,90,0.8)'), borderWidth:1 },
          ],
        },
        options: _chartOpts('Delta-Tick (USD)', v => formatUSD(v)),
      }
    );
  }

  // Chart 2: predicted terminal price over time
  if (obs.expectedPriceSeries.length > 1) {
    const labels = _elapsedLabels(obs.expectedPriceSeries, originTs);
    const data   = obs.expectedPriceSeries.map(([,v]) => v);
    _impactCharts.expected = new Chart(
      document.getElementById('imp-chart-expected').getContext('2d'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor: obs.side==='long'?'rgba(255,61,90,0.85)':'rgba(0,230,118,0.85)', borderWidth:1.5, pointRadius:0, tension:0.25, fill:false },
            { data: labels.map(()=>obs.entryPrice), borderColor:'rgba(122,132,153,0.5)', borderWidth:1, borderDash:[4,4], pointRadius:0, tension:0, fill:false },
            ...(obs.actualTerminalPrice ? [{ data: labels.map(()=>obs.actualTerminalPrice), borderColor:'rgba(0,230,118,0.55)', borderWidth:1, borderDash:[3,3], pointRadius:0, tension:0, fill:false }] : []),
          ],
        },
        options: _chartOpts('Preis-Prognose', v => formatPrice(v)),
      }
    );
  }

  // Chart 3: actual price movement — START/END reference lines
  if (obs.priceSeries.length > 1) {
    const labels = _elapsedLabels(obs.priceSeries, originTs);
    const data   = obs.priceSeries.map(([,v]) => v);
    _impactCharts.price = new Chart(
      document.getElementById('imp-chart-price').getContext('2d'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor:'rgba(0,212,255,0.85)', borderWidth:1.5, pointRadius:0, tension:0.25, fill:false },
            { data: labels.map(()=>obs.entryPrice), borderColor:'rgba(122,132,153,0.6)', borderWidth:1, borderDash:[4,4], pointRadius:0, tension:0, fill:false },
            ...(obs.actualTerminalPrice ? [{ data: labels.map(()=>obs.actualTerminalPrice), borderColor:'rgba(255,157,0,0.7)', borderWidth:1, borderDash:[3,3], pointRadius:0, tension:0, fill:false }] : []),
            ...(obs.finalExpectedPrice  ? [{ data: labels.map(()=>obs.finalExpectedPrice),  borderColor:'rgba(168,85,247,0.5)', borderWidth:1, borderDash:[3,3], pointRadius:0, tension:0, fill:false }] : []),
          ],
        },
        options: _chartOpts('Preis', v => formatPrice(v)),
      }
    );
  }

  // Chart 4: liq remaining (depleting tank)
  if (obs.liqRemainingSeries.length > 1) {
    const labels    = _elapsedLabels(obs.liqRemainingSeries, originTs);
    const data      = obs.liqRemainingSeries.map(([,v]) => v);
    const fillColor = obs.side==='long'?'rgba(255,61,90,0.18)':'rgba(0,230,118,0.18)';
    const lineColor = obs.side==='long'?'rgba(255,61,90,0.85)':'rgba(0,230,118,0.85)';
    _impactCharts.tank = new Chart(
      document.getElementById('imp-chart-tank').getContext('2d'),
      {
        type: 'line',
        data: {
          labels,
          datasets: [
            { data, borderColor:lineColor, borderWidth:1.5, pointRadius:0, tension:0.2, fill:'origin', backgroundColor:fillColor },
            { data: labels.map(()=>0), borderColor:'rgba(122,132,153,0.35)', borderWidth:1, borderDash:[4,4], pointRadius:0, tension:0, fill:false },
          ],
        },
        options: _chartOpts('LIQ verbleibend (USD)', v => formatUSD(v)),
      }
    );
  }
}

function _chartOpts(yLabel, tickFmt) {
  return {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode:'index', intersect:false },
    plugins: {
      legend: { display:false },
      tooltip: {
        backgroundColor:'#0e1014', borderColor:'#1f2430', borderWidth:1,
        titleColor:'#e2e8f0', bodyColor:'#7a8499',
        callbacks: { label: item => yLabel + ': ' + tickFmt(item.raw) },
      },
    },
    scales: {
      x: { ticks:{ color:'#3d4455', font:{size:9}, maxTicksLimit:8, maxRotation:0 }, grid:{ color:'#1a1e2a' } },
      y: { ticks:{ color:'#3d4455', font:{size:9}, callback:tickFmt }, grid:{ color:'#1a1e2a' } },
    },
  };
}

function _refreshDetailCharts() {
  if (!_impactDetailObs || !_impactDetailOpen) return;
  const obs = _getAllObs().find(o => o.id === _impactDetailObs.id);
  if (!obs) return;
  _renderImpactCharts(obs);
  document.getElementById('det-imp-dur').textContent   = obs.cascadeDurationS !== null ? obs.cascadeDurationS.toFixed(1)+'s' : 'recording\u2026';
  document.getElementById('det-imp-err').textContent   = obs.priceErrorPct !== null ? obs.priceErrorPct.toFixed(3)+'%' : '\u2014';
  document.getElementById('det-imp-err').style.color   = _errColor(obs.priceErrorPct);
  document.getElementById('det-imp-size').innerHTML    = _sizeBadge(obs.cascadeSize);
}

// ---------- tab init ----------
function initImpactTab() {
  document.getElementById('imp-filter-asset').addEventListener('change', e => { _impactFilterAsset = e.target.value; _impactPage = 1; _updateImpactTable(); });
  document.getElementById('imp-filter-side').addEventListener('change',  e => { _impactFilterSide  = e.target.value; _impactPage = 1; _updateImpactTable(); });
  document.getElementById('imp-filter-size').addEventListener('change',  e => { _impactFilterSize  = e.target.value; _impactPage = 1; _updateImpactTable(); });
  document.getElementById('imp-filter-status').addEventListener('change',e => { _impactFilterStatus= e.target.value; _impactPage = 1; _updateImpactTable(); });
  document.getElementById('imp-prev').addEventListener('click', () => { if (_impactPage > 1) { _impactPage--; _updateImpactTable(); } });
  document.getElementById('imp-next').addEventListener('click', () => { _impactPage++; _updateImpactTable(); });
  document.getElementById('imp-detail-close').addEventListener('click', _closeImpactDetail);

  document.getElementById('imp-chk-all').addEventListener('change', e => {
    const filtered = _filteredObs();
    const start    = (_impactPage - 1) * IMPACT_PAGE_SIZE;
    const page     = filtered.slice(start, start + IMPACT_PAGE_SIZE);
    page.forEach(obs => { if (e.target.checked) { _impactSelected.add(obs.id); } else { _impactSelected.delete(obs.id); } });
    _updateImpactTable();
    _syncDeleteBtn();
  });

  document.getElementById('imp-delete-btn').addEventListener('click', _deleteSelected);
  _updateImpactStats();
  _updateImpactTable();
}
