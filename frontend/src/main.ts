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
} from './ui';
import {
  initPriceChart, initLiqChart, initDeltaChart, initImpactChart,
  updatePriceChart, updateLiqChart, updateDeltaChart, updateImpactChart,
  updateLastCandle, resizeAll,
} from './charts';

// ---- Init charts ----
initPriceChart( document.getElementById('priceChart')!);
initLiqChart(   document.getElementById('liqChart')!);
initDeltaChart( document.getElementById('deltaChart')!);
initImpactChart(document.getElementById('impactChart')!);

// ---- Init controls ----
initConnDots();
initControls(
  async (sym)  => { await api.setSymbol(sym);    state.symbol    = sym; },
  async (tf)   => { await api.setTimeframe(tf);  state.timeframe = tf; },
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
      updatePriceChart(state.candles);
      updateLiqChart(state.liq_bars);
      updateDeltaChart(state.delta_bars);
      renderFeed(state.feed);
      renderLog(state.signal_log);
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
      } else {
        updateLastCandle(c);
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
      break;
    }

    case 'cascade_meter': {
      updateCascadeMeter(msg.pct);
      break;
    }

    case 'conn_status': {
      state.conn_status[msg.exchange] = msg.status;
      updateConnDot(msg.exchange, msg.status);
      break;
    }

    case 'ws_count': {
      state.connected_ws = msg.count;
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
      break;
    }

    case 'symbol_change': {
      state.symbol = msg.symbol;
      break;
    }

    case 'timeframe_change': {
      state.timeframe = msg.timeframe;
      break;
    }

    case 'impact_update': {
      state.impact_obs = msg.observations;
      updateImpactChart(msg.observations);
      break;
    }
  }
});

// ---- Connect ----
connectWS();

// ---- Resize observer ----
new ResizeObserver(resizeAll).observe(document.querySelector('.chart-panel') ?? document.body);
