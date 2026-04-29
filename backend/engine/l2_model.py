"""Multi-exchange composite L2 impact model.

Fetches order books from 5 exchanges (Binance, Bybit, OKX, Bitget, Gate)
in parallel, merges them into a single bucketed composite book, then
estimates the terminal price a liquidation would reach.

Key concepts
------------
* compute_terminal_price is READ-ONLY.
  It takes liq_notional and walks the book to produce a price estimate.
  It does NOT take delta as an input. Delta is handled entirely in
  ImpactRecorder._tick_all before this function is called. The tank
  (liq_remaining) has already been updated by delta when this runs.
  This function changes no state and never feeds back into liq_remaining.

* Price buckets — raw levels are rounded to a per-symbol bucket size
  (e.g. $10 for BTC, $0.05 for SOL) and summed.
  Bid levels use floor (bucket at-or-below actual price — conservative).
  Ask levels use ceil  (bucket at-or-above actual price — conservative).
  This ensures ask buckets never collapse below mid, preventing a short
  liq walk from producing a terminal price below the entry price.

* Exchange coverage — each bucket tracks how many exchanges contributed.
  The data cutoff price is the deepest level where every REST-accessible
  exchange still contributes.

* beyond_cutoff flag — when the terminal price estimate crosses the
  cutoff, the result carries beyond_cutoff=True and cutoff_price.

* Multi-symbol — books for ALL symbols are refreshed every REFRESH_S
  seconds in parallel.
"""
from __future__ import annotations

import asyncio
import logging
import math
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from engine.state import AppState

log = logging.getLogger("liqterm.l2")

REFRESH_S  = 1.0
BOOK_DEPTH = 50

N_BOOK_EXCHANGES = 5

BUCKET_SIZE: dict[str, float] = {
    "BTC":  10.0,
    "ETH":  1.0,
    "SOL":  0.1,
    "XRP":  0.0005,
    "DOGE": 0.00005,
    "AVAX": 0.05,
    "LINK": 0.02,
    "SUI":  0.005,
}
DEFAULT_BUCKET = 1.0

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


# ---------------------------------------------------------------------------
# Exchange-specific REST book fetchers
# ---------------------------------------------------------------------------

async def _fetch_binance(http: httpx.AsyncClient, sym_name: str
                         ) -> tuple[list[tuple[float,float]], list[tuple[float,float]]]:
    url = f"https://fapi.binance.com/fapi/v1/depth?symbol={sym_name.upper()}&limit={BOOK_DEPTH}"
    r = await http.get(url, timeout=4.0)
    r.raise_for_status()
    d = r.json()
    bids = [(float(p), float(q) * float(p)) for p, q in d.get("bids", [])]
    asks = [(float(p), float(q) * float(p)) for p, q in d.get("asks", [])]
    return bids, asks


async def _fetch_bybit(http: httpx.AsyncClient, sym_name: str
                       ) -> tuple[list[tuple[float,float]], list[tuple[float,float]]]:
    url = f"https://api.bybit.com/v5/market/orderbook?category=linear&symbol={sym_name}&limit={BOOK_DEPTH}"
    r = await http.get(url, timeout=4.0)
    r.raise_for_status()
    result = r.json().get("result", {})
    bids = [(float(p), float(q) * float(p)) for p, q in result.get("b", [])]
    asks = [(float(p), float(q) * float(p)) for p, q in result.get("a", [])]
    return bids, asks


async def _fetch_okx(http: httpx.AsyncClient, sym_name: str
                     ) -> tuple[list[tuple[float,float]], list[tuple[float,float]]]:
    url = f"https://www.okx.com/api/v5/market/books?instId={sym_name}&sz={BOOK_DEPTH}"
    r = await http.get(url, timeout=4.0)
    r.raise_for_status()
    data = r.json().get("data", [{}])[0]
    bids = [(float(row[0]), float(row[0]) * float(row[1])) for row in data.get("bids", [])]
    asks = [(float(row[0]), float(row[0]) * float(row[1])) for row in data.get("asks", [])]
    return bids, asks


async def _fetch_bitget(http: httpx.AsyncClient, sym_name: str
                        ) -> tuple[list[tuple[float,float]], list[tuple[float,float]]]:
    url = f"https://api.bitget.com/api/v2/mix/market/merge-depth?symbol={sym_name}&productType=usdt-futures&limit={BOOK_DEPTH}"
    r = await http.get(url, timeout=4.0)
    r.raise_for_status()
    data = r.json().get("data", {})
    bids = [(float(p), float(q) * float(p)) for p, q in data.get("bids", [])]
    asks = [(float(p), float(q) * float(p)) for p, q in data.get("asks", [])]
    return bids, asks


