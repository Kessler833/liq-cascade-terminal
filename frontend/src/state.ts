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
      conn_status?: Record<string, string> }
  | { type: 'kline';           t: number; o: number; h: number; l: number; c: number; v: number; closed: boolean }
  | { type: 'candle_open';     t: number; o: number; h: number; l: number; c: number; v: number }
  | { type: 'tick';            t: number; o: number; h: number; l: number; c: number; v: number }
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
  timestamp: number;          // ms — first liquidation fired
  entry_price: number;        // price at first liquidation (START price)
  side: Side;
  exchange: string;
  cascade_size: number;

  // volumes
  initial_liq_volume: number;
  total_liq_volume: number;
  liq_remaining: number;

  // delta context
  initial_delta: number;

  // predictions
  initial_expected_price: number;   // first bucket walk prediction
  final_expected_price: number | null; // bucket walk prediction when tank hit zero

  // price outcome
  // START = entry_price (price when first liq fired)
  // END   = tank_empty_price (price when liq_remaining first hit zero)
  // DIFF  = tank_empty_price - entry_price
  tank_empty_ts: number | null;       // ms when tank hit zero
  tank_empty_price: number | null;    // real price at that moment (END)
  price_difference: number | null;    // END - START (signed actual move)

  // kept for DB compat, not shown in main table
  actual_terminal_price: number | null;

  // error: (final_expected - initial_expected) / entry_price * 100
  // i.e. how much did the prediction drift from first to last tick
  price_error_pct: number | null;

  cascade_duration_s: number | null;  // first liq → tank empty
  absorbed_by_delta: boolean;
  label_filled: 0 | 1;

  // L2 book depth tracking
  beyond_cutoff: boolean;
  cutoff_price: number | null;

  // time series: [timestamp_ms, value][]
  delta_series:           [number, number][];
  expected_price_series:  [number, number][];
  price_series:           [number, number][];
  liq_remaining_series:   [number, number][];

  // cascade join events: [timestamp_ms, notional_usd, exchange][]
  cascade_events: [number, number, string][];
}

export interface ImpactStats {
  total: number;
  recording: number;
  avg_err: number | null;
  absorbed: number;
}

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
