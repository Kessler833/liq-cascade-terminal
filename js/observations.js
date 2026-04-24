// observations.js — Observations tab for Liq Cascade Terminal
// All data comes from the local Python backend at BACKEND_URL.

const BACKEND_URL  = 'http://127.0.0.1:8743';
const OBS_PAGE     = 30;
const LABEL_HORIZON = 3600;   // seconds until an observation expires

const obsState = {
  page:           1,
  total:          0,
  filterAsset:    'All',
  filterSide:     'All',
  filterLabeled:  'All',
  rows:           [],
  activeId:       null,
  histChart:      null,
  pollInterval:   null,
  detailPoll:     null,
};

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v, digits=2) {
  if (v == null) return '—';
  const s = v >= 0 ? '+' : '';
  return s + v.toFixed(digits) + '%';
}
function fmtSharpe(v) {
  if (v == null) return '—';
  return v.toFixed(3);
}
function fmtSec(v) {
  if (v == null) return '—';
  const m = Math.floor(v / 60), s = Math.round(v % 60);
  return `${m}m ${String(s).padStart(2,'0')}s`;
}
function sharpeColor(v) {
  if (v == null) return 'var(--text-muted)';
  if (v >=  0.25) return 'var(--green)';
  if (v <= -0.25) return 'var(--red)';
  return 'var(--text-muted)';
}

async function obsApi(path) {
  try {
    const r = await fetch(BACKEND_URL + path);
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

// ── KPI counters ──────────────────────────────────────────────────────────────

async function refreshObsCounts() {
  const d = await obsApi('/observations/count');
  if (!d) {
    document.getElementById('obs-status').textContent = 'Backend offline';
    document.getElementById('obs-status').style.color = 'var(--red)';
    return;
  }
  document.getElementById('obs-status').textContent = 'Connected';
  document.getElementById('obs-status').style.color = 'var(--green)';
  document.getElementById('obs-kpi-total').textContent     = d.total;
  document.getElementById('obs-kpi-recording').textContent = d.recording;
  document.getElementById('obs-kpi-labeled').textContent   = d.labeled;
  document.getElementById('obs-kpi-expired').textContent   = d.expired;
}

// ── Sharpe histogram ─────────────────────────────────────────────────────────

async function refreshObsDistribution() {
  const d = await obsApi('/observations/distribution');
  if (!d || !d.bins.length) return;

  document.getElementById('obs-dist-mean').textContent   = fmtSharpe(d.mean);
  document.getElementById('obs-dist-median').textContent = fmtSharpe(d.median);
  document.getElementById('obs-dist-std').textContent    = fmtSharpe(d.std);
  document.getElementById('obs-dist-pos').textContent    = d.positive_rate != null
    ? (d.positive_rate * 100).toFixed(1) + '%' : '—';

  document.getElementById('obs-dist-mean').style.color   = sharpeColor(d.mean);
  document.getElementById('obs-dist-median').style.color = sharpeColor(d.median);

  const labels = d.bins.map(b => b.x.toFixed(2));
  const data   = d.bins.map(b => b.count);
  const colors = d.bins.map(b =>
    b.x >= 0.25  ? 'rgba(0,230,118,0.75)' :
    b.x <= -0.25 ? 'rgba(255,61,90,0.75)' :
    'rgba(107,114,128,0.55)'
  );

  if (obsState.histChart) {
    obsState.histChart.data.labels = labels;
    obsState.histChart.data.datasets[0].data   = data;
    obsState.histChart.data.datasets[0].backgroundColor = colors;
    obsState.histChart.update('none');
    return;
  }

  const ctx = document.getElementById('obs-hist-canvas').getContext('2d');
  obsState.histChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 0, borderRadius: 2 }]
    },
    options: {
      animation: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: {
          title: items => 'Sharpe ' + items[0].label,
          label:  item  => 'Count: ' + item.raw,
        },
        backgroundColor: '#1c2030', borderColor: '#2a3045', borderWidth: 1,
        titleColor: '#e2e8f0', bodyColor: '#7a8499',
      }},
      scales: {
        x: { ticks: { color: '#3d4455', font: { size: 9 }, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: '#3d4455', font: { size: 9 } }, grid: { color: '#1f2430' } },
      },
    }
  });
}