async def _fetch_gate(http: httpx.AsyncClient, sym_name: str
                      ) -> tuple[list[tuple[float,float]], list[tuple[float,float]]]:
    url = f"https://fx-api.gateio.ws/api/v4/futures/usdt/order_book?contract={sym_name}&limit={BOOK_DEPTH}"
    r = await http.get(url, timeout=4.0)
    r.raise_for_status()
    data = r.json()
    bids = [(float(row["p"]), float(row["p"]) * float(row["s"])) for row in data.get("bids", [])]
    asks = [(float(row["p"]), float(row["p"]) * float(row["s"])) for row in data.get("asks", [])]
    return bids, asks


# ---------------------------------------------------------------------------
# Bucketed composite book builder
# ---------------------------------------------------------------------------

def _build_composite(
    exchange_books: list[tuple[str, list[tuple[float,float]], list[tuple[float,float]]]],
    side: str,
    sym: str,
    mid: float,
) -> tuple[list[tuple[float, float, int]], float | None]:
    bucket = BUCKET_SIZE.get(sym, DEFAULT_BUCKET)
    composite: dict[float, dict] = {}

    for ex_name, bids, asks in exchange_books:
        levels = bids if side == "long" else asks
        for price, usd_notional in levels:
            # Bids: floor keeps bucket at-or-below actual bid (conservative downward)
            # Asks: ceil  keeps bucket at-or-above actual ask (conservative upward)
            # This prevents ask buckets from collapsing below mid, which would
            # cause short-liq walks to produce terminal prices below entry.
            if side == "long":
                key = math.floor(price / bucket) * bucket
            else:
                key = math.ceil(price / bucket) * bucket

            if key not in composite:
                composite[key] = {"usd": 0.0, "exchanges": set()}
            composite[key]["usd"] += usd_notional
            composite[key]["exchanges"].add(ex_name)

    sorted_keys = sorted(composite.keys(), reverse=(side == "long"))
    sorted_levels = [
        (k, composite[k]["usd"], len(composite[k]["exchanges"]))
        for k in sorted_keys
    ]

    cutoff_price: float | None = None
    for price, usd, n_ex in sorted_levels:
        if n_ex >= N_BOOK_EXCHANGES:
            cutoff_price = price

    return sorted_levels, cutoff_price


# ---------------------------------------------------------------------------
# Per-symbol book cache
# ---------------------------------------------------------------------------

_BookSide = list[tuple[float, float, int]]


class _SymbolBook:
    __slots__ = ("bids", "asks", "bid_cutoff", "ask_cutoff")

    def __init__(self):
        self.bids: _BookSide = []
        self.asks: _BookSide = []
        self.bid_cutoff: float | None = None
        self.ask_cutoff: float | None = None


# ---------------------------------------------------------------------------
# Main L2Model class
# ---------------------------------------------------------------------------

