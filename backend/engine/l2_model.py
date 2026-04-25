"""Multi-exchange composite L2 impact model.

Fetches order books from 5 exchanges (Binance, Bybit, OKX, Bitget, Gate)
in parallel, merges them into a single bucketed composite book, then
estimates the terminal price a liquidation would reach.

Key concepts
------------
* Price buckets  — raw levels are rounded to a per-symbol bucket size
  (e.g. $10 for BTC, $0.05 for SOL) and summed.  This avoids thousands
  of micro-levels that would never individually stop a large liquidation.
* Exchange coverage — each bucket tracks how many exchanges contributed.
  The *data cutoff price* is the deepest level where every REST-accessible
  exchange (5 of the 6 — dYdX has no public book API) still contributes.
  Beyond that price the book thins to a subset of exchanges and is less
  reliable.
* beyond_cutoff flag — when the model's terminal price estimate crosses
  the cutoff, the result carries beyond_cutoff=True and cutoff_price so
  the frontend can draw a stop-line on the impact chart.

Spec algorithm (unchanged from previous fix)
--------------------------------------------
  total_pressure = LIQ_remaining + Δ_current   (additive, not multiplicative)
  If total_pressure ≤ 0 → absorbed, terminal_price = mid.
  Walk bids  for long  liq (forced sell → price moves down).
  Walk asks  for short liq (forced buy  → price moves up).
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

REFRESH_S  = 5.0    # composite book re-fetch interval
BOOK_DEPTH = 50     # levels per exchange per side

# Number of REST-accessible exchanges (dYdX excluded — no public book API).
N_BOOK_EXCHANGES = 5

# Per-symbol price bucket size (USD).  Levels are rounded to this grid.
# Smaller assets get finer buckets so close-to-mid precision is preserved.
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

# Per-symbol extrapolation % when composite book is exhausted.
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
    """Returns (bids, asks) as (price, qty_usd) tuples."""
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
    """OKX perp order book. sz is in contracts; we fetch contract size from state later.
    For simplicity, contract_size_usd ≈ price * contracts * contract_size_base.
    We pass raw (price, contracts) and caller applies contract size.
    Actually OKX book sz for SWAP is in contracts (base coin for most).
    We return (price, notional_usd) like other exchanges.
    """
    url = f"https://www.okx.com/api/v5/market/books?instId={sym_name}&sz={BOOK_DEPTH}"
    r = await http.get(url, timeout=4.0)
    r.raise_for_status()
    data = r.json().get("data", [{}])[0]
    # OKX: [price, sz_contracts, _, _]. sz in base coin for linear SWAP.
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
    # Gate returns {"bids": [{"p": price, "s": size_contracts}, ...], "asks": [...]}
    # size is in contracts (1 contract = 1 USD for most USDT perps on Gate)
    bids = [(float(row["p"]), float(row["p"]) * float(row["s"])) for row in data.get("bids", [])]
    asks = [(float(row["p"]), float(row["p"]) * float(row["s"])) for row in data.get("asks", [])]
    return bids, asks


# ---------------------------------------------------------------------------
# Bucketed composite book builder
# ---------------------------------------------------------------------------

def _bucket_price(price: float, bucket: float) -> float:
    """Round price DOWN to the nearest bucket boundary."""
    return math.floor(price / bucket) * bucket


def _build_composite(
    exchange_books: list[tuple[str, list[tuple[float,float]], list[tuple[float,float]]]],
    side: str,
    sym: str,
    mid: float,
) -> tuple[list[tuple[float, float, int]], float | None]:
    """Merge per-exchange books into a bucketed composite.

    Args:
        exchange_books: list of (exchange_name, bids, asks)
        side:           "long" (walk bids) or "short" (walk asks)
        sym:            canonical symbol e.g. "BTC"
        mid:            current mid price

    Returns:
        (sorted_levels, data_cutoff_price)

        sorted_levels  — list of (price, total_usd_notional, n_exchanges)
                         sorted from best price toward worst (closest → farthest
                         from mid in the relevant direction)
        data_cutoff_price — deepest price where ALL N_BOOK_EXCHANGES contributed
                           a level in that region; None if all levels qualify
    """
    bucket = BUCKET_SIZE.get(sym, DEFAULT_BUCKET)

    # bucket_key -> {"usd": float, "exchanges": set[str]}
    composite: dict[float, dict] = {}

    for ex_name, bids, asks in exchange_books:
        levels = bids if side == "long" else asks
        for price, usd_notional in levels:
            key = _bucket_price(price, bucket)
            if key not in composite:
                composite[key] = {"usd": 0.0, "exchanges": set()}
            composite[key]["usd"] += usd_notional
            composite[key]["exchanges"].add(ex_name)

    # Sort: for long liq (bids) → descending price (best bid first, walk down)
    #        for short liq (asks) → ascending price (best ask first, walk up)
    sorted_keys = sorted(composite.keys(), reverse=(side == "long"))
    sorted_levels = [
        (k, composite[k]["usd"], len(composite[k]["exchanges"]))
        for k in sorted_keys
    ]

    # Find data cutoff: deepest level where exchange count == N_BOOK_EXCHANGES.
    # FIX Bug-2: use `continue` instead of `break` so the scan walks the full
    # book and always returns the *deepest* fully-covered level.
    # The old `break` assumed exchanges drop out monotonically — they don't.
    # Exchanges like Bitget commonly have sparse mid-book levels (gaps) that
    # resume contributing deeper in the book.  Breaking on the first gap set
    # cutoff_price very close to mid, causing almost every model call to report
    # beyond_cutoff=True even for small cascades that never left the mid-book.
    cutoff_price: float | None = None
    total_ex = N_BOOK_EXCHANGES
    for price, usd, n_ex in sorted_levels:
        if n_ex >= total_ex:
            cutoff_price = price   # keep updating — don't stop early

    return sorted_levels, cutoff_price


# ---------------------------------------------------------------------------
# Main L2Model class
# ---------------------------------------------------------------------------

class L2Model:
    def __init__(self, app_state: "AppState"):
        self._s    = app_state
        self._task: asyncio.Task | None = None
        self._http = httpx.AsyncClient(timeout=5.0)

        # Latest composite books keyed by side
        self._bids: list[tuple[float, float, int]] = []  # (price, usd, n_exchanges) descending
        self._asks: list[tuple[float, float, int]] = []  # (price, usd, n_exchanges) ascending
        self._bid_cutoff: float | None = None
        self._ask_cutoff: float | None = None

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
            await self._fetch_composite_book()
            await asyncio.sleep(REFRESH_S)

    async def _fetch_composite_book(self):
        from engine.state import SYMBOL_MAP
        sym  = self._s.symbol
        mid  = self._s.price or 0.0
        maps = SYMBOL_MAP.get(sym, {})

        fetchers = [
            ("binance", _fetch_binance(self._http, maps.get("binance", ""))),
            ("bybit",   _fetch_bybit(  self._http, maps.get("bybit",   ""))),
            ("okx",     _fetch_okx(    self._http, maps.get("okx",     ""))),
            ("bitget",  _fetch_bitget( self._http, maps.get("bitget",  ""))),
            ("gate",    _fetch_gate(   self._http, maps.get("gate",    ""))),
            # dYdX excluded: no public REST order book endpoint
        ]

        results = await asyncio.gather(
            *[coro for _, coro in fetchers],
            return_exceptions=True,
        )

        exchange_books: list[tuple[str, list, list]] = []
        for (ex_name, _), result in zip(fetchers, results):
            if isinstance(result, Exception):
                log.debug(f"L2 fetch {ex_name}: {result}")
                continue
            bids, asks = result
            exchange_books.append((ex_name, bids, asks))

        if not exchange_books:
            return  # all fetches failed, keep stale book

        bids, bid_cutoff = _build_composite(exchange_books, "long",  sym, mid)
        asks, ask_cutoff = _build_composite(exchange_books, "short", sym, mid)

        self._bids        = bids
        self._asks        = asks
        self._bid_cutoff  = bid_cutoff
        self._ask_cutoff  = ask_cutoff

        log.debug(
            f"L2 composite: {len(bids)} bid buckets / {len(asks)} ask buckets "
            f"from {len(exchange_books)} exchanges | "
            f"bid cutoff={bid_cutoff} ask cutoff={ask_cutoff}"
        )

    # ------------------------------------------------------------------
    def compute_terminal_price(
        self,
        liq_notional: float,
        cum_delta: float,
        side: str,
    ) -> dict:
        """Walk the composite book until total pressure (LIQ + Δ) is consumed.

        Returns
        -------
        dict with keys:
            terminal_price  float  — estimated price at which liq is absorbed
            levels_consumed int    — number of price buckets consumed
            absorbed        bool   — organic delta fully neutralised the liq
            beyond_cutoff   bool   — terminal price crossed the data-cutoff line
            cutoff_price    float | None — the stop line price
        """
        mid = self._s.price or 0.0
        sym = self._s.symbol

        if mid == 0:
            return {"terminal_price": mid, "levels_consumed": 0, "absorbed": False,
                    "beyond_cutoff": False, "cutoff_price": None}

        # Spec Bug-1 fix: delta is additive pressure
        total_pressure = liq_notional + cum_delta

        if total_pressure <= 0:
            return {"terminal_price": mid, "levels_consumed": 0, "absorbed": True,
                    "beyond_cutoff": False, "cutoff_price": None}

        # Spec Bug-2 fix: correct sides
        # long  liq = forced sell → price down → consume bids (buy orders)
        # short liq = forced buy  → price up   → consume asks (sell orders)
        book   = self._bids   if side == "long" else self._asks
        cutoff = self._bid_cutoff if side == "long" else self._ask_cutoff

        if not book:
            return {"terminal_price": mid, "levels_consumed": 0, "absorbed": False,
                    "beyond_cutoff": False, "cutoff_price": cutoff}

        remaining = total_pressure
        terminal  = mid
        consumed  = 0
        beyond_cutoff = False

        for price, usd, _n_ex in book:
            # Check if we've crossed the cutoff before consuming this level
            if cutoff is not None:
                if side == "long"  and price < cutoff:
                    beyond_cutoff = True
                elif side == "short" and price > cutoff:
                    beyond_cutoff = True

            if remaining <= usd:
                terminal = price
                consumed += 1
                break
            remaining -= usd
            terminal   = price
            consumed  += 1
        else:
            # Book exhausted — extrapolate
            extrap_pct = EXTRAP_PCT.get(sym, DEFAULT_EXTRAP_PCT)
            extra_pct  = (remaining / total_pressure) * extrap_pct
            if side == "long":
                terminal *= (1 - extra_pct / 100)
            else:
                terminal *= (1 + extra_pct / 100)
            # Extrapolation is always beyond whatever cutoff exists
            if cutoff is not None:
                beyond_cutoff = True

        # absorbed: counter-flow consumed more than half the liq notional
        absorbed = cum_delta < 0 and abs(cum_delta) > liq_notional * 0.5

        return {
            "terminal_price":  round(terminal, 6),
            "levels_consumed": consumed,
            "absorbed":        absorbed,
            "beyond_cutoff":   beyond_cutoff,
            "cutoff_price":    round(cutoff, 6) if cutoff is not None else None,
        }
