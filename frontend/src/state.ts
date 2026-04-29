/** Typed client-side mirror of backend AppState + message union types. */

export const SYMBOLS   = ['BTC', 'ETH', 'SOL'] as const;
export const TIMEFRAMES = ['1m','3m','5m','15m','30m','1h','4h','1d'] as const;

export type Symbol    = typeof SYMBOLS[number];
export type Timeframe = typeof TIMEFRAMES[number];
export type Phase     = 'waiting' | 'watching' | 'cascade' | 'long' | 'short';
export type Side      = 'long' | 'short';
export type ExchangeName = 'binance'|'bybit'|'okx'|'bitget'|'gate'|'dydx';

export interface Candle {
  t: number; o: number; h: number; l: number; c: number; v: number;
  closed?: boolean;
  signal?: 'cascade'|'long'|'short'|'exit';
}

export interface LiqBar   { t: number; long_usd: number; short_usd: number; }
export interface DeltaBar { t: number; delta: number; cum_delta: number; }

export interface FeedItem {
  exchange: ExchangeName;
  side: Side;
  usd_val: number;
  price: number;
  symbol: string;
  ts: number;
}

export interface LogItem {
  msg: string;
  type: string;
  ts: number;
}

export interface Stats {
  total_liq: number;
  total_liq_events: number;
  longs_liq_usd: number;
  shorts_liq_usd: number;
  cascade_score: number;
  cascade_count: number;
  cumulative_delta: number;
  liq_1m_bucket: number;
  exchanges: Record<ExchangeName, { long: number; short: number }>;
}

export type ServerMsg =
  | { type: 'snapshot';        symbol: string; timeframe: string; price: number; phase: Phase;
      candles: Candle[]; liq_bars: LiqBar[]; delta_bars: DeltaBar[];
      feed: FeedItem[]; signal_log: LogItem[]; stats: Stats; connected_ws: number;
      conn_status?: Record<string, string>; price_source?: string }
  | { type: 'kline';           t: number; o: number; h: number; l: number; c: number; v: number; closed: boolean }
  | { type: 'candle_open';     t: number; o: number; h: number; l: number; c: number; v: number }
  | { type: 'tick';            t: number; o: number; h: number; l: number; c: number; v: number }
  | { type: 'liq';             exchange: ExchangeName; side: Side; usd_val: number; price: number; symbol: string; ts: number; stats: Stats }
  | { type: 'delta';           bar_delta: number; cum_delta: number }
  | { type: 'phase';           phase: Phase; text: string; cascade_count?: number }
  | { type: 'cascade_meter';   pct: number }
  | { type: 'conn_status';     exchange: string; status: string }
  | { type: 'ws_count';        count: number }
  | { type: 'history';         candles: Candle[]; liq_bars?: LiqBar[]; delta_bars?: DeltaBar[]; price: number }
  | { type: 'symbol_change';   symbol: string }
  | { type: 'timeframe_change'; timeframe: string }
  | { type: 'impact_update';   observations: any[]; stats: any }
  | { type: 'pong';            ts: number }
  | { type: 'perf';            snapshot_calc_us: number; exchange_latencies: Record<string, number>; price_source: string };
