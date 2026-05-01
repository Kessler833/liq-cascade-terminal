"""Multi-exchange composite L2 impact model — unified with Kyle's lambda.

Unified prediction
------------------
compute_terminal_price() accepts an optional lambda_now parameter.  When
provided, each bucket's volume is divided by the lambda ratio before being
consumed, making the walk lambda-aware:

    effective_volume = bucket.volume / lambda_ratio

lambda_ratio > 1  → book acts thinner than nominal (cascade regime)
                    each bucket is consumed faster → price travels further
lambda_ratio = 1  → normal conditions, bucket volumes taken at face value
lambda_ratio < 1  → would mean book acts deeper (not expected in practice)

The price at each step is computed from the bucket's price level as before —
only the consumption rate per bucket changes.  This preserves the structural
ordering of the L2 walk (near-touch depth consumed before deep depth) while
making each dollar of notional do more or less work depending on the current
market regime.

When lambda_now is None (estimator not yet warmed up), the walk falls back
to the original behaviour (lambda_ratio = 1.0) so cold-start behaviour is
identical to v1.

Everything else — book maintenance, WS depth streams, REST fallback, flush_dirty
— is unchanged from v1.
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
# Exchange-specific REST book fetchers (fallback / cold-start only)
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


def _build_composite_from_raw(
    raw_by_exchange: dict[str, dict[str, dict[float, float]]],
    side: str,
    sym: str,
) -> tuple[list[tuple[float, float, int]], float | None]:
    bucket = BUCKET_SIZE.get(sym, DEFAULT_BUCKET)
    composite: dict[float, dict] = {}

    for ex_name, sides in raw_by_exchange.items():
        levels = sides.get("bids" if side == "long" else "asks", {})
        for price, usd_notional in levels.items():
            if usd_notional <= 0:
                continue
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

        self._raw_books: dict[str, dict[str, dict[str, dict[float, float]]]] = {}
        self._dirty: set[str] = set()
        self._ws_initialized: dict[str, bool] = {}

    async def start(self):
        self._task = asyncio.create_task(self._refresh_loop(), name="l2_refresh")

    async def stop(self):
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        await self._http.aclose()

    # ------------------------------------------------------------------
    # WS incremental depth API
    # ------------------------------------------------------------------

    def apply_depth_snapshot(self, sym, ex_name, bids, asks):
        ex_books = self._raw_books.setdefault(sym, {})
        ex_books[ex_name] = {
            "bids": {float(p): float(q) * float(p) for p, q in bids},
            "asks": {float(p): float(q) * float(p) for p, q in asks},
        }
        self._ws_initialized.setdefault(sym, False)
        self._ws_initialized[sym] = True
        self._dirty.add(sym)
        log.debug("WS snapshot applied: %s/%s bids=%d asks=%d",
                  sym, ex_name, len(bids), len(asks))

    def apply_depth_diff(self, sym, ex_name, bid_diffs, ask_diffs):
        ex_books = self._raw_books.get(sym)
        if ex_books is None or ex_name not in ex_books:
            log.debug("First diff treated as snapshot: %s/%s", sym, ex_name)
            self.apply_depth_snapshot(sym, ex_name, bid_diffs, ask_diffs)
            return

        book = ex_books[ex_name]
        for p, q in bid_diffs:
            price = float(p)
            usd   = float(q) * price
            if usd <= 0:
                book["bids"].pop(price, None)
            else:
                book["bids"][price] = usd
        for p, q in ask_diffs:
            price = float(p)
            usd   = float(q) * price
            if usd <= 0:
                book["asks"].pop(price, None)
            else:
                book["asks"][price] = usd
        self._dirty.add(sym)

    def flush_dirty(self):
        for sym in list(self._dirty):
            self._rebuild_buckets(sym)
            self._dirty.discard(sym)

    def _rebuild_buckets(self, sym):
        ex_books = self._raw_books.get(sym)
        if not ex_books:
            return
        bids, bid_cutoff = _build_composite_from_raw(ex_books, "long",  sym)
        asks, ask_cutoff = _build_composite_from_raw(ex_books, "short", sym)
        book = self._books.setdefault(sym, _SymbolBook())
        book.bids       = bids
        book.asks       = asks
        book.bid_cutoff = bid_cutoff
        book.ask_cutoff = ask_cutoff

    # ------------------------------------------------------------------
    # REST fallback loop
    # ------------------------------------------------------------------

    async def _refresh_loop(self):
        while True:
            await self._fetch_all_symbols()
            await asyncio.sleep(REFRESH_S)

    async def _fetch_all_symbols(self):
        from engine.state import SYMBOL_MAP

        async def _fetch_one(sym: str):
            if self._ws_initialized.get(sym, False):
                return

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
                    log.debug("L2 REST fetch %s/%s: %s", sym, ex_name, result)
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

        await asyncio.gather(
            *[_fetch_one(sym) for sym in SYMBOL_MAP],
            return_exceptions=True,
        )

    # ------------------------------------------------------------------
    # Unified price impact walk — lambda-aware
    # ------------------------------------------------------------------

    def compute_terminal_price(
        self,
        liq_notional: float,
        side: str,
        sym: str | None = None,
        ref_price: float | None = None,
        lambda_now: float | None = None,
    ) -> dict:
        """Walk the composite book until liq_notional is consumed.

        When lambda_now is provided, each bucket's volume is divided by the
        lambda ratio before consumption:

            effective_volume = bucket.volume / lambda_ratio

        lambda_ratio > 1 → regime is stressed, each bucket absorbed faster,
                           price travels further than nominal depth suggests.
        lambda_ratio = 1 → normal conditions, bucket volumes at face value.

        The lambda_ratio is lambda_now / quiet_period_baseline.  This is
        computed externally by KyleLambda and passed in — l2_model has no
        knowledge of the estimator.

        READ-ONLY — changes no state.
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
            "lambda_ratio":    1.0,
        }

        if mid == 0:
            return _empty

        if liq_notional <= 0:
            return {**_empty, "absorbed": True}

        book_entry = self._books.get(sym)
        if book_entry is None:
            return _empty

        book_all = book_entry.bids if side == "long" else book_entry.asks
        cutoff   = book_entry.bid_cutoff if side == "long" else book_entry.ask_cutoff

        # Filter to levels reachable from ref_price
        if ref_price is not None:
            if side == "long":
                book = [(p, u, n) for p, u, n in book_all if p <= ref_price]
            else:
                book = [(p, u, n) for p, u, n in book_all if p >= ref_price]
        else:
            book = book_all

        if not book:
            return {**_empty, "cutoff_price": cutoff}

        # ── Lambda ratio: how much more impact per dollar of notional ────────
        # lambda_now is the raw OLS estimate. lambda_base is the quiet-period
        # mean for this sym/time-bucket. ratio = lambda_now / lambda_base.
        # Passed in pre-computed from KyleLambda.current().ratio so l2_model
        # doesn't need to import the estimator.
        lambda_ratio = 1.0
        if lambda_now is not None and lambda_now > 0:
            # Retrieve the baseline from the estimator stored on app_state.
            estimator = self._s.kyle_lambdas.get(sym)
            if estimator is not None:
                result = estimator.current()
                if result.lambda_base > 1e-20:
                    lambda_ratio = max(1.0, lambda_now / result.lambda_base)
            # If no estimator yet, ratio stays 1.0 (fallback to v1 behaviour)

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

            # ── Core change: discount bucket depth by lambda ratio ────────────
            # A $1M bucket during a 3x lambda regime is treated as if it only
            # provides $333K of effective absorption — price moves through it
            # 3x faster than nominal depth suggests.
            effective_usd = usd / lambda_ratio

            if remaining <= effective_usd:
                terminal  = price
                consumed += 1
                remaining = 0.0
                break
            remaining -= effective_usd
            terminal   = price
            consumed  += 1
        else:
            # Exhausted book — extrapolate
            extrap_pct = EXTRAP_PCT.get(sym, DEFAULT_EXTRAP_PCT)
            # Scale extrapolation by lambda_ratio too — stressed market
            # extrapolates further beyond the last visible level.
            extra_pct  = (remaining / liq_notional) * extrap_pct * lambda_ratio
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
            "lambda_ratio":    round(lambda_ratio, 4),
        }