class L2Model:
    def __init__(self, app_state: "AppState"):
        self._s    = app_state
        self._task: asyncio.Task | None = None
        self._http = httpx.AsyncClient(timeout=5.0)
        self._books: dict[str, _SymbolBook] = {}

    async def start(self):
        self._task = asyncio.create_task(self._refresh_loop(), name="l2_refresh")

    async def stop(self):
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        await self._http.aclose()

    async def _refresh_loop(self):
        while True:
            await self._fetch_all_symbols()
            await asyncio.sleep(REFRESH_S)

    async def _fetch_all_symbols(self):
        from engine.state import SYMBOL_MAP

        async def _fetch_one(sym: str):
            maps = SYMBOL_MAP.get(sym, {})
            mid = self._s.sym_price.get(sym, 0.0) or self._s.price or 0.0

            fetchers = [
                ("binance", _fetch_binance(self._http, maps.get("binance", ""))),
                ("bybit",   _fetch_bybit(  self._http, maps.get("bybit",   ""))),
                ("okx",     _fetch_okx(    self._http, maps.get("okx",     ""))),
                ("bitget",  _fetch_bitget( self._http, maps.get("bitget",  ""))),
                ("gate",    _fetch_gate(   self._http, maps.get("gate",    ""))),
            ]
            results = await asyncio.gather(
                *[coro for _, coro in fetchers],
                return_exceptions=True,
            )
            exchange_books: list[tuple[str, list, list]] = []
            for (ex_name, _), result in zip(fetchers, results):
                if isinstance(result, Exception):
                    log.debug("L2 fetch %s/%s: %s", sym, ex_name, result)
                    continue
                bids, asks = result
                exchange_books.append((ex_name, bids, asks))

            if not exchange_books:
                return

            bids, bid_cutoff = _build_composite(exchange_books, "long",  sym, mid)
            asks, ask_cutoff = _build_composite(exchange_books, "short", sym, mid)

            book = self._books.setdefault(sym, _SymbolBook())
            book.bids       = bids
            book.asks       = asks
            book.bid_cutoff = bid_cutoff
            book.ask_cutoff = ask_cutoff

            log.debug(
                "L2 [%s]: %d bid / %d ask buckets from %d exchanges",
                sym, len(bids), len(asks), len(exchange_books),
            )

        await asyncio.gather(
            *[_fetch_one(sym) for sym in SYMBOL_MAP],
            return_exceptions=True,
        )

    # ------------------------------------------------------------------
    def compute_terminal_price(
        self,
        liq_notional: float,
        side: str,
        sym: str | None = None,
        ref_price: float | None = None,
    ) -> dict:
        """Walk the composite book until liq_notional is consumed.

        READ-ONLY — this function changes no state and must never be
        used to update liq_remaining in the caller. It is purely a
        forward price estimate given the current tank size.

        Delta is NOT a parameter here. It is the caller's responsibility
        to update liq_notional with delta before calling this function.
        See ImpactRecorder._tick_all for the correct usage pattern.

        Parameters
        ----------
        liq_notional : float — current remaining liquidation notional (USD).
                               This is liq_remaining AFTER delta has already
                               been applied by the caller.
        side         : str   — "long" (forced sell) or "short" (forced buy)
        sym          : str   — canonical symbol key e.g. "BTC"
        ref_price    : float | None — actual current market price to use as
                               the mid reference. When provided, stale snapshot
                               mid is ignored and book levels already consumed
                               by the market move are filtered out.
                               long liq  → only bids at or below ref_price
                               short liq → only asks at or above ref_price

        Returns
        -------
        dict with keys:
            terminal_price  float        — estimated absorption price
            levels_consumed int
            absorbed        bool         — liq_notional was zero or negative
            beyond_cutoff   bool
            cutoff_price    float | None
        """
        if sym is None:
            sym = self._s.symbol

        mid = (
            ref_price if ref_price is not None
            else (self._s.sym_price.get(sym, 0.0) or self._s.price or 0.0)
        )

        _empty = {
            "terminal_price":  mid,
            "levels_consumed": 0,
            "absorbed":        False,
            "beyond_cutoff":   False,
            "cutoff_price":    None,
        }

        if mid == 0:
            return _empty

        # Tank is empty — forced flow already absorbed
        if liq_notional <= 0:
            return {**_empty, "absorbed": True}

        book_entry = self._books.get(sym)
        if book_entry is None:
            return _empty

        book_all = book_entry.bids if side == "long" else book_entry.asks
        cutoff   = book_entry.bid_cutoff if side == "long" else book_entry.ask_cutoff

        # Discard book levels that have already been consumed by the market move
        # that brought price to ref_price. Only levels reachable from ref_price
        # onward are valid for the walk.
        if ref_price is not None:
            if side == "long":
                # Forced sell: only bids at or below the fill price
                book = [(p, u, n) for p, u, n in book_all if p <= ref_price]
            else:
                # Forced buy: only asks at or above the fill price
                book = [(p, u, n) for p, u, n in book_all if p >= ref_price]
        else:
            book = book_all

        if not book:
            return {**_empty, "cutoff_price": cutoff}

        remaining     = liq_notional
        terminal      = mid
        consumed      = 0
        beyond_cutoff = False

        for price, usd, _n_ex in book:
            if cutoff is not None:
                if side == "long"  and price < cutoff:
                    beyond_cutoff = True
                elif side == "short" and price > cutoff:
                    beyond_cutoff = True

            if remaining <= usd:
                terminal  = price
                consumed += 1
                remaining = 0.0
                break
            remaining -= usd
            terminal   = price
            consumed  += 1
        else:
            # Exhausted the entire book — extrapolate beyond deepest level
            extrap_pct = EXTRAP_PCT.get(sym, DEFAULT_EXTRAP_PCT)
            extra_pct  = (remaining / liq_notional) * extrap_pct
            if side == "long":
                terminal *= (1 - extra_pct / 100)
            else:
                terminal *= (1 + extra_pct / 100)
            if cutoff is not None:
                beyond_cutoff = True

        return {
            "terminal_price":  round(terminal, 6),
            "levels_consumed": consumed,
            "absorbed":        False,
            "beyond_cutoff":   beyond_cutoff,
            "cutoff_price":    round(cutoff, 6) if cutoff is not None else None,
        }
