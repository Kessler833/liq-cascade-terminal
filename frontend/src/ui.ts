/** DOM update functions — uses original HTML element IDs and CSS classes. */
import { state, type FeedItem, type LogItem, type Stats } from './state';
import { fmtUSD, fmtDelta, fmtPrice, fmtTime, el } from './utils';

const EXCHANGES = ['binance','bybit','okx','bitget','gate','dydx'] as const;

const EX_PREFIX: Record<string, string> = {
  binance: 'bnce', bybit: 'bybt', okx: 'okx',
  bitget:  'bget', gate:  'gate', dydx: 'dydx',
};

const CONN_LABEL: Record<string, string> = {
  binance: 'BNCE', bybit: 'BYBT', okx: 'OKX',
  bitget:  'BGET', gate:  'GATE', dydx: 'DYDX',
};

// ---- Symbol / TF / Screen buttons ----
export function initControls(
  onSymbol: (s: string) => void,
  onTF:     (tf: string) => void,
  symbols:   readonly string[],
  timeframes: readonly string[],
) {
  const symWrap = document.getElementById('symbolBtns')!;
  const tfWrap  = document.getElementById('tfBtns')!;

  for (const s of symbols) {
    const b = el('button', 'sym-tab' + (s === state.symbol ? ' active' : ''), s);
    b.addEventListener('click', () => { onSymbol(s); setActiveBtn(symWrap, b); });
    symWrap.appendChild(b);
  }
  for (const tf of timeframes) {
    const b = el('button', 'tf-tab' + (tf === state.timeframe ? ' active' : ''), tf);
    b.addEventListener('click', () => { onTF(tf); setActiveBtn(tfWrap, b); });
    tfWrap.appendChild(b);
  }

  // Screen tab switching (TERMINAL / IMPACT)
  document.querySelectorAll('.screen-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const screen = (btn as HTMLElement).dataset.screen!;
      document.querySelectorAll('.screen-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (screen === 'impact') {
        document.getElementById('terminal-screen')?.classList.add('hidden');
        document.getElementById('impact-screen')?.classList.remove('hidden');
        document.getElementById('strategy-bar')?.classList.add('hidden');
      } else {
        document.getElementById('terminal-screen')?.classList.remove('hidden');
        document.getElementById('impact-screen')?.classList.add('hidden');
        document.getElementById('strategy-bar')?.classList.remove('hidden');
      }
    });
  });
}

