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

# FIX: raised from 300 to 1500 to match the frontend trim limit in main.ts.
# The previous mismatch caused permanent state divergence after ~5 h of
# uptime: the frontend held up to 1500 candles while the backend silently
# discarded everything beyond 300, making history reloads return a much
# shorter series than the client already had rendered.
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
    "XRP": {
        "binance": "xrpusdt",
        "bybit":   "XRPUSDT",
        "okx":     "XRP-USDT-SWAP",
        "bitget":  "XRPUSDT",
        "gate":    "XRP_USDT",
        "dydx":    "XRP-USD",
    },
    "DOGE": {
        "binance": "dogeusdt",
        "bybit":   "DOGEUSDT",
        "okx":     "DOGE-USDT-SWAP",
        "bitget":  "DOGEUSDT",
        "gate":    "DOGE_USDT",
        "dydx":    "DOGE-USD",
    },
    "AVAX": {
        "binance": "avaxusdt",
        "bybit":   "AVAXUSDT",
        "okx":     "AVAX-USDT-SWAP",
        "bitget":  "AVAXUSDT",
        "gate":    "AVAX_USDT",
        "dydx":    "AVAX-USD",
    },
    "LINK": {
        "binance": "linkusdt",
        "bybit":   "LINKUSDT",
        "okx":     "LINK-USDT-SWAP",
        "bitget":  "LINKUSDT",
        "gate":    "LINK_USDT",
        "dydx":    "LINK-USD",
    },
    "SUI": {
        "binance": "suiusdt",
        "bybit":   "SUIUSDT",
        "okx":     "SUI-USDT-SWAP",
        "bitget":  "SUIUSDT",
        "gate":    "SUI_USDT",
        "dydx":    "SUI-USD",
    },
}

CONTRACT_SIZES: dict[str, dict[str, float]] = {
    "BTC":  {"okx": 0.01,  "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "ETH":  {"okx": 0.1,   "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "SOL":  {"okx": 1.0,   "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "XRP":  {"okx": 100.0, "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "DOGE": {"okx": 10.0,  "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "AVAX": {"okx": 1.0,   "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "LINK": {"okx": 1.0,   "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
    "SUI":  {"okx": 1.0,   "dydx": 1.0,  "bybit": 1.0, "binance": 1.0, "bitget": 1.0, "gate": 1.0},
}

DEFAULT_CASCADE_THRESHOLDS: dict[str, float] = {
    "BTC":  25_000_000,
    "ETH":  10_000_000,
    "SOL":  5_000_000,
    "XRP":  3_000_000,
    "DOGE": 2_000_000,
    "AVAX": 2_000_000,
    "LINK": 1_500_000,
    "SUI":  1_500_000,
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
