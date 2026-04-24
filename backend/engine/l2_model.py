"""Terminal price L2 model — Python port of l2_model.js.

Fetches order-book snapshot from Binance Futures, estimates the price
level at which a given liquidation notional would be absorbed, then
adjusts for current cumulative delta.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from engine.state import AppState

log = logging.getLogger("liqterm.l2")

BOOK_DEPTH    = 20       # levels to fetch
REFRESH_S     = 5.0      # re-fetch interval
DELTA_FACTOR  = 0.000_01 # delta influence per dollar


class L2Model:
    def __init__(self, app_state: "AppState"):
        self._s    = app_state
        self._bids: list[tuple[float, float]] = []  # (price, qty)
        self._asks: list[tuple[float, float]] = []
        self._task: asyncio.Task | None = None

    async def start(self):
        self._task = asyncio.create_task(self._refresh_loop(), name="l2_refresh")

    async def stop(self):
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    # ------------------------------------------------------------------
    async def _refresh_loop(self):
        while True:
            await self._fetch_book()
            await asyncio.sleep(REFRESH_S)

    async def _fetch_book(self):
        from engine.state import SYMBOL_MAP
        sym    = self._s.symbol
        s_name = SYMBOL_MAP.get(sym, {}).get("binance", "btcusdt").upper()
        url    = f"https://fapi.binance.com/fapi/v1/depth?symbol={s_name}&limit={BOOK_DEPTH}"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                r = await client.get(url)
                r.raise_for_status()
                data = r.json()
            self._bids = [(float(p), float(q)) for p, q in data.get("bids", [])]
            self._asks = [(float(p), float(q)) for p, q in data.get("asks", [])]
        except Exception as e:
            log.debug(f"L2 fetch error: {e}")

    # ------------------------------------------------------------------
    def compute_terminal_price(
        self,
        liq_notional: float,
        cum_delta: float,
        side: str,
    ) -> dict:
        """
        Walk the book until `liq_notional` USD is consumed.
        Returns:
            terminal_price  float
            levels_consumed int
            absorbed        bool   (delta absorbed the pressure)
        """
        mid   = self._s.price or 0.0
        book  = self._asks if side == "long" else self._bids

        if not book or mid == 0:
            return {"terminal_price": mid, "levels_consumed": 0, "absorbed": False}

        remaining = liq_notional
        terminal  = mid
        consumed  = 0

        for price, qty in book:
            level_val = qty * price
            if remaining <= level_val:
                terminal = price
                consumed += 1
                break
            remaining -= level_val
            terminal   = price
            consumed  += 1
        else:
            # Exhausted visible book — extrapolate 0.5% per full level
            extra_pct  = (remaining / liq_notional) * 0.5
            if side == "long":
                terminal *= (1 + extra_pct / 100)
            else:
                terminal *= (1 - extra_pct / 100)

        # Delta adjustment
        delta_adj = cum_delta * DELTA_FACTOR
        if side == "long":
            terminal *= (1 - max(-0.5, min(0.5, delta_adj)))
        else:
            terminal *= (1 + max(-0.5, min(0.5, delta_adj)))

        absorbed = abs(delta_adj) > 0.3 and (
            (side == "long"  and delta_adj > 0) or
            (side == "short" and delta_adj < 0)
        )

        return {
            "terminal_price":  round(terminal, 2),
            "levels_consumed": consumed,
            "absorbed":        absorbed,
        }
