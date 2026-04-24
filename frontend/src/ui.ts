/** DOM update functions — decoupled from chart rendering. */
import { state, type FeedItem, type LogItem, type Stats } from './state';
import { fmtUSD, fmtDelta, fmtPrice, fmtTime, el, sizeClass } from './utils';

const EXCHANGES = ['binance','bybit','okx','bitget','gate','dydx'] as const;

// ---- Symbol / TF buttons ----
export function initControls(
  onSymbol: (s: string) => void,
  onTF:     (tf: string) => void,
  symbols:   readonly string[],
  timeframes: readonly string[],
) {
  const symWrap = document.getElementById('symbolBtns')!;
  const tfWrap  = document.getElementById('tfBtns')!;
  for (const s of symbols) {
    const b = el('button', 'ctrl-btn' + (s === state.symbol ? ' active' : ''), s);
    b.addEventListener('click', () => { onSymbol(s); setActiveBtn(symWrap, b); });
    symWrap.appendChild(b);
  }
  for (const tf of timeframes) {
    const b = el('button', 'ctrl-btn' + (tf === state.timeframe ? ' active' : ''), tf);
    b.addEventListener('click', () => { onTF(tf); setActiveBtn(tfWrap, b); });
    tfWrap.appendChild(b);
  }
  // chart tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab!;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.chart-container').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(tab + 'Chart')?.classList.add('active');
    });
  });
}

function setActiveBtn(wrap: HTMLElement, btn: HTMLElement) {
  wrap.querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// ---- Price + Phase ----
export function updatePrice(price: number) {
  const el = document.getElementById('priceDisplay');
  if (el) el.textContent = fmtPrice(price);
}

export function updatePhase(phase: string) {
  const badge = document.getElementById('phaseBadge');
  if (!badge) return;
  badge.textContent = phase.toUpperCase();
  badge.className = `phase-badge phase-${phase}`;
}

// ---- Stats panel ----
export function updateStats(stats: Stats) {
  setText('statTotalLiq',  fmtUSD(stats.total_liq));
  setText('statLongsLiq',  fmtUSD(stats.longs_liq_usd));
  setText('statShortsLiq', fmtUSD(stats.shorts_liq_usd));
  setText('statRate',      fmtUSD(stats.liq_1m_bucket) + '/m');
  const dEl = document.getElementById('statDelta');
  if (dEl) {
    dEl.textContent = fmtDelta(stats.cumulative_delta);
    dEl.className = 'stat-value ' + (stats.cumulative_delta >= 0 ? 'long' : 'short');
  }
  setText('statCascades', String(stats.cascade_count));
  updateExchangeList(stats);
}

export function updateCascadeMeter(pct: number) {
  const bar = document.getElementById('cascadeMeter');
  const lbl = document.getElementById('cascadePct');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = Math.round(pct) + '%';
  if (bar) bar.className = 'meter-bar' + (pct >= 90 ? ' danger' : pct >= 60 ? ' warn' : '');
}

function updateExchangeList(stats: Stats) {
  const wrap = document.getElementById('exchangeList');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const ex of EXCHANGES) {
    const d = stats.exchanges[ex as keyof typeof stats.exchanges];
    if (!d) continue;
    const total = d.long + d.short;
    if (total === 0) continue;
    const row = el('div', 'ex-row');
    row.innerHTML = `
      <span class="ex-name">${ex}</span>
      <span class="ex-long">${fmtUSD(d.long)}</span>
      <span class="ex-short">${fmtUSD(d.short)}</span>`;
    wrap.appendChild(row);
  }
}

// ---- Connection dots ----
export function initConnDots() {
  const wrap = document.getElementById('connDots');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const ex of EXCHANGES) {
    const dot = el('span', 'conn-dot connecting', '');
    dot.id = `dot-${ex}`;
    dot.title = ex;
    wrap.appendChild(dot);
  }
}

export function updateConnDot(exchange: string, status: string) {
  const dot = document.getElementById(`dot-${exchange}`);
  if (dot) dot.className = `conn-dot ${status}`;
  const ct = document.getElementById('wsCount');
  if (ct) ct.textContent = state.connected_ws + ' WS';
}

// ---- Liq Feed ----
export function prependFeedItem(item: FeedItem) {
  const list = document.getElementById('feedList');
  if (!list) return;
  const row = el('div', `feed-item ${item.side} ${sizeClass(item.usd_val)}`);
  row.innerHTML = `
    <span class="fi-ex">${item.exchange.slice(0,3).toUpperCase()}</span>
    <span class="fi-side ${item.side}">${item.side.toUpperCase()}</span>
    <span class="fi-usd">${fmtUSD(item.usd_val)}</span>
    <span class="fi-price">@ ${fmtPrice(item.price)}</span>
    <span class="fi-sym">${item.symbol}</span>
    <span class="fi-time">${fmtTime(item.ts)}</span>`;
  list.insertBefore(row, list.firstChild);
  while (list.children.length > 80) list.removeChild(list.lastChild!);
  const ct = document.getElementById('feedCount');
  if (ct) ct.textContent = String(state.feed.length);
}

export function renderFeed(items: FeedItem[]) {
  const list = document.getElementById('feedList');
  if (!list) return;
  list.innerHTML = '';
  for (const item of items) prependFeedItem(item);
}

// ---- Signal Log ----
export function prependLogItem(item: LogItem) {
  const list = document.getElementById('logList');
  if (!list) return;
  const row = el('div', `log-item log-${item.type}`);
  row.innerHTML = `<span class="log-time">${fmtTime(item.ts)}</span><span class="log-msg">${item.msg}</span>`;
  list.insertBefore(row, list.firstChild);
  while (list.children.length > 60) list.removeChild(list.lastChild!);
}

export function renderLog(items: LogItem[]) {
  const list = document.getElementById('logList');
  if (!list) return;
  list.innerHTML = '';
  for (const item of [...items].reverse()) prependLogItem(item);
}

// ---- helpers ----
function setText(id: string, val: string) {
  const e = document.getElementById(id);
  if (e) e.textContent = val;
}
