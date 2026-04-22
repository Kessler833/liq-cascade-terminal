const state = {
  symbol: 'BTC', timeframe: '5m', price: 0, prevPrice: 0,
  candles: [], liqBars: [], deltaBars: [],
  viewOffset: 0, viewWidth: 80,
  phase: 'waiting', cascadeScore: 0, cascadeThreshold: 5000000,
  lastCascadeEnd: 0, cascadeCount: 0,
  totalLiq: 0, totalLiqEvents: 0, longsLiqUsd: 0, shortsLiqUsd: 0,
  longsLiqEvents: 0, shortsLiqEvents: 0, feedCount: 0, connectedWS: 0,
  exchanges: { binance:{long:0,short:0}, bybit:{long:0,short:0}, okx:{long:0,short:0}, bitget:{long:0,short:0}, gate:{long:0,short:0}, dydx:{long:0,short:0} },
  currentDelta: 0, cumulativeDelta: 0, prevCumulativeDelta: 0,
  liq1mBucket: 0, liq1mTimestamp: 0, _lastScoreDecay: 0
};

const SYMBOL_MAP = {
  BTC: { binance:'btcusdt', bybit:'BTCUSDT', okx:'BTC-USDT-SWAP', bitget:'BTCUSDT', gate:'BTC_USDT', dydx:'BTC-USD' },
  ETH: { binance:'ethusdt', bybit:'ETHUSDT', okx:'ETH-USDT-SWAP', bitget:'ETHUSDT', gate:'ETH_USDT', dydx:'ETH-USD' },
  SOL: { binance:'solusdt', bybit:'SOLUSDT', okx:'SOL-USDT-SWAP', bitget:'SOLUSDT', gate:'SOL_USDT', dydx:'SOL-USD' },
};
const TF_BINANCE = { '1m':'1m','3m':'3m','5m':'5m','15m':'15m','1h':'1h','4h':'4h' };
const TF_MINUTES = { '1m':1,'3m':3,'5m':5,'15m':15,'1h':60,'4h':240 };
const MAX_CANDLES = 500;
const FEED_MAX = 80;

let ws = {};

// Persistent per-symbol liq event store — never cleared on TF/symbol changes
const liqStore = { BTC: [], ETH: [], SOL: [] };

// Contract sizes (in base asset per contract) for normalizing trade volumes across exchanges
const CONTRACT_SIZES = {
  BTC: { binance: 1, bybit: 1, okx: 0.01, bitget: 0.01, gate: 0.01, dydx: 1 },
  ETH: { binance: 1, bybit: 1, okx: 0.1,  bitget: 0.1,  gate: 0.1,  dydx: 1 },
  SOL: { binance: 1, bybit: 1, okx: 1,    bitget: 1,    gate: 1,    dydx: 1 },
};
