"""Cascade detection, delta tracking, liquidation handling, phase transitions.
Python port of strategy.js.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import TYPE_CHECKING, Callable, Awaitable

if TYPE_CHECKING:
    from engine.state import AppState
    from engine.l2_model import L2Model

log = logging.getLogger("liqterm.strategy")


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
        # Throttle: last time we sent a 'tick' broadcast (ms)
        self._last_tick_ms: int = 0
        self._tick_throttle_ms: int = 100

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------
    def _candle_bucket(self, ts_ms: int) -> int:
        """Return the candle open-time (ms) that ts_ms falls into."""
        from engine.state import TF_MINUTES
        tf_ms = TF_MINUTES[self._s.timeframe] * 60_000
        candles = self._s.candles
        if candles:
            bt = candles[0]["t"]
            for c in candles:
                if c["t"] <= ts_ms:
                    bt = c["t"]
                else:
                    break
            return bt
        return (ts_ms // tf_ms) * tf_ms

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
            db["delta"] += grouped[t]
            db["cum_delta"] = cum
        self._s.delta_bars.sort(key=lambda b: b["t"])
        if cum != 0:
            self._s.cumulative_delta = cum
            self._s.prev_cumulative_delta = cum

    def update_candle(self, c: dict, is_closed: bool):
        """Called only on kline-close to finalise a candle with authoritative OHLCV."""
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
    async def update_price_tick(self, price: float, notional: float, ts_ms: int):
        """Update the live candle from a multi-exchange trade tick.

        CONTRACT:
        - NEVER creates a new candle. Only update_candle() (kline-close)
          and the REST history loader create candles with authoritative opens.
        - NEVER touches the candle open. Only c / h / l / v are written here.

        If the bucket isn't found (history not yet loaded, or a new candle
        that kline hasn't opened yet), we silently skip — the correct open
        will arrive via the Binance REST history or the next kline message.
        """
        if price <= 0 or not self._s.candles:
            return

        bt = self._candle_bucket(ts_ms)

        # Only update existing candles. Silently skip if bucket not found.
        cb = next((c for c in self._s.candles if c["t"] == bt), None)
        if cb is None:
            return

        # Update close, high, low, volume — open is NEVER touched here.
        cb["c"] = price
        if price > cb["h"]:
            cb["h"] = price
        if price < cb["l"]:
            cb["l"] = price
        cb["v"] = cb.get("v", 0.0) + notional
        self._s.price = price

        # Throttled broadcast
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
    async def update_delta(self, vol_delta: float, ts_ms: int):
        if not math.isfinite(vol_delta) or vol_delta == 0:
            return
        s = self._s
        s.cumulative_delta += vol_delta

        bt1m = (ts_ms // 60_000) * 60_000
        sb = next((b for b in s.delta_store[s.symbol] if b["t"] == bt1m), None)
        if sb is None:
            sb = {"t": bt1m, "delta": 0.0}
            s.delta_store[s.symbol].append(sb)
        sb["delta"] += vol_delta

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
    ):
        if usd_val < 100:
            return
        s = self._s
        now_ms = int(time.time() * 1000)

        s.liq_store[s.symbol].append({
            "t": now_ms, "exchange": exchange,
            "side": side, "usd_val": usd_val, "price": price,
        })

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

        now_s = time.time()
        if now_s - s.liq_1m_timestamp > 60:
            s.liq_1m_bucket = 0.0
            s.liq_1m_timestamp = now_s
        s.liq_1m_bucket += usd_val

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
        if s.phase == "cascade":
            s.phase = "watching"
            s.cascade_score = 0.0
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
