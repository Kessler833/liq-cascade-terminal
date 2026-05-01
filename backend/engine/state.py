"""Shared application state + all constants.
Python port of js/state.js.
"""
from __future__ import annotations
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_CANDLES = 1500

TF_MINUTES: dict[str, int] = {
    "1m":  1,
    "3m":  3,
    "5m":  5,
    "15m": 15,
    "30m": 30,
    "1h":  60,
    "4h":  240,
    "1d":  1440,
}

TF_BINANCE: dict[str, str] = {
    "1m":  "1m",
    "3m":  "3m",
    "5m":  "5m",
    "15m": "15m",
    "30m": "30m",
    "1h":  "1h",
    "4h":  "4h",
    "1d":  "1d",
}

SYMBOL_MAP: dict[str, dict[str, str]] = {
    "BTC": {
        "binance": "btcusdt",
        "bybit":   "BTCUSDT",
        "okx":     "BTC-USDT-SWAP",
        "bitget":  "BTCUSDT",
        "gate":    "BTC_USDT",
        "dydx":    "BTC-USD",
    },
    "ETH": {
        "binance": "ethusdt",
        "bybit":   "ETHUSDT",
        "okx":     "ETH-USDT-SWAP",
        "bitget":  "ETHUSDT",
        "gate":    "ETH_USDT",
        "dydx":    "ETH-USD",
    },
    "SOL": {
        "binance": "solusdt",
        "bybit":   "SOLUSDT",
        "okx":     "SOL-USDT-SWAP",
        "bitget":  "SOLUSDT",
        "gate":    "SOL_USDT",
        "dydx":    "SOL-USD",
    },
}

CONTRACT_SIZES: dict[str, dict[str, float]] = {
    "BTC": {"okx": 0.01,  "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "ETH": {"okx": 0.1,   "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "SOL": {"okx": 1.0,   "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
}

DEFAULT_CASCADE_THRESHOLDS: dict[str, float] = {
    "BTC":  25_000_000,
    "ETH":  10_000_000,
    "SOL":  5_000_000,
}


def _default_exchanges() -> dict:
    return {
        ex: {"long": 0.0, "short": 0.0}
        for ex in ("binance", "bybit", "okx", "bitget", "gate", "dydx")
    }


@dataclass
class AppState:
    symbol:    str = "BTC"
    timeframe: str = "5m"
    price:     float = 0.0
    phase:     str = "waiting"    # waiting | watching | cascade | long | short

    # Liq stats
    total_liq:         float = 0.0
    total_liq_events:  int   = 0
    longs_liq_usd:     float = 0.0
    shorts_liq_usd:    float = 0.0
    longs_liq_events:  int   = 0
    shorts_liq_events: int   = 0
    liq_1m_bucket:     float = 0.0
    liq_1m_timestamp:  float = 0.0

    # Cascade
    cascade_score:     float = 0.0
    cascade_threshold: float = 25_000_000.0
    cascade_count:     int   = 0
    last_cascade_end:  float = 0.0

    # Delta
    cumulative_delta:      float = 0.0
    prev_cumulative_delta: float = 0.0

    # Trade
    entry_price: float = 0.0

    # Connection
    connected_ws: int = 0
    conn_status: dict = field(default_factory=lambda: {
        ex: "connecting" for ex in ("binance", "bybit", "okx", "bitget", "gate", "dydx")
    })

    # Series
    candles:    list[dict] = field(default_factory=list)
    liq_bars:   list[dict] = field(default_factory=list)
    delta_bars: list[dict] = field(default_factory=list)
    feed:       list[dict] = field(default_factory=list)
    feed_count: int        = 0
    signal_log: list[dict] = field(default_factory=list)

    # Per-exchange totals
    exchanges: dict = field(default_factory=_default_exchanges)

    # Persistent stores (survive symbol/tf changes)
    liq_store:   dict = field(default_factory=lambda: defaultdict(list))
    delta_store: dict = field(default_factory=lambda: defaultdict(list))

    # Per-symbol live price — updated by every exchange's trade handler.
    sym_price: dict = field(default_factory=dict)   # sym -> float

    # Per-symbol current-second net flow (all exchanges combined).
    # Resets every time the wall-clock second advances for that symbol.
    # Used for display / snapshot purposes. DO NOT use in _tick_all delta
    # differencing — use sym_impact_delta instead.
    sym_snapshot_delta: dict = field(default_factory=dict)  # sym -> float

    # Per-symbol monotonically accumulating net flow for impact recording.
    # This counter NEVER resets, so _tick_all can safely difference it at
    # any interval without hitting a phantom spike at second boundaries.
    # strategy.py increments this alongside sym_snapshot_delta on every
    # trade event. impact.py reads only this field.
    sym_impact_delta: dict = field(default_factory=dict)  # sym -> float

    # Performance metrics — measured and broadcast to the frontend every 2s.
    # exchange_latencies: EWMA of (local recv time - exchange event time) in ms.
    # snapshot_calc_us:   time taken by the last flush_dirty() call in microseconds.
    exchange_latencies: dict  = field(default_factory=dict)   # ex -> float ms
    snapshot_calc_us:   float = 0.0

    # Which exchange last provided a price tick for the active symbol.
    # Updated by each exchange trade handler; reset to "binance" on symbol switch.
    price_source: str = "binance"

    # ── Kyle's lambda estimators — one per symbol ────────────────────────────
    # Populated by ConnectionManager.start() after symbols are known.
    # strategy.py feeds every trade tick in; impact.py reads current() at
    # cascade onset and in the close condition check.
    # Type: dict[str, KyleLambda]  — imported lazily to avoid circular imports.
    kyle_lambdas: dict = field(default_factory=dict)   # sym -> KyleLambda

    def reset_stats(self):
        self.total_liq         = 0.0
        self.total_liq_events  = 0
        self.longs_liq_usd     = 0.0
        self.shorts_liq_usd    = 0.0
        self.longs_liq_events  = 0
        self.shorts_liq_events = 0
        self.liq_1m_bucket     = 0.0
        self.cascade_score     = 0.0
        self.cascade_count     = 0
        self.cumulative_delta  = 0.0
        self.prev_cumulative_delta = 0.0
        self.phase             = "waiting"
        self.entry_price       = 0.0
        self.candles           = []
        self.liq_bars          = []
        self.delta_bars        = []
        self.feed              = []
        self.feed_count        = 0
        self.signal_log        = []
        self.exchanges         = _default_exchanges()
        self.price_source      = "binance"
        # sym_price, sym_snapshot_delta, sym_impact_delta,
        # exchange_latencies, snapshot_calc_us, and kyle_lambdas
        # survive symbol switches — estimators keep their baseline history.
