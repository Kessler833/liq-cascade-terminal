/**
 * Entry point — wires API, state mutations, and UI/chart updates.
 */
import { connectWS, onMessage, api } from './api';
import {
  state, SYMBOLS, TIMEFRAMES,
  type ServerMsg, type Candle,
} from './state';
import {
  initControls, initConnDots,
  updatePrice, updatePhase, updateStats, updateCascadeMeter,
  updateConnDot, prependFeedItem, renderFeed, renderLog, prependLogItem,
  updateCandleLabel, updateStatusBar,
} from './ui';
import {
  initPriceChart, initLiqChart, initDeltaChart,
  updatePriceChart, updateLiqChart, updateDeltaChart,
  resizeAll, setupChartSync,
  onNearLeftEdge, getVisibleLogicalRange, setVisibleLogicalRange,
  scrollToLatest, fitAllCharts,
} from './charts';

// ---- Init charts ----
initPriceChart( document.getElementById('candle-container')!);
initLiqChart(   document.getElementById('liq-container')!);
initDeltaChart( document.getElementById('delta-container')!);
setupChartSync();

// ---- Lazy-load older candles when user pans to left edge ----
let _loadingMore = false;

async function loadMoreCandles() {
  if (_loadingMore || !state.candles.length) return;
  _loadingMore = true;
  const snapSym = state.symbol;
  const snapTf  = state.timeframe;
  try {
    const before = state.candles[0].t;
    const data = await api.fetchHistory(snapSym, snapTf, before);
    if (state.symbol !== snapSym || state.timeframe !== snapTf) return;
    if (!data.candles?.length) return;
    const tSet = new Set(state.candles.map((c: Candle) => c.t));
    const fresh = data.candles.filter((c: any) => !tSet.has(c.t));
    if (!fresh.length) return;
    const savedRange = getVisibleLogicalRange();
    state.candles    = [...fresh, ...state.candles];
    state.liq_bars   = [...fresh.map((c: any) => ({ t: c.t, long_usd: 0, short_usd: 0 })), ...state.liq_bars];
    state.delta_bars = [...fresh.map((c: any) => ({ t: c.t, delta: 0, cum_delta: 0 })), ...state.delta_bars];
    updatePriceChart(state.candles);
    updateLiqChart(state.liq_bars);
    updateDeltaChart(state.delta_bars);
    if (savedRange) {
      setVisibleLogicalRange({
        from: savedRange.from + fresh.length,
        to:   savedRange.to  + fresh.length,
      });
    }
    prependLogItem({ msg: `Loaded ${fresh.length} older candles`, type: 'info', ts: Date.now() });
    updateStatusBar({ candles: state.candles.length });
  } finally {
    _loadingMore = false;
  }
}

onNearLeftEdge(() => { if (!_loadingMore) loadMoreCandles(); });

// ---- Suppress connection log noise during intentional reconnects ----
let _lastSwitch = 0;
const QUIET_MS = 8000;
function inQuietPeriod() { return Date.now() - _lastSwitch < QUIET_MS; }

// ---- Init controls ----
initConnDots();
initControls(
  async (sym) => {
    _lastSwitch = Date.now();
    prependLogItem({ msg: `Switching to ${sym}...`, type: 'sys', ts: Date.now() });
    api.setSymbol(sym);
    state.symbol = sym;
    try {
      const data = await api.fetchHistory(sym, state.timeframe);
      if (state.symbol !== sym) return;
      if (data.candles?.length) {
        state.candles    = data.candles;
        state.liq_bars   = data.candles.map((c: any) => ({ t: c.t, long_usd: 0, short_usd: 0 }));
        state.delta_bars = data.candles.map((c: any) => ({ t: c.t, delta: 0, cum_delta: 0 }));
        updatePriceChart(state.candles);
        updateLiqChart(state.liq_bars);
        updateDeltaChart(state.delta_bars);
        scrollToLatest();
        updateCandleLabel(sym, state.timeframe);
        updateStatusBar({ symbol: sym, candles: state.candles.length, lastUpdate: true });
      }
    } catch (_e) {}
  },
  async (tf) => {
    _lastSwitch = Date.now();
    prependLogItem({ msg: `Switching to ${tf} timeframe...`, type: 'sys', ts: Date.now() });
    await api.setTimeframe(tf);
    state.timeframe = tf;
  },
  SYMBOLS, TIMEFRAMES,
);

