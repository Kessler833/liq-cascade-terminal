"""Shared application state — Python port of state.js + constants."""
from __future__ import annotations
import time
from typing import Any

# ---------------------------------------------------------------------------
# Symbol / TF maps (mirrors state.js)
# ---------------------------------------------------------------------------
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

TF_BINANCE: dict[str, str] = {
    "1m": "1m", "3m": "3m", "5m": "5m",
    "15m": "15m", "1h": "1h", "4h": "4h",
}

TF_MINUTES: dict[str, int] = {
    "1m": 1, "3m": 3, "5m": 5,
    "15m": 15, "1h": 60, "4h": 240,
}

MAX_CANDLES = 500
FEED_MAX = 80

CONTRACT_SIZES: dict[str, dict[str, float]] = {
    "BTC": {"binance": 1, "bybit": 1, "okx": 0.01, "bitget": 0.01, "gate": 0.01, "dydx": 1},
    "ETH": {"binance": 1, "bybit": 1, "okx": 0.1,  "bitget": 0.1,  "gate": 0.1,  "dydx": 1},
    "SOL": {"binance": 1, "bybit": 1, "okx": 1,    "bitget": 1,    "gate": 1,    "dydx": 1},
}


# ---------------------------------------------------------------------------
# AppState
# ---------------------------------------------------------------------------
class AppState:
    """Single shared state object, mutated by engine modules."""

    def __init__(self):
        self.symbol: str = "BTC"
        self.timeframe: str = "5m"
        self.price: float = 0.0
        self.prev_price: float = 0.0

        # Candle / liq / delta series
        self.candles: list[dict] = []
        self.liq_bars: list[dict] = []
        self.delta_bars: list[dict] = []

        # View
        self.view_offset: int = 0
        self.view_width: int = 80

        # Strategy
        self.phase: str = "waiting"
        self.phase_text: str = "Waiting for Cascade"
        self.cascade_score: float = 0.0
        self.cascade_threshold: float = 5_000_000.0
        self.last_cascade_end: float = 0.0
        self.cascade_count: int = 0
        self.entry_price: float = 0.0

        # Stats
        self.total_liq: float = 0.0
        self.total_liq_events: int = 0
        self.longs_liq_usd: float = 0.0
        self.shorts_liq_usd: float = 0.0
        self.longs_liq_events: int = 0
        self.shorts_liq_events: int = 0
        self.feed_count: int = 0
        self.connected_ws: int = 0

        # Per-exchange breakdown
        self.exchanges: dict[str, dict[str, float]] = {
            ex: {"long": 0.0, "short": 0.0}
            for ex in ("binance", "bybit", "okx", "bitget", "gate", "dydx")
        }

        # Delta
        self.current_delta: float = 0.0
        self.cumulative_delta: float = 0.0
        self.prev_cumulative_delta: float = 0.0

        # 1m liq rate bucket
        self.liq_1m_bucket: float = 0.0
        self.liq_1m_timestamp: float = 0.0
        self._last_score_decay: float = 0.0

        # Persistent stores (survive symbol/TF switches)
        self.liq_store: dict[str, list] = {"BTC": [], "ETH": [], "SOL": []}
        self.delta_store: dict[str, list] = {"BTC": [], "ETH": [], "SOL": []}

        # Feed log (last FEED_MAX items)
        self.feed: list[dict] = []
        self.signal_log: list[dict] = []

    # ------------------------------------------------------------------
    def reset_for_symbol(self, sym: str):
        self.symbol = sym
        self.phase = "waiting"
        self.phase_text = "Waiting for Cascade"
        self.cascade_score = 0.0
        self.cumulative_delta = 0.0
        self.prev_cumulative_delta = 0.0
        self.candles = []
        self.liq_bars = []
        self.delta_bars = []
        self.total_liq = 0.0
        self.total_liq_events = 0
        self.longs_liq_usd = 0.0
        self.shorts_liq_usd = 0.0
        self.longs_liq_events = 0
        self.shorts_liq_events = 0
        for k in self.exchanges:
            self.exchanges[k] = {"long": 0.0, "short": 0.0}
        self.connected_ws = 0

    def reset_for_tf(self):
        self.candles = []
        self.liq_bars = []
        self.delta_bars = []
        self.cumulative_delta = 0.0
        self.prev_cumulative_delta = 0.0
        self.connected_ws = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol":               self.symbol,
            "timeframe":            self.timeframe,
            "price":                self.price,
            "phase":                self.phase,
            "phase_text":           self.phase_text,
            "cascade_score":        self.cascade_score,
            "cascade_threshold":    self.cascade_threshold,
            "cascade_count":        self.cascade_count,
            "total_liq":            self.total_liq,
            "total_liq_events":     self.total_liq_events,
            "longs_liq_usd":        self.longs_liq_usd,
            "shorts_liq_usd":       self.shorts_liq_usd,
            "longs_liq_events":     self.longs_liq_events,
            "shorts_liq_events":    self.shorts_liq_events,
            "cumulative_delta":     self.cumulative_delta,
            "liq_1m_bucket":        self.liq_1m_bucket,
            "connected_ws":         self.connected_ws,
            "exchanges":            self.exchanges,
            "candles":              self.candles[-MAX_CANDLES:],
            "liq_bars":             self.liq_bars,
            "delta_bars":           self.delta_bars,
        }