// ── Table ─────────────────────────────────────────────────────────────────────

async function refreshObsTable() {
  const params = new URLSearchParams({
    limit:  OBS_PAGE,
    offset: (obsState.page - 1) * OBS_PAGE,
  });
  if (obsState.filterAsset !== 'All')   params.set('asset',   obsState.filterAsset);
  if (obsState.filterSide  !== 'All')   params.set('side',    obsState.filterSide);
  if (obsState.filterLabeled === 'Labeled')  params.set('labeled', 1);
  if (obsState.filterLabeled === 'Recording') params.set('labeled', 0);
  if (obsState.filterLabeled === 'Expired')  params.set('labeled', 2);

  const d = await obsApi('/observations?' + params.toString());
  if (!d) return;

  obsState.total = d.total;
  obsState.rows  = d.rows;

  const nowTs = Date.now() / 1000;
  const tbody = document.getElementById('obs-tbody');
  tbody.innerHTML = '';

  d.rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.dataset.id = row.obs_id;
    tr.className  = 'obs-row' + (row.obs_id === obsState.activeId ? ' active' : '');

    // Status cell
    const age  = nowTs - row.timestamp;
    const isRec = row.label_filled === 0 && age < LABEL_HORIZON;
    let statusHtml = '';
    if (isRec) {
      const rem = Math.max(0, LABEL_HORIZON - age);
      const mm  = String(Math.floor(rem / 60)).padStart(2, '0');
      const ss  = String(Math.floor(rem  % 60)).padStart(2, '0');
      statusHtml = `<span class="obs-dot recording"></span><span class="obs-countdown">${mm}:${ss}</span>`;
    } else if (row.label_filled === 1) {
      const has60 = row.optimal_sharpe_60m != null;
      statusHtml = `<span class="obs-dot labeled ${has60?'has60':'has30'}"></span><span style="font-size:10px;color:${has60?'var(--green)':'var(--yellow)'}">${has60?'60m':'30m'}</span>`;
    } else {
      statusHtml = `<span class="obs-dot expired"></span><span style="font-size:10px;color:var(--text-faint)">${row.label_filled===2?'exp':'pend'}</span>`;
    }

    const sh    = row.optimal_sharpe_60m ?? row.optimal_sharpe_30m;
    const peak  = row.peak_return_60m_pct ?? row.peak_return_30m_pct;
    const ttpeak = row.time_to_peak_60m_s ?? row.time_to_peak_30m_s;
    const sideColor = row.side === 'LONG' ? 'var(--green)' : 'var(--red)';

    const ts = new Date(row.timestamp * 1000);
    const timeStr = ts.toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const dateStr = ts.toLocaleDateString('en-US',{month:'2-digit',day:'2-digit'});

    tr.innerHTML = `
      <td class="obs-td status-cell">${statusHtml}</td>
      <td class="obs-td mono" style="color:var(--text-muted);font-size:10px">${dateStr} ${timeStr}</td>
      <td class="obs-td" style="color:var(--accent);font-weight:600">${row.asset}</td>
      <td class="obs-td" style="color:${sideColor};font-weight:700">${row.side}</td>
      <td class="obs-td mono" style="color:var(--text)">${formatPrice(row.price)}</td>
      <td class="obs-td mono" style="color:var(--orange)">${row.cascade_pct != null ? row.cascade_pct.toFixed(1)+'%' : '—'}</td>
      <td class="obs-td mono" style="color:var(--text-muted)">${row.liq_1m_usd != null ? formatUSD(row.liq_1m_usd) : '—'}</td>
      <td class="obs-td mono" style="color:${row.cumulative_delta>=0?'var(--green)':'var(--red)'}">${row.cumulative_delta != null ? formatUSD(row.cumulative_delta) : '—'}</td>
      <td class="obs-td mono" style="color:${sharpeColor(sh)};font-weight:600">${fmtSharpe(sh)}</td>
      <td class="obs-td mono" style="color:${(peak??0)>=0?'var(--green)':'var(--red)'}">${fmtPct(peak)}</td>
      <td class="obs-td mono" style="color:var(--text-muted)">${fmtSec(ttpeak)}</td>
    `;

    tr.addEventListener('click', () => openObsDetail(row.obs_id));
    tbody.appendChild(tr);
  });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(obsState.total / OBS_PAGE));
  document.getElementById('obs-page-info').textContent = `Page ${obsState.page} / ${totalPages}  (${obsState.total} total)`;
  document.getElementById('obs-prev').disabled = obsState.page <= 1;
  document.getElementById('obs-next').disabled = obsState.page >= totalPages;
}

