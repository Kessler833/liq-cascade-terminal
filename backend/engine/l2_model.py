"""Terminal price L2 impact model.

Fetches order-book snapshot from Binance Futures, estimates the price
level at which a given liquidation notional would be absorbed, using
cumulative delta as an additive force modifier per the spec:

    Total Selling Pressure = LIQ_remaining + Δ_current

    - Walk bids  for long  liquidations (forced sell → price down)
    - Walk asks  for short liquidations (forced buy  → price up)
    - If Total Pressure ≤ 0, organic counter-flow neutralises the liq;
      terminal price = current price, absorbed = True.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from engine.state import AppState

log = logging.getLogger("liqterm.l2")

BOOK_DEPTH = 50      # levels to fetch (raised from 20 — thin assets blow through 20)
REFRESH_S  = 5.0     # re-fetch interval

# Per-symbol book exhaustion extrapolation constants.
# Used only when total_pressure exhausts all visible levels.
EXTRAP_PCT: dict[str, float] = {
    "BTC":  0.5,
    "ETH":  0.8,
    "SOL":  1.5,
    "XRP":  1.5,
    "DOGE": 2.0,
    "AVAX": 3.0,
    "LINK": 3.0,
    "SUI":  3.0,
}
DEFAULT_EXTRAP_PCT = 2.0


class L2Model:
    def __init__(self, app_state: "AppState"):
        self._s    = app_state
        self._bids: list[tuple[float, float]] = []  # (price, qty) — descending
        self._asks: list[tuple[float, float]] = []  # (price, qty) — ascending
        self._task: asyncio.Task | None = None
        # Single shared AsyncClient — avoids recreating a TLS connection every 5s.
        self._http = httpx.AsyncClient(timeout=5.0)

    async def start(self):
        self._task = asyncio.create_task(self._refresh_loop(), name="l2_refresh")

    async def stop(self):
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        await self._http.aclose()

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
            r = await self._http.get(url)
            r.raise_for_status()
            data = r.json()
            # bids: highest price first (descending) — what buyers offer
            # asks: lowest  price first (ascending)  — what sellers offer
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
        """Walk the book until total pressure (LIQ + Δ) is consumed.

        Spec algorithm:
          1. total_pressure = liq_notional + cum_delta
             - cum_delta > 0: organic flow same direction → amplifies impact
             - cum_delta < 0: organic counter-flow → cushions impact
          2. If total_pressure <= 0: liquidation neutralised, no price move.
          3. Walk the relevant book side, consuming levels until remainder <= 0.
             - long  liq: price moves DOWN → walk bids (buy orders get eaten)
             - short liq: price moves UP   → walk asks (sell orders get eaten)
          4. If visible book exhausted, extrapolate from remaining fraction.

        Returns:
            terminal_price  float
            levels_consumed int
            absorbed        bool  (organic flow fully neutralised the liq)
        """
        mid = self._s.price or 0.0
        sym = self._s.symbol

        if mid == 0:
            return {"terminal_price": mid, "levels_consumed": 0, "absorbed": False}

        # Bug 1 fix: delta is additive to pressure, not a post-hoc price scaler.
        total_pressure = liq_notional + cum_delta

        # If counter-flow fully neutralises the liquidation, no price move.
        if total_pressure <= 0:
            return {"terminal_price": mid, "levels_consumed": 0, "absorbed": True}

        # Bug 2 fix: correct book side per direction.
        # Long liq  = forced sell → price moves down → bids (buy orders) are consumed.
        # Short liq = forced buy  → price moves up   → asks (sell orders) are consumed.
        book = self._bids if side == "long" else self._asks

        if not book:
            return {"terminal_price": mid, "levels_consumed": 0, "absorbed": False}

        remaining = total_pressure
        terminal  = mid
        consumed  = 0

        for price, qty in book:
            level_val = qty * price
            if remaining <= level_val:
                # This level absorbs the remainder — terminal price stops here.
                terminal = price
                consumed += 1
                break
            remaining -= level_val
            terminal   = price
            consumed  += 1
        else:
            # Exhausted all visible levels — extrapolate beyond the book.
            extrap_pct = EXTRAP_PCT.get(sym, DEFAULT_EXTRAP_PCT)
            # Scale extrapolation by how much pressure is still unabsorbed.
            extra_pct  = (remaining / total_pressure) * extrap_pct
            if side == "long":
                terminal *= (1 - extra_pct / 100)   # price moves further down
            else:
                terminal *= (1 + extra_pct / 100)   # price moves further up

        # absorbed: organic counter-flow consumed more than half the liq notional,
        # meaning the market materially cushioned the impact.
        absorbed = cum_delta < 0 and abs(cum_delta) > liq_notional * 0.5

        return {
            "terminal_price":  round(terminal, 2),
            "levels_consumed": consumed,
            "absorbed":        absorbed,
        }
