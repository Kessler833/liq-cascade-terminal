/** DOM update functions — decoupled from chart rendering. */
import { state, type FeedItem, type LogItem, type Stats } from './state';
import { fmtUSD, fmtDelta, fmtPrice, fmtTime, el, sizeClass } from './utils';

const EXCHANGES = ['binance','bybit','okx','bitget','gate','dydx'] as const;

const EX_PREFIX: Record<string, string> = {
  binance: 'bnce', bybit: 'bybt', okx: 'okx',
  bitget:  'bget', gate:  'gate', dydx: 'dydx',
};

const CHART_CONTAINERS = ['candle-container', 'liq-container', 'delta-container'];

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
      btn.classList.add('active');
      if (tab === 'impact') {
        document.getElementById('terminal-screen')?.classList.add('hidden');
        document.getElementById('impact-screen')?.classList.remove('hidden');
      } else {
        document.getElementById('terminal-screen')?.classList.remove('hidden');
        document.getElementById('impact-screen')?.classList.add('hidden');
      }
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

const PHASE_LABELS: Record<string, string> = {
  waiting:  'Waiting for Cascade',
  watching: 'Watching for Delta Flip',
  cascade:  'Cascade Detected!',
  long:     'Long Entry Signal',
  short:    'Short Entry Signal',
};

export function updatePhase(phase: string) {
  // Top-bar badge
  const badge = document.getElementById('phaseBadge');
  if (badge) {
    badge.textContent = phase.toUpperCase();
    badge.className = `phase-badge phase-${phase}`;
  }
  // Strategy bar
  const stratPhase = document.getElementById('stratPhase');
  if (stratPhase) stratPhase.dataset.phase = phase;
  const phaseText = document.getElementById('phaseText');
  if (phaseText) {
    phaseText.textContent = PHASE_LABELS[phase] ?? phase;
    phaseText.dataset.phase = phase;
  }
  // Signal badges
  const sigCascade = document.getElementById('sigCascade');
  const sigLong    = document.getElementById('sigLong');
  const sigShort   = document.getElementById('sigShort');
  if (sigCascade) sigCascade.classList.toggle('active', phase === 'cascade');
  if (sigLong)    sigLong.classList.toggle('active',    phase === 'long');
  if (sigShort)   sigShort.classList.toggle('active',   phase === 'short');
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
  if (bar) bar.className = 'meter-fill' + (pct >= 90 ? ' danger' : pct >= 60 ? ' warn' : '');
}

function updateExchangeList(stats: Stats) {
  setText('totalLiqBadge', fmtUSD(stats.total_liq));
  for (const ex of EXCHANGES) {
    const pfx = EX_PREFIX[ex];
    const d = stats.exchanges[ex as keyof typeof stats.exchanges];
    if (!d) continue;
    setText(`${pfx}-long`,  fmtUSD(d.long));
    setText(`${pfx}-short`, fmtUSD(d.short));
    const total = d.long + d.short;
    const lp = total > 0 ? (d.long  / total * 100) : 50;
    const sp = total > 0 ? (d.short / total * 100) : 50;
    const bl = document.getElementById(`${pfx}-bar-l`);
    const bs = document.getElementById(`${pfx}-bar-s`);
    if (bl) bl.style.width = lp + '%';
    if (bs) bs.style.width = sp + '%';
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

// ---- Candle label ----
export function updateCandleLabel(symbol: string, timeframe: string) {
  const lbl = document.getElementById('candleLabel');
  if (lbl) lbl.textContent = `${symbol}USDT · ${timeframe} · MULTI-EXCHANGE`;
}

// ---- Status bar ----
export function updateStatusBar(opts: {
  symbol?: string; timeframe?: string; candles?: number;
  liqEvents?: number; wsCount?: number; lastUpdate?: boolean;
}) {
  if (opts.symbol    != null) setText('sbSym',      opts.symbol + 'USDT');
  if (opts.timeframe != null) setText('sbTf',       opts.timeframe);
  if (opts.candles   != null) setText('sbCandles',  String(opts.candles));
  if (opts.liqEvents != null) setText('sbLiqEvents', String(opts.liqEvents));
  if (opts.wsCount   != null) setText('sbWS',       opts.wsCount + '/6');
  if (opts.lastUpdate) {
    const now = new Date();
    setText('sbLastUpdate', now.toLocaleTimeString());
  }
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