// ── Detail panel ──────────────────────────────────────────────────────────────

let detailPathChart = null;

async function openObsDetail(obs_id) {
  obsState.activeId = obs_id;
  document.querySelectorAll('.obs-row').forEach(r => r.classList.toggle('active', r.dataset.id === obs_id));

  const row = await obsApi('/observations/' + obs_id);
  if (!row) return;

  const panel = document.getElementById('obs-detail');
  panel.classList.add('open');

  // Fill KPIs
  document.getElementById('det-asset').textContent = row.asset;
  document.getElementById('det-side').textContent  = row.side;
  document.getElementById('det-side').style.color  = row.side==='LONG'?'var(--green)':'var(--red)';
  document.getElementById('det-price').textContent = formatPrice(row.price);
  document.getElementById('det-time').textContent  = new Date(row.timestamp*1000).toLocaleString();
  document.getElementById('det-cascade').textContent = row.cascade_pct != null ? row.cascade_pct.toFixed(1)+'%' : '—';
  document.getElementById('det-liq1m').textContent    = row.liq_1m_usd != null ? formatUSD(row.liq_1m_usd) : '—';
  document.getElementById('det-delta').textContent    = row.cumulative_delta != null ? formatUSD(row.cumulative_delta) : '—';
  document.getElementById('det-delta').style.color    = (row.cumulative_delta??0)>=0 ? 'var(--green)' : 'var(--red)';

  const sh   = row.optimal_sharpe_60m ?? row.optimal_sharpe_30m;
  const peak = row.peak_return_60m_pct ?? row.peak_return_30m_pct;
  const ttp  = row.time_to_peak_60m_s  ?? row.time_to_peak_30m_s;
  document.getElementById('det-sharpe').textContent = fmtSharpe(sh);
  document.getElementById('det-sharpe').style.color = sharpeColor(sh);
  document.getElementById('det-peak').textContent   = fmtPct(peak);
  document.getElementById('det-peak').style.color   = (peak??0)>=0?'var(--green)':'var(--red)';
  document.getElementById('det-ttp').textContent    = fmtSec(ttp);
  document.getElementById('det-net2m').textContent  = fmtPct(row.net_return_2m_pct);

  // Exchange breakdown
  const exchMap = {
    Binance: ['bnce_long','bnce_short'],
    Bybit:   ['bybt_long','bybt_short'],
    OKX:     ['okx_long', 'okx_short'],
    Bitget:  ['bget_long','bget_short'],
    Gate:    ['gate_long','gate_short'],
    dYdX:    ['dydx_long','dydx_short'],
  };
  const exchGrid = document.getElementById('det-exch-grid');
  exchGrid.innerHTML = '';
  for (const [name, [lk, sk]] of Object.entries(exchMap)) {
    const l = row[lk] || 0, s = row[sk] || 0, tot = l + s || 1;
    exchGrid.innerHTML += `
      <div class="det-exch-cell">
        <div class="det-exch-name">${name}</div>
        <div class="det-exch-vals">
          <span style="color:var(--green)">${formatUSD(l)}</span>
          <span style="color:var(--red)">${formatUSD(s)}</span>
        </div>
        <div class="det-exch-bar">
          <div style="width:${(l/tot*100).toFixed(1)}%;background:var(--green2);height:3px;border-radius:2px"></div>
          <div style="width:${(s/tot*100).toFixed(1)}%;background:var(--red2);height:3px;border-radius:2px"></div>
        </div>
      </div>
    `;
  }

  // Price path chart
  renderPathChart(row);

  // If still recording, start live polling
  clearInterval(obsState.detailPoll);
  if (row.label_filled === 0) {
    obsState.detailPoll = setInterval(async () => {
      const fresh = await obsApi('/observations/' + obs_id);
      if (fresh) renderPathChart(fresh);
    }, 5000);
  }
}

