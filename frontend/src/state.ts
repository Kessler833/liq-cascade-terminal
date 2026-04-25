/** Typed client-side mirror of backend AppState + message union types. */

export const SYMBOLS   = ['BTC','ETH','SOL','XRP','DOGE','AVAX','LINK','SUI'] as const;
export const TIMEFRAMES = ['1m','3m','5m','15m','30m','1h','4h','1d']   as const;

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

// ---- server message types ----
export type ServerMsg =
  | { type: 'snapshot';        symbol: string; timeframe: string; price: number; phase: Phase;
      candles: Candle[]; liq_bars: LiqBar[]; delta_bars: DeltaBar[];
      feed: FeedItem[]; signal_log: LogItem[]; stats: Stats; connected_ws: number;
      conn_status?: Record<string, string> }
  | { type: 'kline';           t: number; o: number; h: number; l: number; c: number; v: number; closed: boolean }
  | { type: 'liq';             exchange: string; side: Side; usd_val: number; price: number; symbol: string; ts: number; stats: Stats }
  | { type: 'delta';           cum_delta: number; bar_delta: number; ts: number }
  | { type: 'phase';           phase: Phase; text: string; price: number; cascade_count?: number }
  | { type: 'cascade_meter';   pct: number; score: number }
  | { type: 'conn_status';     exchange: string; status: 'connecting'|'connected'|'error' }
  | { type: 'ws_count';        count: number }
  | { type: 'history';         candles: Candle[]; liq_bars: LiqBar[]; delta_bars: DeltaBar[]; price: number }
  | { type: 'symbol_change';   symbol: string }
  | { type: 'timeframe_change'; timeframe: string }
  | { type: 'impact_update';   observations: ImpactObs[]; stats: ImpactStats };

export interface ImpactObs {
  id: string;
  asset: string;
  timestamp: number;
  entry_price: number;
  side: Side;
  exchange: string;
  cascade_size: number;
  initial_liq_volume: number;
  initial_expected_price: number;
  total_liq_volume: number;
  final_expected_price: number | null;
  actual_terminal_price: number | null;
  price_error_pct: number | null;
  cascade_duration_s: number | null;
  absorbed_by_delta: boolean;
  label_filled: 0 | 1;
}

export interface ImpactStats {
  total: number; recording: number; avg_err: number | null; absorbed: number;
}

// ---- mutable client state ----
export const state = {
  symbol:    'BTC'  as string,
  timeframe: '5m'   as string,
  price:     0,
  phase:     'waiting' as Phase,
  stats:     null   as Stats | null,
  candles:   []     as Candle[],
  liq_bars:  []     as LiqBar[],
  delta_bars:[]     as DeltaBar[],
  feed:      []     as FeedItem[],
  signal_log:[]     as LogItem[],
  connected_ws: 0,
  conn_status: {} as Record<string, string>,
  impact_obs: []    as ImpactObs[],
};
