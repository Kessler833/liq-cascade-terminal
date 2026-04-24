"""L2 bucket-fill impact model — Python port of l2_model.js.

Fetches Binance futures depth snapshot and computes the terminal price
where a given liquidation volume (plus directed delta) exhausts the book.
"""
from __future__ import annotations
import asyncio
import logging
import time
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from engine.state import AppState

log = logging.getLogger("liqterm.l2_model")

L2_FETCH_INTERVAL = 2.0   # seconds between book refreshes
L2_DEPTH = 40              # price levels per side


class L2Model:
    """Maintains a live Binance futures L2 snapshot and exposes computeTerminalPrice."""

    def __init__(self, app_state: "AppState"):
        self._state = app_state
        self.bids: list[dict] = []   # [{price, volume}] sorted desc
        self.asks: list[dict] = []   # [{price, volume}] sorted asc
        self._last_fetch: float = 0.0
        self._fetching: bool = False
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    async def start(self):
        self._task = asyncio.create_task(self._poll_loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _poll_loop(self):
        while True:
            await self._fetch_snapshot()
            await asyncio.sleep(L2_FETCH_INTERVAL)

    async def _fetch_snapshot(self):
        if self._fetching:
            return
        self._fetching = True
        sym = self._state.symbol + "USDT"
        url = f"https://fapi.binance.com/fapi/v1/depth?symbol={sym}&limit=50"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(url)
                r.raise_for_status()
                d = r.json()
            self.bids = [
                {"price": float(p), "volume": float(p) * float(q)}
                for p, q in d["bids"][:L2_DEPTH]
            ]
            self.asks = [
                {"price": float(p), "volume": float(p) * float(q)}
                for p, q in d["asks"][:L2_DEPTH]
            ]
            self._last_fetch = time.time()
        except Exception as e:
            log.debug(f"L2 fetch failed: {e}")
        finally:
            self._fetching = False

    # ------------------------------------------------------------------
    def compute_terminal_price(
        self,
        liq_remaining: float,
        delta: float,
        side: str,
    ) -> dict:
        """
        side: 'long'  → forced selling → consumes BID side (price moves down)
              'short' → forced buying  → consumes ASK side (price moves up)

        Returns dict: {terminal_price, buckets_touched, absorbed}
        """
        directed_delta = delta if side == "long" else -delta
        total_pressure = liq_remaining + directed_delta

        current = self._state.price

        if total_pressure <= 0:
            return {"terminal_price": current, "buckets_touched": 0, "absorbed": True}

        buckets = self.bids if side == "long" else self.asks
        if not buckets:
            return {"terminal_price": current, "buckets_touched": 0, "absorbed": False}

        remainder = total_pressure
        touched = 0

        for bucket in buckets:
            if remainder <= 0:
                break
            remainder -= bucket["volume"]
            touched += 1
            if remainder <= 0:
                return {
                    "terminal_price": bucket["price"],
                    "buckets_touched": touched,
                    "absorbed": False,
                }

        deepest = buckets[-1] if buckets else None
        return {
            "terminal_price": deepest["price"] if deepest else current,
            "buckets_touched": touched,
            "absorbed": False,
        }