function renderPathChart(row) {
  const pathJson = row.price_path_json || row.price_path_60m_json;
  const ctx = document.getElementById('det-path-canvas').getContext('2d');
  const noData = !pathJson;

  if (noData && row.label_filled === 0) {
    // Show live partial path by computing from entry price vs latest tick
    // We don't have ticks in the browser for past time; just show 'Recording...'
    document.getElementById('det-path-status').textContent = 'Recording price path…';
    if (detailPathChart) { detailPathChart.data.labels=[]; detailPathChart.data.datasets[0].data=[]; detailPathChart.update('none'); }
    return;
  }

  document.getElementById('det-path-status').textContent = '';

  let path = {};
  if (pathJson) {
    try { path = JSON.parse(pathJson); } catch {}
  }

  const entries = Object.entries(path)
    .map(([k, v]) => ({ s: parseInt(k), v }))
    .sort((a, b) => a.s - b.s);

  const labels = entries.map(e => fmtSec(e.s));
  const data   = entries.map(e => e.v);
  const dir    = row.side === 'LONG' ? 1 : -1;

  const positiveColor = 'rgba(0,230,118,0.8)';
  const negativeColor = 'rgba(255,61,90,0.8)';
  const lineColor     = dir === 1 ? positiveColor : negativeColor;

  if (detailPathChart) {
    detailPathChart.data.labels             = labels;
    detailPathChart.data.datasets[0].data  = data;
    detailPathChart.data.datasets[0].borderColor = lineColor;
    detailPathChart.update('none');
    return;
  }

  detailPathChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor:     lineColor,
        borderWidth:     1.5,
        pointRadius:     0,
        tension:         0.3,
        fill:            true,
        backgroundColor: dir===1 ? 'rgba(0,230,118,0.06)' : 'rgba(255,61,90,0.06)',
      }]
    },
    options: {
      animation: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: {
          title: items  => items[0].label,
          label:  item  => fmtPct(item.raw),
        },
        backgroundColor: '#1c2030', borderColor: '#2a3045', borderWidth: 1,
        titleColor: '#e2e8f0', bodyColor: '#7a8499',
      }},
      scales: {
        x: {
          ticks: { color:'#3d4455', font:{size:9}, maxTicksLimit:8 },
          grid:  { color: '#1a1e2a' },
        },
        y: {
          ticks: { color:'#3d4455', font:{size:9}, callback: v => fmtPct(v,1) },
          grid:  { color: '#1a1e2a' },
          afterDataLimits: ax => { const pad=0.1; ax.min-=pad; ax.max+=pad; },
        },
      },
    }
  });
}

function closeObsDetail() {
  clearInterval(obsState.detailPoll);
  obsState.activeId = null;
  document.getElementById('obs-detail').classList.remove('open');
  if (detailPathChart) { detailPathChart.destroy(); detailPathChart = null; }
}

// ── Page init / polling ───────────────────────────────────────────────────────

function initObservationsTab() {
  // Filter bindings
  document.getElementById('obs-filter-asset').addEventListener('change', e => {
    obsState.filterAsset = e.target.value; obsState.page = 1; refreshObsTable();
  });
  document.getElementById('obs-filter-side').addEventListener('change', e => {
    obsState.filterSide = e.target.value; obsState.page = 1; refreshObsTable();
  });
  document.getElementById('obs-filter-labeled').addEventListener('change', e => {
    obsState.filterLabeled = e.target.value; obsState.page = 1; refreshObsTable();
  });

  // Pagination
  document.getElementById('obs-prev').addEventListener('click', () => {
    if (obsState.page > 1) { obsState.page--; refreshObsTable(); }
  });
  document.getElementById('obs-next').addEventListener('click', () => {
    const totalPages = Math.ceil(obsState.total / OBS_PAGE);
    if (obsState.page < totalPages) { obsState.page++; refreshObsTable(); }
  });

  // Detail close
  document.getElementById('obs-detail-close').addEventListener('click', closeObsDetail);

  // Export
  document.getElementById('obs-export-btn').addEventListener('click', () => {
    window.open(BACKEND_URL + '/observations/export', '_blank');
  });

  // Initial data fetch
  refreshObsCounts();
  refreshObsDistribution();
  refreshObsTable();

  // Poll every 5 s
  obsState.pollInterval = setInterval(() => {
    refreshObsCounts();
    refreshObsDistribution();
    refreshObsTable();
  }, 5000);
}
