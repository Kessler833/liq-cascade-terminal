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
  scrollToLatest, getVisibleLogicalRange, setVisibleLogicalRange,
} from './charts';

// ---- Init charts ----
initPriceChart( document.getElementById('candle-container')!);
initLiqChart(   document.getElementById('liq-container')!);
initDeltaChart( document.getElementById('delta-container')!);
setupChartSync();

// Track last symbol-switch timestamp to discard stale responses
let _lastSwitch = 0;

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
      const data = await api.fetchHistory(sym, state.timeframe, 0);
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
  async (tf)  => { await api.setTimeframe(tf);  state.timeframe = tf; },
  SYMBOLS, TIMEFRAMES,
);

// ---- Message handler ----
onMessage((msg: ServerMsg) => {
  switch (msg.type) {

    case 'snapshot': {
      state.symbol       = msg.symbol;
      state.timeframe    = msg.timeframe;
      state.price        = msg.price;
      state.phase        = msg.phase;
      state.candles      = msg.candles;
      state.liq_bars     = msg.liq_bars;
      state.delta_bars   = msg.delta_bars;
      state.feed         = msg.feed;
      state.signal_log   = msg.signal_log;
      state.stats        = msg.stats;
      state.connected_ws = msg.connected_ws;
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
        state.candles.push(c);
        if (state.candles.length > 300) state.candles.shift();
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
      const connText = msg.status === 'connected' ? 'connected'
                     : msg.status === 'error'     ? 'error — reconnecting in 3s'
                     :                              'connecting...';
      prependLogItem({
        msg: `${msg.exchange.toUpperCase()}: ${connText}`,
        type: msg.status === 'error' ? 'error' : msg.status === 'connected' ? 'conn' : 'warn',
        ts: Date.now(),
      });
      break;
    }

    case 'ws_count': {
      state.connected_ws = msg.count;
      updateStatusBar({ wsCount: msg.count });
      prependLogItem({ msg: `WebSocket feeds: ${msg.count}/6 connected`, type: 'sys', ts: Date.now() });
      break;
    }

    case 'history': {
      state.candles    = msg.candles;
      state.liq_bars   = msg.liq_bars;
      state.delta_bars = msg.delta_bars;
      state.price      = msg.price;
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

// ---- Lazy-load more candles (called by scroll handler when near left edge) ----
export async function loadMoreCandles(fresh: any[]) {
  const savedRange = getVisibleLogicalRange();
  updatePriceChart(state.candles);
  updateLiqChart(state.liq_bars);
  updateDeltaChart(state.delta_bars);
  if (savedRange) {
    setVisibleLogicalRange({
      from: savedRange.from + fresh.length,
      to:   savedRange.to  + fresh.length,
    });
  }
}

// ---- Connect ----
connectWS();

// ---- Resize observer ----
new ResizeObserver(resizeAll).observe(document.getElementById('charts-area') ?? document.body);