// ---- helpers ----
function rebuildAuxBars(candles: Candle[]) {
  return {
    liq_bars:   candles.map(c => ({ t: c.t, long_usd: 0, short_usd: 0 })),
    delta_bars: candles.map(c => ({ t: c.t, delta: 0, cum_delta: 0 })),
  };
}

function ensureAuxSlot(t: number) {
  if (!state.liq_bars.find(b => b.t === t)) {
    state.liq_bars.push({ t, long_usd: 0, short_usd: 0 });
  }
  if (!state.delta_bars.find(b => b.t === t)) {
    const prevCum = state.delta_bars.at(-1)?.cum_delta ?? 0;
    state.delta_bars.push({ t, delta: 0, cum_delta: prevCum });
  }
}

// ---- Message handler ----
onMessage((msg: ServerMsg) => {
  switch (msg.type) {

    case 'snapshot': {
      state.symbol       = msg.symbol;
      state.timeframe    = msg.timeframe;
      state.price        = msg.price;
      state.phase        = msg.phase;
      state.candles      = msg.candles;
      state.feed         = msg.feed;
      state.signal_log   = msg.signal_log;
      state.stats        = msg.stats;
      state.connected_ws = msg.connected_ws;
      state.liq_bars   = msg.liq_bars?.length   ? msg.liq_bars   : rebuildAuxBars(state.candles).liq_bars;
      state.delta_bars = msg.delta_bars?.length ? msg.delta_bars : rebuildAuxBars(state.candles).delta_bars;
      updatePrice(state.price);
      updatePhase(state.phase);
      updateStats(msg.stats);
      if (msg.conn_status) {
        for (const [ex, status] of Object.entries(msg.conn_status)) {
          state.conn_status[ex] = status;
          updateConnDot(ex, status);
        }
      }
      updatePriceChart(state.candles);
      updateLiqChart(state.liq_bars);
      updateDeltaChart(state.delta_bars);
      scrollToLatest();
      renderFeed(state.feed);
      renderLog(state.signal_log);
      prependLogItem({ msg: `System ready · ${state.symbol} ${state.timeframe} · ${state.candles.length} candles`, type: 'sys', ts: Date.now() });
      updateCandleLabel(state.symbol, state.timeframe);
      updateStatusBar({
        symbol: state.symbol, timeframe: state.timeframe,
        candles: state.candles.length,
        liqEvents: msg.stats.total_liq_events,
        wsCount: state.connected_ws,
        lastUpdate: true,
      });
      break;
    }

    // ---- candle_open: new period started, Binance open price is authoritative ----
    case 'candle_open': {
      const c: Candle = { t: msg.t, o: msg.o, h: msg.h, l: msg.l, c: msg.c, v: msg.v };
      // Only append if not already present (idempotent)
      if (!state.candles.find(x => x.t === c.t)) {
        state.candles.push(c);
        ensureAuxSlot(c.t);
        if (state.candles.length > 1500) {
          state.candles.shift();
          state.liq_bars.shift();
          state.delta_bars.shift();
        }
        updatePriceChart(state.candles);
        updateLiqChart(state.liq_bars);
        updateDeltaChart(state.delta_bars);
        updateStatusBar({ candles: state.candles.length, lastUpdate: true });
      }
      break;
    }

    // ---- Tick: sub-100ms price update from aggTrade (throttled backend-side) ----
    case 'tick': {
      const c: Candle = { t: msg.t, o: msg.o, h: msg.h, l: msg.l, c: msg.c, v: msg.v };
      state.price = msg.c;
      updatePrice(msg.c);
      const idx = state.candles.findLastIndex((x: Candle) => x.t === c.t);
      if (idx >= 0) {
        state.candles[idx] = c;
      } else {
        // candle_open didn't arrive yet or was missed — append as fallback
        state.candles.push(c);
        ensureAuxSlot(c.t);
        if (state.candles.length > 1500) {
          state.candles.shift();
          state.liq_bars.shift();
          state.delta_bars.shift();
        }
      }
      updatePriceChart(state.candles);
      updateStatusBar({ lastUpdate: true });
      break;
    }

    // ---- Kline: candle-close — finalise with authoritative Binance OHLCV ----
    case 'kline': {
      const c: Candle = { t: msg.t, o: msg.o, h: msg.h, l: msg.l, c: msg.c, v: msg.v };
      state.price = msg.c;
      updatePrice(msg.c);
      const idx = state.candles.findIndex(x => x.t === c.t);
      if (idx >= 0) {
        state.candles[idx] = c;
      } else {
        state.candles.push(c);
        if (state.candles.length > 1500) {
          state.candles.shift();
          state.liq_bars.shift();
          state.delta_bars.shift();
        }
      }
      ensureAuxSlot(c.t);
      updatePriceChart(state.candles);
      updateLiqChart(state.liq_bars);
      updateDeltaChart(state.delta_bars);
      updateStatusBar({ candles: state.candles.length, lastUpdate: true });
      break;
    }

    case 'liq': {
      state.stats = msg.stats;
      updateStats(msg.stats);
      const item = {
        exchange: msg.exchange as any,
        side:     msg.side,
        usd_val:  msg.usd_val,
        price:    msg.price,
        symbol:   msg.symbol,
        ts:       msg.ts,
      };
      state.feed.unshift(item);
      prependFeedItem(item);
      updateStatusBar({ liqEvents: msg.stats.total_liq_events, lastUpdate: true });
      break;
    }

    case 'delta': {
      if (state.stats) {
        state.stats.cumulative_delta = msg.cum_delta;
        updateStats(state.stats);
      }
      const last = state.delta_bars.at(-1);
      if (last) {
        last.delta     = msg.bar_delta;
        last.cum_delta = msg.cum_delta;
        updateDeltaChart(state.delta_bars);
      }
      break;
    }

    case 'phase': {
      state.phase = msg.phase;
      updatePhase(msg.phase);
      if (msg.cascade_count !== undefined && state.stats) {
        state.stats.cascade_count = msg.cascade_count;
        updateStats(state.stats);
      }
      const logItem = { msg: msg.text, type: msg.phase, ts: Date.now() };
      state.signal_log.unshift(logItem);
      prependLogItem(logItem);
      break;
    }

    case 'cascade_meter': {
      updateCascadeMeter(msg.pct);
      break;
    }

    case 'conn_status': {
      state.conn_status[msg.exchange] = msg.status;
      updateConnDot(msg.exchange, msg.status);
      if (msg.status === 'error' && !inQuietPeriod()) {
        prependLogItem({
          msg: `${msg.exchange.toUpperCase()}: error — reconnecting`,
          type: 'error',
          ts: Date.now(),
        });
      }
      break;
    }

    case 'ws_count': {
      state.connected_ws = msg.count;
      updateStatusBar({ wsCount: msg.count });
      if (msg.count === 6 && inQuietPeriod()) {
        _lastSwitch = 0;
        prependLogItem({ msg: 'All 6 exchange feeds connected', type: 'conn', ts: Date.now() });
      }
      break;
    }

    case 'history': {
      state.candles = msg.candles;
      state.price   = msg.price;
      _loadingMore  = false;
      state.liq_bars   = msg.liq_bars?.length   ? msg.liq_bars   : rebuildAuxBars(state.candles).liq_bars;
      state.delta_bars = msg.delta_bars?.length ? msg.delta_bars : rebuildAuxBars(state.candles).delta_bars;
      updatePrice(msg.price);
      updatePriceChart(state.candles);
      updateLiqChart(state.liq_bars);
      updateDeltaChart(state.delta_bars);
      scrollToLatest();
      prependLogItem({ msg: `History loaded: ${state.candles.length} candles · ${state.symbol} ${state.timeframe}`, type: 'info', ts: Date.now() });
      updateStatusBar({ candles: state.candles.length, lastUpdate: true });
      break;
    }

    case 'symbol_change': {
      state.symbol = msg.symbol;
      updateCandleLabel(state.symbol, state.timeframe);
      updateStatusBar({ symbol: state.symbol });
      break;
    }

    case 'timeframe_change': {
      state.timeframe = msg.timeframe;
      updateCandleLabel(state.symbol, state.timeframe);
      updateStatusBar({ timeframe: state.timeframe });
      break;
    }

    case 'impact_update': {
      state.impact_obs = msg.observations;
      break;
    }
  }
});

// ---- Connect ----
connectWS();

// ---- Resize observer ----
new ResizeObserver(resizeAll).observe(document.getElementById('charts-area') ?? document.body);