function setActiveBtn(wrap: HTMLElement, btn: HTMLElement) {
  wrap.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// ---- Price ----
export function updatePrice(price: number) {
  const e = document.getElementById('priceDisplay');
  if (e) e.textContent = fmtPrice(price);
}

// ---- Phase ----
const PHASE_LABELS: Record<string, string> = {
  waiting:  'Waiting for Cascade',
  watching: 'Watching for Delta Flip',
  cascade:  'Cascade Detected!',
  long:     'Long Entry Signal',
  short:    'Short Entry Signal',
};

export function updatePhase(phase: string) {
  const stratPhase = document.getElementById('stratPhase');
  if (stratPhase) stratPhase.dataset.phase = phase;
  const phaseText = document.getElementById('phaseText');
  if (phaseText) {
    phaseText.textContent = PHASE_LABELS[phase] ?? phase;
    phaseText.dataset.phase = phase;
  }
  document.getElementById('sigCascade')?.classList.toggle('active', phase === 'cascade');
  document.getElementById('sigLong')?.classList.toggle('active',    phase === 'long');
  document.getElementById('sigShort')?.classList.toggle('active',   phase === 'short');
}

// ---- Stats panel ----
export function updateStats(stats: Stats) {
  setText('stat-total',    fmtUSD(stats.total_liq));
  setText('stat-total-sub', stats.total_liq_events + ' events');
  setText('stat-cascades', String(stats.cascade_count));
  setText('stat-longs',    fmtUSD(stats.longs_liq_usd));
  setText('stat-shorts',   fmtUSD(stats.shorts_liq_usd));
  setText('liqRate1m',     fmtUSD(stats.liq_1m_bucket) + '/m');
  // Delta display with color
  const dEl = document.getElementById('deltaDisplay');
  if (dEl) {
    dEl.textContent = fmtDelta(stats.cumulative_delta);
    dEl.style.color = stats.cumulative_delta >= 0
      ? 'var(--green)'
      : 'var(--red)';
  }
  updateExchangeList(stats);
}

export function updateCascadeMeter(pct: number) {
  const bar = document.getElementById('cascadeMeter');
  const lbl = document.getElementById('cascadeVal');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = Math.round(pct) + '%';
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

// ---- Connection dots (label + dot pairs) ----
export function initConnDots() {
  const wrap = document.getElementById('connDots');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const ex of EXCHANGES) {
    const label = el('div', 'conn-label', CONN_LABEL[ex]);
    const dot   = el('div', 'conn-dot connecting', '');
    dot.id    = `dot-${ex}`;
    dot.title = ex;
    wrap.appendChild(label);
    wrap.appendChild(dot);
  }
}

export function updateConnDot(exchange: string, status: string) {
  const dot = document.getElementById(`dot-${exchange}`);
  if (dot) dot.className = `conn-dot ${status}`;
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
  if (opts.symbol    != null) setText('sbSym',       opts.symbol + 'USDT');
  if (opts.timeframe != null) setText('sbTf',        opts.timeframe);
  if (opts.candles   != null) setText('sbCandles',   String(opts.candles));
  if (opts.liqEvents != null) setText('sbLiqEvents', String(opts.liqEvents));
  if (opts.wsCount   != null) setText('sbWS',        opts.wsCount + '/6');
  if (opts.lastUpdate) setText('sbLastUpdate', new Date().toLocaleTimeString());
}

// ---- Liq Feed ----
export function prependFeedItem(item: FeedItem) {
  const list = document.getElementById('liq-feed');
  if (!list) return;
  const row = el('div', `feed-item ${item.side}`);
  row.innerHTML = `
    <span class="feed-exch">${item.exchange.slice(0,4).toUpperCase()}</span>
    <span class="feed-side">${item.side.toUpperCase()}</span>
    <span class="feed-sym">${item.symbol}</span>
    <span class="feed-size">${fmtUSD(item.usd_val)}</span>
    <span class="feed-price">@ ${fmtPrice(item.price)}</span>
    <span class="feed-time">${fmtTime(item.ts)}</span>`;
  list.insertBefore(row, list.firstChild);
  while (list.children.length > 80) list.removeChild(list.lastChild!);
  const ct = document.getElementById('feedCount');
  if (ct) ct.textContent = String(state.feed.length);
}

export function renderFeed(items: FeedItem[]) {
  const list = document.getElementById('liq-feed');
  if (!list) return;
  list.innerHTML = '';
  for (const item of items) prependFeedItem(item);
}

// ---- Signal Log ----
export function prependLogItem(item: LogItem) {
  const list = document.getElementById('signal-log');
  if (!list) return;
  const row = el('div', 'log-entry');
  row.dataset.type = item.type;
  row.innerHTML = `
    <span class="log-time">${fmtTime(item.ts)}</span>
    <span class="log-tag ${item.type}">${item.type.toUpperCase()}</span>
    <span class="log-msg">${item.msg}</span>`;
  list.insertBefore(row, list.firstChild);
  while (list.children.length > 200) list.removeChild(list.lastChild!);
}

export function renderLog(items: LogItem[]) {
  const list = document.getElementById('signal-log');
  if (!list) return;
  list.innerHTML = '';
  for (const item of [...items].reverse()) prependLogItem(item);
}

// ---- helpers ----
function setText(id: string, val: string) {
  const e = document.getElementById(id);
  if (e) e.textContent = val;
}
