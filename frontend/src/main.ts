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
  updateLastCandle, resizeAll, setupChartSync,
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
    // Abort if symbol/TF changed while the request was in flight
    if (state.symbol !== snapSym || state.timeframe !== snapTf) return;
    if (!data.candles?.length) return;
    // Deduplicate against existing candles
    const tSet = new Set(state.candles.map((c: Candle) => c.t));
    const fresh = data.candles.filter((c: any) => !tSet.has(c.t));
    if (!fresh.length) return;
    // Save viewport position before prepend to avoid snap
    const savedRange = getVisibleLogicalRange();
    state.candles    = [...fresh, ...state.candles];
    state.liq_bars   = [...fresh.map((c: any) => ({ t: c.t, long_usd: 0, short_usd: 0 })), ...state.liq_bars];
    state.delta_bars = [...fresh.map((c: any) => ({ t: c.t, delta: 0, cum_delta: 0 })), ...state.delta_bars];
    updatePriceChart(state.candles);
    updateLiqChart(state.liq_bars);
    updateDeltaChart(state.delta_bars);
    // Shift viewport by the number of prepended candles
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
    api.setSymbol(sym);          // fire-and-forget — backend reconnects in background
    state.symbol = sym;
    // Immediately fetch REST history so chart updates within ~1s
    try {
      const data = await api.fetchHistory(sym, state.timeframe);
      if (state.symbol !== sym) return;  // user switched again before response
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
    } catch (_e) {
      // Backend will push history via WS history message shortly
    }
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

/**
 * Rebuild liq_bars and delta_bars aligned to a candle array.
 * Used when the server sends empty auxiliary arrays (e.g. right after
 * reset_stats() clears them before the new history is fetched).
 */
function rebuildAuxBars(candles: Candle[]) {
  return {
    liq_bars:   candles.map(c => ({ t: c.t, long_usd: 0, short_usd: 0 })),
    delta_bars: candles.map(c => ({ t: c.t, delta: 0, cum_delta: 0 })),
  };
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
      // Rebuild aux bars if server sends empty arrays
      if (msg.liq_bars?.length) {
        state.liq_bars = msg.liq_bars;
      } else {
        state.liq_bars = rebuildAuxBars(state.candles).liq_bars;
      }
      if (msg.delta_bars?.length) {
        state.delta_bars = msg.delta_bars;
      } else {
        state.delta_bars = rebuildAuxBars(state.candles).delta_bars;
      }
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

    case 'kline': {
      const c: Candle = { t: msg.t, o: msg.o, h: msg.h, l: msg.l, c: msg.c, v: msg.v };
      state.price = msg.c;
      updatePrice(msg.c);
      if (msg.closed) {
        const idx = state.candles.findIndex(x => x.t === c.t);
        if (idx >= 0) {
          state.candles[idx] = c;
        } else {
          state.candles.push(c);
          // Also extend aux bars so delta/liq handlers have a slot to write into
          state.liq_bars.push({ t: c.t, long_usd: 0, short_usd: 0 });
          state.delta_bars.push({ t: c.t, delta: 0, cum_delta: state.delta_bars.at(-1)?.cum_delta ?? 0 });
          if (state.candles.length > 1500) {
            state.candles.shift();
            state.liq_bars.shift();
            state.delta_bars.shift();
          }
        }
        updatePriceChart(state.candles);
        updateStatusBar({ candles: state.candles.length, lastUpdate: true });
      } else {
        updateLastCandle(c);
        updateStatusBar({ lastUpdate: true });
      }
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
      // If backend sends empty aux arrays (race during reset_stats), rebuild
      // them from candles so delta/liq handlers always have a valid slot.
      if (msg.liq_bars?.length) {
        state.liq_bars = msg.liq_bars;
      } else {
        state.liq_bars = rebuildAuxBars(state.candles).liq_bars;
      }
      if (msg.delta_bars?.length) {
        state.delta_bars = msg.delta_bars;
      } else {
        state.delta_bars = rebuildAuxBars(state.candles).delta_bars;
      }
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
