"""Cascade detection, delta tracking, liquidation handling, phase transitions.
Python port of strategy.js.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from typing import TYPE_CHECKING, Callable, Awaitable

if TYPE_CHECKING:
    from engine.state import AppState
    from engine.l2_model import L2Model

log = logging.getLogger("liqterm.strategy")

# Rolling 60s window for the /m rate display.
# Each entry is (timestamp_s, usd_val).
_LIQ_WINDOW_S = 60.0


class Strategy:
    def __init__(
        self,
        app_state: "AppState",
        l2_model: "L2Model",
        broadcast: Callable[[dict], Awaitable[None]],
    ):
        self._s = app_state
        self._l2 = l2_model
        self._broadcast = broadcast
        self._last_tick_ms: int = 0
        self._tick_throttle_ms: int = 100
        # FIX: rolling deque replaces the hard-reset liq_1m_bucket.
        # Each entry is (wall_time_s, usd_val). Entries older than 60s are
        # evicted on every liquidation, so the window is always current.
        self._liq_window: deque[tuple[float, float]] = deque()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _candle_bucket(self, ts_ms: int) -> int:
        """Return the candle open-time (ms) that ts_ms falls into."""
        candles = self._s.candles
        if not candles:
            from engine.state import TF_MINUTES
            tf_ms = TF_MINUTES[self._s.timeframe] * 60_000
            return (ts_ms // tf_ms) * tf_ms

        if ts_ms < candles[0]["t"]:
            return candles[0]["t"]

        if ts_ms >= candles[-1]["t"]:
            return candles[-1]["t"]

        lo, hi = 0, len(candles) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if candles[mid]["t"] <= ts_ms:
                lo = mid
            else:
                hi = mid - 1
        return candles[lo]["t"]

    # ------------------------------------------------------------------
    # Candle helpers
    # ------------------------------------------------------------------
    def apply_liq_store(self, sym: str, tf: str):
        from engine.state import TF_MINUTES
        tf_ms = TF_MINUTES[tf] * 60_000
        for ev in self._s.liq_store.get(sym, []):
            bt = (ev["t"] // tf_ms) * tf_ms
            lb = next((b for b in self._s.liq_bars if b["t"] == bt), None)
            if lb is None:
                lb = {"t": bt, "long_usd": 0.0, "short_usd": 0.0}
                self._s.liq_bars.append(lb)
                self._s.liq_bars.sort(key=lambda b: b["t"])
            if ev["side"] == "long":
                lb["long_usd"] += ev["usd_val"]
            else:
                lb["short_usd"] += ev["usd_val"]

    def apply_delta_store(self, sym: str, tf: str):
        from engine.state import TF_MINUTES
        tf_ms = TF_MINUTES[tf] * 60_000
        grouped: dict[int, float] = {}
        for b in sorted(self._s.delta_store.get(sym, []), key=lambda x: x["t"]):
            bt = (b["t"] // tf_ms) * tf_ms
            grouped[bt] = grouped.get(bt, 0.0) + b["delta"]
        cum = 0.0
        for t in sorted(grouped):
            cum += grouped[t]
            db = next((b for b in self._s.delta_bars if b["t"] == t), None)
            if db is None:
                db = {"t": t, "delta": 0.0, "cum_delta": 0.0}
                self._s.delta_bars.append(db)
            # FIX: use assignment (=) not augmented assignment (+=).
            # apply_delta_store rebuilds delta_bars from scratch after a
            # history re-fetch, so += would double-count on repeated calls.
            db["delta"] = grouped[t]
            db["cum_delta"] = cum
        self._s.delta_bars.sort(key=lambda b: b["t"])
        if cum != 0:
            self._s.cumulative_delta = cum
            self._s.prev_cumulative_delta = cum

    def update_candle(self, c: dict, is_closed: bool):
        """Create or update a candle. Called by kline handler only."""
        from engine.state import MAX_CANDLES
        existing = next((x for x in self._s.candles if x["t"] == c["t"]), None)
        if existing:
            existing.update(c)
            if is_closed:
                existing["closed"] = True
        else:
            self._s.candles.append(c)
            self._s.candles.sort(key=lambda x: x["t"])
            if len(self._s.candles) > MAX_CANDLES:
                self._s.candles.pop(0)
            self._s.liq_bars.append({"t": c["t"], "long_usd": 0.0, "short_usd": 0.0})
            self._s.delta_bars.append({"t": c["t"], "delta": 0.0, "cum_delta": self._s.cumulative_delta})

    # ------------------------------------------------------------------
    # Price tick — called by ALL exchange trade handlers
    # ------------------------------------------------------------------
    async def update_price_tick(self, price: float, notional: float, ts_ms: int, event_sym: str):
        """Update the live candle from a multi-exchange trade tick.

        CONTRACT:
        - Only processes ticks for the active symbol.
        - NEVER creates a new candle.
        - NEVER touches the candle open.
        - Skips candles marked as closed (phantom wick guard).
        - Rejects ticks deviating >1.5% from last known price (spike guard).
        """
        if event_sym != self._s.symbol:
            return
        if price <= 0 or not self._s.candles:
            return

        bt = self._candle_bucket(ts_ms)
        cb = next((c for c in self._s.candles if c["t"] == bt), None)
        if cb is None:
            return

        # Phantom wick guard: don't update a candle already closed by kline x=true.
        if cb.get("closed"):
            return

        # Spike guard: reject ticks that deviate more than 1.5% from the last
        # known price. Guards against stale/erroneous ticks from non-Binance
        # exchanges. Binance kline x=true always overwrites with authoritative
        # OHLCV on close, so legitimate fast moves are unaffected.
        # Nudge threshold to 2% for highly volatile assets (SUI, DOGE) if needed.
        if self._s.price > 0 and abs(price - self._s.price) / self._s.price > 0.015:
            return

        # Update close, high, low, volume — open is NEVER touched.
        cb["c"] = price
        if price > cb["h"]:
            cb["h"] = price
        if price < cb["l"]:
            cb["l"] = price
        cb["v"] = cb.get("v", 0.0) + notional
        self._s.price = price

        now_ms = int(time.time() * 1000)
        if now_ms - self._last_tick_ms >= self._tick_throttle_ms:
            self._last_tick_ms = now_ms
            await self._broadcast({
                "type": "tick",
                "t":    cb["t"],
                "o":    cb["o"],
                "h":    cb["h"],
                "l":    cb["l"],
                "c":    price,
                "v":    cb["v"],
            })

    # ------------------------------------------------------------------
    # Delta
    # ------------------------------------------------------------------
    async def update_delta(self, vol_delta: float, ts_ms: int, event_sym: str):
        if not math.isfinite(vol_delta) or vol_delta == 0:
            return
        s = self._s

        # Always persist to delta_store for this symbol — survives symbol switches.
        bt1m = (ts_ms // 60_000) * 60_000
        sb = next((b for b in s.delta_store[event_sym] if b["t"] == bt1m), None)
        if sb is None:
            sb = {"t": bt1m, "delta": 0.0}
            s.delta_store[event_sym].append(sb)
        sb["delta"] += vol_delta

        # Live display and phase logic only for the active symbol.
        if event_sym != s.symbol:
            return

        s.cumulative_delta += vol_delta

        bt = self._candle_bucket(ts_ms)
        db = next((b for b in s.delta_bars if b["t"] == bt), None)
        if db is None:
            db = {"t": bt, "delta": 0.0, "cum_delta": s.cumulative_delta}
            s.delta_bars.append(db)
            s.delta_bars.sort(key=lambda b: b["t"])
        db["delta"] += vol_delta
        db["cum_delta"] = s.cumulative_delta

        prev, cur = s.prev_cumulative_delta, s.cumulative_delta
        if s.phase == "watching":
            if (prev < 0 and cur > 0):
                await self._on_delta_flip("bullish")
            elif (prev > 0 and cur < 0):
                await self._on_delta_flip("bearish")
        elif s.phase in ("long", "short"):
            if (s.phase == "long" and cur < 0) or (s.phase == "short" and cur > 0):
                await self._on_delta_flip("exit")
        s.prev_cumulative_delta = cur

        await self._broadcast({
            "type": "delta",
            "cum_delta": s.cumulative_delta,
            "bar_delta": db["delta"],
            "ts": ts_ms,
        })

    # ------------------------------------------------------------------
    # Liquidation
    # ------------------------------------------------------------------
    async def on_liquidation(
        self,
        exchange: str,
        side: str,
        usd_val: float,
        price: float,
        symbol: str,
        event_sym: str,   # canonical symbol key e.g. "BTC"
    ):
        if usd_val < 100:
            return
        s = self._s
        now_ms = int(time.time() * 1000)

        # Always persist under the event's own symbol — captured for all symbols
        # regardless of which is currently displayed.
        s.liq_store[event_sym].append({
            "t": now_ms, "exchange": exchange,
            "side": side, "usd_val": usd_val, "price": price,
        })

        # Display updates only for the active symbol.
        if event_sym != s.symbol:
            return

        s.total_liq += usd_val
        s.total_liq_events += 1
        if side == "long":
            s.longs_liq_usd += usd_val
            s.longs_liq_events += 1
        else:
            s.shorts_liq_usd += usd_val
            s.shorts_liq_events += 1
        s.exchanges[exchange][side] += usd_val

        bt = self._candle_bucket(now_ms)
        lb = next((b for b in s.liq_bars if b["t"] == bt), None)
        if lb is None:
            lb = {"t": bt, "long_usd": 0.0, "short_usd": 0.0}
            s.liq_bars.append(lb)
        if side == "long":
            lb["long_usd"] += usd_val
        else:
            lb["short_usd"] += usd_val

        # FIX: rolling 60s window instead of hard-reset bucket.
        # Evict entries older than 60s, append current event, then sum the window.
        now_s = time.time()
        self._liq_window.append((now_s, usd_val))
        while self._liq_window and self._liq_window[0][0] < now_s - _LIQ_WINDOW_S:
            self._liq_window.popleft()
        s.liq_1m_bucket = sum(v for _, v in self._liq_window)

        await self._detect_cascade(usd_val)

        sym_short = (symbol
            .replace("USDT", "")
            .replace("-USDT-SWAP", "")
            .replace("-USD", "")
            .replace("_USDT", ""))
        s.feed_count += 1
        feed_item = {
            "exchange": exchange, "side": side,
            "usd_val": usd_val, "price": price,
            "symbol": sym_short, "ts": now_ms,
        }
        s.feed.insert(0, feed_item)
        if len(s.feed) > 80:
            s.feed.pop()

        await self._broadcast({
            "type": "liq",
            "exchange": exchange,
            "side": side,
            "usd_val": usd_val,
            "price": price,
            "symbol": sym_short,
            "ts": now_ms,
            "stats": {
                "total_liq":         s.total_liq,
                "total_liq_events":  s.total_liq_events,
                "longs_liq_usd":     s.longs_liq_usd,
                "shorts_liq_usd":    s.shorts_liq_usd,
                "liq_1m_bucket":     s.liq_1m_bucket,
                "cascade_score":     s.cascade_score,
                "cascade_count":     s.cascade_count,
                "cumulative_delta":  s.cumulative_delta,
                "exchanges":         s.exchanges,
            },
        })

    # ------------------------------------------------------------------
    # Cascade detection
    # ------------------------------------------------------------------
    async def _detect_cascade(self, usd_val: float):
        s = self._s
        T = s.cascade_threshold
        now = time.time()
        s.cascade_score += usd_val

        if s.cascade_score >= T and s.phase == "waiting":
            s.phase = "cascade"
            s.cascade_count += 1
            s.last_cascade_end = now
            if s.candles:
                s.candles[-1]["signal"] = "cascade"
            msg = f"CASCADE: ${s.cascade_score/1e6:.2f}M liquidated"
            self._add_log(msg, "cascade")
            await self._broadcast({
                "type": "phase",
                "phase": "cascade",
                "text": "Cascade Detected!",
                "price": s.price,
                "cascade_count": s.cascade_count,
            })
            asyncio.create_task(self._cascade_timeout())

        pct = min(100, (s.cascade_score / T) * 100)
        await self._broadcast({"type": "cascade_meter", "pct": pct, "score": s.cascade_score})

    async def _cascade_timeout(self):
        await asyncio.sleep(30)
        s = self._s
        # FIX: always reset cascade_score when the 30s timer fires, regardless
        # of current phase. If a delta flip moved phase to "long" or "short"
        # before the timer expired, the stale score would accumulate into the
        # next cycle and trigger a false early cascade.
        s.cascade_score = 0.0
        if s.phase == "cascade":
            s.phase = "watching"
            self._add_log("Cascade ended. Watching delta for entry...", "info")
            await self._broadcast({
                "type": "phase",
                "phase": "watching",
                "text": "Watching for Delta Flip",
                "price": s.price,
            })

    async def _on_delta_flip(self, direction: str):
        s = self._s
        if direction == "exit":
            old_phase = s.phase
            s.phase = "waiting"
            s.cascade_score = 0.0
            s.cumulative_delta = 0.0
            s.prev_cumulative_delta = 0.0
            self._add_log(f"EXIT {old_phase.upper()} @ {s.price:.1f} (delta flip)", "exit")
            if s.candles:
                s.candles[-1]["signal"] = "exit"
            await self._broadcast({
                "type": "phase",
                "phase": "waiting",
                "text": "Waiting for Cascade",
                "price": s.price,
            })
            return

        if s.phase != "watching":
            return

        if direction == "bullish":
            s.phase = "long"
            s.entry_price = s.price
            text = f"LONG @ {s.price:.1f}"
            self._add_log(f"LONG ENTRY @ {s.price:.1f} | Delta flip bullish", "long")
            if s.candles:
                s.candles[-1]["signal"] = "long"
        else:
            s.phase = "short"
            s.entry_price = s.price
            text = f"SHORT @ {s.price:.1f}"
            self._add_log(f"SHORT ENTRY @ {s.price:.1f} | Delta flip bearish", "short")
            if s.candles:
                s.candles[-1]["signal"] = "short"

        await self._broadcast({
            "type": "phase",
            "phase": s.phase,
            "text": text,
            "price": s.price,
        })

    # ------------------------------------------------------------------
    def _add_log(self, msg: str, log_type: str = "info"):
        entry = {"msg": msg, "type": log_type, "ts": int(time.time() * 1000)}
        self._s.signal_log.insert(0, entry)
        if len(self._s.signal_log) > 100:
            self._s.signal_log.pop()
        log.info(f"[{log_type.upper()}] {msg}")

    # ------------------------------------------------------------------
    def get_trade_notional(self, exchange: str, symbol: str, size: float, price: float) -> float:
        from engine.state import CONTRACT_SIZES
        contract_size = CONTRACT_SIZES.get(symbol, {}).get(exchange, 1.0)
        return size * contract_size * price
