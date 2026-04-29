"""All 6 exchange WebSocket connectors.

Each connector runs as an independent asyncio Task with auto-reconnect.
All connectors subscribe to ALL symbols permanently — symbol switches
require only a REST history refetch, never a WS reconnect.
Normalized events are forwarded to Strategy, which handles state mutation
and broadcasts to frontend clients via the BroadcastHub.

Binance kline stream is always @kline_1m. _handle_binance_kline aggregates
1m candles into the user-selected TF locally, so TF changes never require
a WebSocket reconnect — only agg state reset + REST history refetch.

Depth streams
-------------
Each exchange connection also subscribes to incremental depth updates and
forwards them to L2Model.apply_depth_snapshot / apply_depth_diff.
L2Model.flush_dirty() is called by ImpactRecorder._tick_all() at the
start of each 50ms tick to rebuild composite buckets in one pass.

Exchange depth channels used:
  Binance  — {sym}@depth@100ms  (100ms batched diffs; snapshot via REST on connect)
  Bybit    — orderbook.50.{sym} (type=snapshot on connect, type=delta thereafter)
  OKX      — books50-l2-tbt     (tick-by-trade diffs; action=snapshot or update)
  Bitget   — books15            (snapshot + incremental)
  Gate     — futures.order_book_update 100ms 20-level diffs
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Callable, Awaitable

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

if TYPE_CHECKING:
    from engine.state import AppState
    from engine.strategy import Strategy
    from engine.impact import ImpactRecorder

log = logging.getLogger("liqterm.connections")

RECONNECT_DELAY = 3.0


def _safe_json(raw: str) -> dict | None:
    try:
        return json.loads(raw)
    except Exception:
        return None


class ConnectionManager:
    """Owns all exchange connections and coordinates with Strategy + ImpactRecorder."""

    def __init__(self, app_state: "AppState", hub):
        from engine.l2_model import L2Model
        from engine.strategy import Strategy
        from engine.impact import ImpactRecorder

        self._s = app_state
        self._hub = hub
        self._l2 = L2Model(app_state)
        self._strategy = Strategy(app_state, self._l2, hub.broadcast)
        self._impact = ImpactRecorder(app_state, self._l2, hub.broadcast)
        self._tasks: list[asyncio.Task] = []
        self._dot_status: dict[str, str] = {}
        self._http = httpx.AsyncClient(timeout=10.0)
        self._gen: int = 0
        self._last_candle_open_t: dict[str, int] = {}
        self._agg: dict[str, dict] = {}

    @property
    def strategy(self) -> "Strategy":
        return self._strategy

    @property
    def impact(self) -> "ImpactRecorder":
        return self._impact

    async def start(self):
        await self._l2.start()
        await self._impact.load_from_db()
        await self._connect_all()

    async def stop(self):
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self._l2.stop()
        await self._http.aclose()

    async def reconnect_all(self):
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._s.connected_ws = 0
        self._gen += 1
        self._agg.clear()
        self._last_candle_open_t.clear()
        await self._connect_all()

    async def on_symbol_change(self, sym: str):
        self._last_candle_open_t.pop(sym, None)
        for key in [k for k in list(self._agg) if k.startswith(f"{sym}:")]:
            del self._agg[key]
        await self._fetch_binance_history(sym, self._s.timeframe)

    async def on_timeframe_change(self, sym: str, tf: str):
        self._last_candle_open_t.pop(sym, None)
        for key in [k for k in list(self._agg) if k.startswith(f"{sym}:")]:
            del self._agg[key]
        await self._fetch_binance_history(sym, tf)

    async def _connect_all(self):
        self._tasks = [
            asyncio.create_task(self._run_binance(self._gen), name="binance"),
            asyncio.create_task(self._run_bybit(self._gen),   name="bybit"),
            asyncio.create_task(self._run_okx(self._gen),     name="okx"),
            asyncio.create_task(self._run_bitget(self._gen),  name="bitget"),
            asyncio.create_task(self._run_gate(self._gen),    name="gate"),
            asyncio.create_task(self._run_dydx(self._gen),    name="dydx"),
        ]

    async def _set_dot(self, name: str, status: str):
        self._dot_status[name] = status
        self._s.conn_status[name] = status
        await self._hub.broadcast({"type": "conn_status", "exchange": name, "status": status})

    async def _on_connected(self, name: str):
        was_connected = self._dot_status.get(name) == "connected"
        await self._set_dot(name, "connected")
        if not was_connected:
            self._s.connected_ws += 1
        await self._hub.broadcast({"type": "ws_count", "count": self._s.connected_ws})

    async def _on_disconnected(self, name: str):
        if self._s.connected_ws > 0:
            self._s.connected_ws -= 1
        await self._set_dot(name, "error")
        await self._hub.broadcast({"type": "ws_count", "count": self._s.connected_ws})

    # ------------------------------------------------------------------
    # Binance depth snapshot helper (called once on WS connect)
    # ------------------------------------------------------------------
    async def _fetch_binance_depth_snapshot(self, sym: str):
        """Fetch the Binance REST depth snapshot to seed the WS diff stream.
        Binance's @depth@100ms stream sends diffs only; a REST snapshot is
        required as the starting state before diffs can be applied.
        """
        from engine.state import SYMBOL_MAP
        s_name = SYMBOL_MAP[sym]["binance"].upper()
        url = (f"https://fapi.binance.com/fapi/v1/depth"
               f"?symbol={s_name}&limit=50")
        try:
            r = await self._http.get(url, timeout=4.0)
            r.raise_for_status()
            d = r.json()
            bids = [(float(p), float(q)) for p, q in d.get("bids", [])]
            asks = [(float(p), float(q)) for p, q in d.get("asks", [])]
            self._l2.apply_depth_snapshot(sym, "binance", bids, asks)
        except Exception as e:
            log.debug("Binance depth snapshot %s: %s", sym, e)

    # ------------------------------------------------------------------
    # History fetch
    # ------------------------------------------------------------------
    async def _fetch_binance_history(self, sym: str, tf: str, gen: int = -1):
        from engine.state import SYMBOL_MAP, TF_BINANCE
        s_name = SYMBOL_MAP[sym]["binance"].upper()
        tf_b   = TF_BINANCE[tf]
        url = f"https://fapi.binance.com/fapi/v1/klines?symbol={s_name}&interval={tf_b}&limit=500"
        try:
            r = await self._http.get(url)
            r.raise_for_status()
            data = r.json()
            if gen >= 0 and self._gen != gen:
                return
            if not isinstance(data, list):
                return
            self._s.candles = [
                {"t": d[0], "o": float(d[1]), "h": float(d[2]),
                 "l": float(d[3]), "c": float(d[4]), "v": float(d[5])}
                for d in data
            ]
            self._s.delta_bars  = [{"t": c["t"], "delta": 0.0, "cum_delta": 0.0} for c in self._s.candles]
            self._s.liq_bars    = [{"t": c["t"], "long_usd": 0.0, "short_usd": 0.0} for c in self._s.candles]
            self._strategy.apply_liq_store(sym, tf)
            self._strategy.apply_delta_store(sym, tf)
            if self._s.candles:
                self._s.price = self._s.candles[-1]["c"]
            await self._hub.broadcast({
                "type":      "history",
                "candles":   self._s.candles,
                "liq_bars":  self._s.liq_bars,
                "delta_bars":self._s.delta_bars,
                "price":     self._s.price,
            })
            log.info(f"Loaded {len(self._s.candles)} candles for {sym} {tf}")
        except Exception as e:
            log.warning(f"History fetch failed: {e}")

    # ------------------------------------------------------------------
    # Binance
    # ------------------------------------------------------------------
    async def _run_binance(self, gen: int):
        from engine.state import SYMBOL_MAP
        await self._set_dot("binance", "connecting")
        self._last_candle_open_t.clear()
        self._agg.clear()
        binance_to_sym = {m["binance"]: s for s, m in SYMBOL_MAP.items()}
        while True:
            if self._gen != gen:
                return
            streams = []
            for sym, mapping in SYMBOL_MAP.items():
                s = mapping["binance"]
                streams += [
                    f"{s}@forceOrder",
                    f"{s}@kline_1m",
                    f"{s}@aggTrade",
                    f"{s}@depth@100ms",   # incremental depth diffs, 100ms batched
                ]
            url = "wss://fstream.binance.com/stream?streams=" + "/".join(streams)
            try:
                async with websockets.connect(url, ping_interval=20) as ws:
                    await self._on_connected("binance")
                    # Fetch REST depth snapshots for all symbols to seed the diff stream.
                    for sym in SYMBOL_MAP:
                        asyncio.create_task(self._fetch_binance_depth_snapshot(sym))
                    asyncio.create_task(
                        self._fetch_binance_history(self._s.symbol, self._s.timeframe, gen)
                    )
                    async for raw in ws:
                        if self._gen != gen:
                            return
                        msg = _safe_json(raw)
                        if not msg or "stream" not in msg:
                            continue
                        stream = msg["stream"]
                        data   = msg.get("data", {})
                        raw_sym = stream.split("@")[0]
                        event_sym = binance_to_sym.get(raw_sym)
                        if event_sym is None:
                            continue
                        if "forceOrder" in stream:
                            await self._handle_binance_liq(data.get("o", {}), event_sym)
                        elif "kline" in stream:
                            await self._handle_binance_kline(data.get("k", {}), event_sym)
                        elif "aggTrade" in stream:
                            await self._handle_binance_trade(data, event_sym)
                        elif "depth" in stream:
                            self._handle_binance_depth(data, event_sym)
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug(f"Binance WS error: {e}")
            if self._gen != gen:
                return
            await self._on_disconnected("binance")
            await asyncio.sleep(RECONNECT_DELAY)

    def _handle_binance_depth(self, data: dict, sym: str) -> None:
        """Handle Binance @depth@100ms incremental diff.

        Payload fields:
          b: [[price, qty], ...]  bids to update (qty=0 means delete)
          a: [[price, qty], ...]  asks to update (qty=0 means delete)
        """
        bid_diffs = [(float(p), float(q)) for p, q in data.get("b", [])]
        ask_diffs = [(float(p), float(q)) for p, q in data.get("a", [])]
        self._l2.apply_depth_diff(sym, "binance", bid_diffs, ask_diffs)

    async def _handle_binance_liq(self, o: dict, event_sym: str):
        ap = float(o.get("ap") or 0)
        if ap == 0:
            return
        qty = float(o.get("z") or o.get("q") or 0)
        usd = qty * ap
        if usd <= 0:
            return
        side  = "short" if o.get("S") == "BUY" else "long"
        price = ap
        await self._strategy.on_liquidation("binance", side, usd, price, o.get("s", ""), event_sym)
        await self._impact.on_liquidation("binance", side, usd, price, sym=event_sym)

    async def _handle_binance_kline(self, k: dict, event_sym: str):
        if event_sym != self._s.symbol:
            return

        from engine.state import TF_MINUTES

        is_1m_closed = k.get("x", False)
        t_1m  = int(k["t"])
        o_1m  = float(k["o"])
        h_1m  = float(k["h"])
        l_1m  = float(k["l"])
        c_1m  = float(k["c"])
        v_1m  = float(k["v"])

        tf_ms     = TF_MINUTES[self._s.timeframe] * 60_000
        tf_bucket = (t_1m // tf_ms) * tf_ms
        is_tf_close = is_1m_closed and (t_1m + 60_000 >= tf_bucket + tf_ms)

        agg_key = f"{event_sym}:{tf_bucket}"
        if agg_key not in self._agg:
            self._agg[agg_key] = {
                "o": o_1m, "h": h_1m, "l": l_1m, "c": c_1m,
                "confirmed_vol": 0.0,
                "open_1m_vol":   0.0,
            }
        agg = self._agg[agg_key]
        agg["h"] = max(agg["h"], h_1m)
        agg["l"] = min(agg["l"], l_1m)
        agg["c"] = c_1m
        if is_1m_closed:
            agg["confirmed_vol"] += v_1m
            agg["open_1m_vol"]    = 0.0
        else:
            agg["open_1m_vol"] = v_1m

        c_tf = {
            "t": tf_bucket,
            "o": agg["o"],
            "h": agg["h"],
            "l": agg["l"],
            "c": agg["c"],
            "v": agg["confirmed_vol"] + agg["open_1m_vol"],
        }

        if is_tf_close:
            self._strategy.update_candle(c_tf, True)
            self._s.price = c_tf["c"]
            await self._hub.broadcast({"type": "kline", **c_tf, "closed": True})
            cutoff = f"{event_sym}:{tf_bucket - tf_ms}"
            for old in [b for b in list(self._agg) if b.startswith(f"{event_sym}:") and b <= cutoff]:
                del self._agg[old]
        else:
            last_t = self._last_candle_open_t.get(event_sym, 0)
            if tf_bucket != last_t:
                self._last_candle_open_t[event_sym] = tf_bucket
                self._strategy.update_candle(c_tf, False)
                await self._hub.broadcast({"type": "candle_open", **c_tf})
                log.debug(f"New candle opened: t={tf_bucket} o={c_tf['o']}")
            else:
                existing = next(
                    (x for x in self._s.candles if x["t"] == tf_bucket), None
                )
                if existing and not existing.get("closed"):
                    existing.update({
                        "h": c_tf["h"], "l": c_tf["l"],
                        "c": c_tf["c"], "v": c_tf["v"],
                    })

    async def _handle_binance_trade(self, d: dict, event_sym: str):
        price    = float(d.get("p", 0))
        qty      = float(d.get("q", 0))
        is_buy   = not d.get("m", True)
        notional = qty * price
        await self._strategy.update_delta(
            notional if is_buy else -notional, int(d.get("T", 0)), event_sym
        )
        await self._strategy.update_price_tick(price, notional, int(d.get("T", 0)), event_sym)

    # ------------------------------------------------------------------
    # Bybit
    # ------------------------------------------------------------------
    async def _run_bybit(self, gen: int):
        from engine.state import SYMBOL_MAP
        await self._set_dot("bybit", "connecting")
        url = "wss://stream.bybit.com/v5/public/linear"
        bybit_to_sym = {m["bybit"]: s for s, m in SYMBOL_MAP.items()}
        while True:
            if self._gen != gen:
                return
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("bybit")
                    args = []
                    for sym, mapping in SYMBOL_MAP.items():
                        s = mapping["bybit"]
                        args += [
                            f"allLiquidation.{s}",
                            f"publicTrade.{s}",
                            f"orderbook.50.{s}",   # snapshot on connect, delta thereafter
                        ]
                    await ws.send(json.dumps({"op": "subscribe", "args": args}))
                    ping_task = asyncio.create_task(self._bybit_ping(ws))
                    try:
                        async for raw in ws:
                            if self._gen != gen:
                                return
                            msg = _safe_json(raw)
                            if not msg or "topic" not in msg:
                                continue
                            topic = msg["topic"]
                            data  = msg.get("data", [])
                            items = data if isinstance(data, list) else [data]
                            if topic.startswith("allLiquidation"):
                                for d in items:
                                    event_sym = bybit_to_sym.get(d.get("s"))
                                    if not event_sym:
                                        continue
                                    side  = "short" if d.get("S") == "Buy" else "long"
                                    price = float(d.get("p", 0))
                                    usd   = float(d.get("v", 0)) * price
                                    await self._strategy.on_liquidation(
                                        "bybit", side, usd, price, d.get("s", ""), event_sym
                                    )
                                    await self._impact.on_liquidation("bybit", side, usd, price, sym=event_sym)
                            elif topic.startswith("publicTrade"):
                                for d in items:
                                    event_sym = bybit_to_sym.get(d.get("s"))
                                    if not event_sym:
                                        continue
                                    price    = float(d.get("p", 0))
                                    notional = self._strategy.get_trade_notional(
                                        "bybit", event_sym, float(d.get("v", 0)), price
                                    )
                                    is_buy = d.get("S") == "Buy"
                                    await self._strategy.update_delta(
                                        notional if is_buy else -notional, int(d.get("T", 0)), event_sym
                                    )
                                    await self._strategy.update_price_tick(
                                        price, notional, int(d.get("T", 0)), event_sym
                                    )
                            elif topic.startswith("orderbook"):
                                self._handle_bybit_depth(msg, bybit_to_sym)
                    finally:
                        ping_task.cancel()
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug(f"Bybit WS error: {e}")
            if self._gen != gen:
                return
            await self._on_disconnected("bybit")
            await asyncio.sleep(RECONNECT_DELAY)

    def _handle_bybit_depth(self, msg: dict, bybit_to_sym: dict) -> None:
        """Handle Bybit orderbook.50 snapshot and delta messages.

        msg["type"] == "snapshot"  → full book replacement
        msg["type"] == "delta"     → incremental diffs (delete = qty "0")
        """
        topic = msg.get("topic", "")
        # topic format: "orderbook.50.BTCUSDT"
        parts = topic.split(".")
        if len(parts) < 3:
            return
        raw_sym = parts[2]
        sym = bybit_to_sym.get(raw_sym)
        if sym is None:
            return
        data     = msg.get("data", {})
        msg_type = msg.get("type", "delta")
        bids_raw = data.get("b", [])
        asks_raw = data.get("a", [])
        # Bybit sends [["price", "qty"], ...]; qty "0" means delete
        bids = [(float(p), float(q)) for p, q in bids_raw]
        asks = [(float(p), float(q)) for p, q in asks_raw]
        if msg_type == "snapshot":
            self._l2.apply_depth_snapshot(sym, "bybit", bids, asks)
        else:
            self._l2.apply_depth_diff(sym, "bybit", bids, asks)

    async def _bybit_ping(self, ws):
        while True:
            await asyncio.sleep(20)
            try:
                await ws.send('{"op":"ping"}')
            except Exception:
                break

    # ------------------------------------------------------------------
    # OKX
    # ------------------------------------------------------------------
    async def _run_okx(self, gen: int):
        from engine.state import SYMBOL_MAP
        await self._set_dot("okx", "connecting")
        url = "wss://ws.okx.com:8443/ws/v5/public"
        okx_to_sym = {m["okx"]: s for s, m in SYMBOL_MAP.items()}
        while True:
            if self._gen != gen:
                return
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("okx")
                    trade_args = [
                        {"channel": "liquidation-orders", "instType": "SWAP"},
                    ]
                    for sym, mapping in SYMBOL_MAP.items():
                        trade_args.append({"channel": "trades",         "instId": mapping["okx"]})
                        trade_args.append({"channel": "books50-l2-tbt", "instId": mapping["okx"]})
                    await ws.send(json.dumps({"op": "subscribe", "args": trade_args}))
                    ping_task = asyncio.create_task(self._okx_ping(ws))
                    try:
                        async for raw in ws:
                            if self._gen != gen:
                                return
                            if raw == "pong":
                                continue
                            msg = _safe_json(raw)
                            if not msg:
                                continue
                            arg  = msg.get("arg", {})
                            data = msg.get("data", [])
                            ch   = arg.get("channel", "")
                            if ch == "liquidation-orders" and data:
                                for d in data:
                                    inst_id = d.get("instId", "")
                                    event_sym = okx_to_sym.get(inst_id)
                                    if not event_sym:
                                        continue
                                    for det in d.get("details", []):
                                        ps = det.get("posSide", "")
                                        side = ("long"  if ps == "long" else
                                                "short" if ps == "short" else
                                                "long"  if det.get("side") == "sell" else "short")
                                        bk_px = float(det.get("bkPx") or det.get("px") or 0)
                                        usd   = float(det.get("sz", 0)) * bk_px
                                        if usd > 0:
                                            await self._strategy.on_liquidation(
                                                "okx", side, usd, bk_px, inst_id, event_sym
                                            )
                                            await self._impact.on_liquidation("okx", side, usd, bk_px, sym=event_sym)
                            elif ch == "trades" and data:
                                inst_id = arg.get("instId", "")
                                event_sym = okx_to_sym.get(inst_id)
                                if not event_sym:
                                    continue
                                for d in data:
                                    price    = float(d.get("px", 0))
                                    notional = self._strategy.get_trade_notional(
                                        "okx", event_sym, float(d.get("sz", 0)), price
                                    )
                                    is_buy = d.get("side") == "buy"
                                    await self._strategy.update_delta(
                                        notional if is_buy else -notional, int(d.get("ts", 0)), event_sym
                                    )
                                    await self._strategy.update_price_tick(
                                        price, notional, int(d.get("ts", 0)), event_sym
                                    )
                            elif ch == "books50-l2-tbt" and data:
                                self._handle_okx_depth(msg, okx_to_sym)
                    finally:
                        ping_task.cancel()
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug(f"OKX WS error: {e}")
            if self._gen != gen:
                return
            await self._on_disconnected("okx")
            await asyncio.sleep(RECONNECT_DELAY)

    def _handle_okx_depth(self, msg: dict, okx_to_sym: dict) -> None:
        """Handle OKX books50-l2-tbt snapshot and update messages.

        msg["action"] == "snapshot"  → full book replacement
        msg["action"] == "update"    → incremental diffs (qty "0" means delete)
        Each data item has "bids": [[price, qty, ...], ...]
        """
        action   = msg.get("action", "update")
        inst_id  = msg.get("arg", {}).get("instId", "")
        sym      = okx_to_sym.get(inst_id)
        if sym is None:
            return
        data = msg.get("data", [])
        if not data:
            return
        item     = data[0]
        bids_raw = item.get("bids", [])
        asks_raw = item.get("asks", [])
        # OKX format: [["price", "qty", "", ""], ...]
        bids = [(float(row[0]), float(row[1])) for row in bids_raw]
        asks = [(float(row[0]), float(row[1])) for row in asks_raw]
        if action == "snapshot":
            self._l2.apply_depth_snapshot(sym, "okx", bids, asks)
        else:
            self._l2.apply_depth_diff(sym, "okx", bids, asks)

    async def _okx_ping(self, ws):
        while True:
            await asyncio.sleep(25)
            try:
                await ws.send("ping")
            except Exception:
                break

    # ------------------------------------------------------------------
    # Bitget
    # ------------------------------------------------------------------
    async def _run_bitget(self, gen: int):
        from engine.state import SYMBOL_MAP
        await self._set_dot("bitget", "connecting")
        url = "wss://ws.bitget.com/v2/ws/public"
        bitget_to_sym = {m["bitget"]: s for s, m in SYMBOL_MAP.items()}
        while True:
            if self._gen != gen:
                return
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("bitget")
                    args = []
                    for sym, mapping in SYMBOL_MAP.items():
                        s = mapping["bitget"]
                        args += [
                            {"instType": "USDT-FUTURES", "channel": "liquidation-order", "instId": s},
                            {"instType": "USDT-FUTURES", "channel": "trade",             "instId": s},
                            {"instType": "USDT-FUTURES", "channel": "books15",           "instId": s},
                        ]
                    await ws.send(json.dumps({"op": "subscribe", "args": args}))
                    ping_task = asyncio.create_task(self._bitget_ping(ws))
                    try:
                        async for raw in ws:
                            if self._gen != gen:
                                return
                            if raw == "pong":
                                continue
                            msg = _safe_json(raw)
                            if not msg or "arg" not in msg:
                                continue
                            ch      = msg["arg"].get("channel", "")
                            inst_id = msg["arg"].get("instId", "")
                            event_sym = bitget_to_sym.get(inst_id)
                            if not event_sym:
                                continue
                            data  = msg.get("data", [])
                            items = data if isinstance(data, list) else [data]
                            if ch == "liquidation-order" and items:
                                for d in items:
                                    ps   = d.get("posSide", "")
                                    side = ("long"  if ps == "long"  else
                                            "short" if ps == "short" else
                                            "long"  if d.get("side") == "sell" else "short")
                                    fp   = float(d.get("fillPx") or d.get("price") or 0)
                                    sz   = float(d.get("sz") or d.get("size") or 0)
                                    usd  = sz * fp
                                    if usd > 0:
                                        await self._strategy.on_liquidation(
                                            "bitget", side, usd, fp, inst_id, event_sym
                                        )
                                        await self._impact.on_liquidation("bitget", side, usd, fp, sym=event_sym)
                            elif ch == "trade" and items:
                                for d in items:
                                    price    = float(d.get("price", 0))
                                    notional = self._strategy.get_trade_notional(
                                        "bitget", event_sym, float(d.get("sz", 0)), price
                                    )
                                    is_buy = d.get("side") == "buy"
                                    await self._strategy.update_delta(
                                        notional if is_buy else -notional, int(d.get("ts", 0)), event_sym
                                    )
                                    await self._strategy.update_price_tick(
                                        price, notional, int(d.get("ts", 0)), event_sym
                                    )
                            elif ch == "books15" and items:
                                self._handle_bitget_depth(msg, event_sym)
                    finally:
                        ping_task.cancel()
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug(f"Bitget WS error: {e}")
            if self._gen != gen:
                return
            await self._on_disconnected("bitget")
            await asyncio.sleep(RECONNECT_DELAY)

    def _handle_bitget_depth(self, msg: dict, sym: str) -> None:
        """Handle Bitget books15 snapshot and update messages.

        msg["action"] == "snapshot"  → full book
        msg["action"] == "update"    → incremental diffs (qty 0 means delete)
        data[0] has "bids": [[price, qty], ...]
        """
        action = msg.get("action", "update")
        data   = msg.get("data", [])
        if not data:
            return
        item     = data[0]
        bids_raw = item.get("bids", [])
        asks_raw = item.get("asks", [])
        bids = [(float(p), float(q)) for p, q in bids_raw]
        asks = [(float(p), float(q)) for p, q in asks_raw]
        if action == "snapshot":
            self._l2.apply_depth_snapshot(sym, "bitget", bids, asks)
        else:
            self._l2.apply_depth_diff(sym, "bitget", bids, asks)

    async def _bitget_ping(self, ws):
        while True:
            await asyncio.sleep(25)
            try:
                await ws.send("ping")
            except Exception:
                break

    # ------------------------------------------------------------------
    # Gate
    # ------------------------------------------------------------------
    async def _run_gate(self, gen: int):
        from engine.state import SYMBOL_MAP
        await self._set_dot("gate", "connecting")
        url = "wss://fx-ws.gateio.ws/v4/ws/usdt"
        gate_to_sym = {m["gate"]: s for s, m in SYMBOL_MAP.items()}
        while True:
            if self._gen != gen:
                return
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("gate")
                    t = int(time.time())
                    all_syms = [m["gate"] for m in SYMBOL_MAP.values()]
                    await ws.send(json.dumps({
                        "time": t, "channel": "futures.liquidates",
                        "event": "subscribe", "payload": all_syms
                    }))
                    await ws.send(json.dumps({
                        "time": t, "channel": "futures.trades",
                        "event": "subscribe", "payload": all_syms
                    }))
                    # Subscribe to 100ms incremental depth for all symbols
                    for contract in all_syms:
                        await ws.send(json.dumps({
                            "time": t, "channel": "futures.order_book_update",
                            "event": "subscribe",
                            "payload": [contract, "100ms", "20"],
                        }))
                    ping_task = asyncio.create_task(self._gate_ping(ws))
                    try:
                        async for raw in ws:
                            if self._gen != gen:
                                return
                            msg = _safe_json(raw)
                            if not msg or "channel" not in msg:
                                continue
                            ch     = msg["channel"]
                            result = msg.get("result", [])
                            items  = result if isinstance(result, list) else [result]
                            if ch == "futures.liquidates" and items:
                                for d in items:
                                    contract = d.get("contract", "")
                                    event_sym = gate_to_sym.get(contract)
                                    if not event_sym:
                                        continue
                                    side  = "long" if d.get("left", 0) < 0 else "short"
                                    price = float(d.get("fill_price") or d.get("price") or 0)
                                    usd   = abs(float(d.get("left", 0))) * price
                                    if usd > 0:
                                        await self._strategy.on_liquidation(
                                            "gate", side, usd, price, contract, event_sym
                                        )
                                        await self._impact.on_liquidation("gate", side, usd, price, sym=event_sym)
                            elif ch == "futures.trades" and items:
                                for d in items:
                                    contract  = d.get("contract", "")
                                    event_sym = gate_to_sym.get(contract)
                                    if not event_sym:
                                        continue
                                    price    = float(d.get("price", 0))
                                    notional = self._strategy.get_trade_notional(
                                        "gate", event_sym, abs(float(d.get("size", 0))), price
                                    )
                                    is_buy = float(d.get("size", 0)) > 0
                                    ts_ms  = int(d.get("create_time_ms", time.time() * 1000))
                                    await self._strategy.update_delta(
                                        notional if is_buy else -notional, ts_ms, event_sym
                                    )
                                    await self._strategy.update_price_tick(
                                        price, notional, ts_ms, event_sym
                                    )
                            elif ch == "futures.order_book_update" and result:
                                self._handle_gate_depth(result, gate_to_sym)
                    finally:
                        ping_task.cancel()
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug(f"Gate WS error: {e}")
            if self._gen != gen:
                return
            await self._on_disconnected("gate")
            await asyncio.sleep(RECONNECT_DELAY)

    def _handle_gate_depth(self, result: dict, gate_to_sym: dict) -> None:
        """Handle Gate futures.order_book_update incremental diffs.

        Gate always sends full levels in each diff (no separate snapshot
        message type). qty 0 means the level was removed.
        result fields: contract, bids: [{p, s}, ...], asks: [{p, s}, ...]
        """
        contract  = result.get("contract", "")
        sym       = gate_to_sym.get(contract)
        if sym is None:
            return
        bids_raw  = result.get("bids", [])
        asks_raw  = result.get("asks", [])
        bid_diffs = [(float(d["p"]), float(d["s"])) for d in bids_raw]
        ask_diffs = [(float(d["p"]), float(d["s"])) for d in asks_raw]
        # Gate sends the first full update as an implicit snapshot.
        # apply_depth_diff handles missing snapshot gracefully (no-op until
        # snapshot arrives). For Gate we treat every message as a diff since
        # there is no explicit snapshot/delta distinction in this channel.
        self._l2.apply_depth_diff(sym, "gate", bid_diffs, ask_diffs)

    async def _gate_ping(self, ws):
        while True:
            await asyncio.sleep(55)
            try:
                t = int(time.time())
                await ws.send(json.dumps({"time": t, "channel": "futures.ping"}))
            except Exception:
                break

    # ------------------------------------------------------------------
    # dYdX — trades only; no liquidation feed, no depth stream
    # ------------------------------------------------------------------
    async def _run_dydx(self, gen: int):
        from engine.state import SYMBOL_MAP
        await self._set_dot("dydx", "connecting")
        url = "wss://indexer.dydx.trade/v4/ws"
        dydx_to_sym = {m["dydx"]: s for s, m in SYMBOL_MAP.items()}
        while True:
            if self._gen != gen:
                return
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("dydx")
                    for sym, mapping in SYMBOL_MAP.items():
                        await ws.send(json.dumps({
                            "type": "subscribe",
                            "channel": "v4_trades",
                            "id": mapping["dydx"],
                        }))
                    async for raw in ws:
                        if self._gen != gen:
                            return
                        msg = _safe_json(raw)
                        if not msg:
                            continue
                        ch       = msg.get("channel", "")
                        msg_type = msg.get("type", "")
                        if ch != "v4_trades":
                            continue
                        market_id = msg.get("id", "")
                        event_sym = dydx_to_sym.get(market_id)
                        if not event_sym:
                            continue
                        contents = msg.get("contents", {})
                        trades_data = []
                        if msg_type == "subscribed":
                            trades_data = contents.get("trades", [])
                        elif msg_type == "channel_data":
                            trades_data = contents.get("trades", [])
                        for t in trades_data:
                            price    = float(t.get("price", 0))
                            notional = self._strategy.get_trade_notional(
                                "dydx", event_sym, float(t.get("size", 0)), price
                            )
                            is_buy = t.get("side") == "BUY"
                            ts_s   = t.get("createdAt", "")
                            try:
                                dt    = datetime.fromisoformat(ts_s.replace("Z", "+00:00"))
                                ts_ms = int(dt.timestamp() * 1000)
                            except Exception:
                                ts_ms = int(time.time() * 1000)
                            await self._strategy.update_delta(
                                notional if is_buy else -notional, ts_ms, event_sym
                            )
                            await self._strategy.update_price_tick(
                                price, notional, ts_ms, event_sym
                            )
            except asyncio.CancelledError:
                return
            except Exception as e:
                log.debug(f"dYdX WS error: {e}")
            if self._gen != gen:
                return
            await self._on_disconnected("dydx")
            await asyncio.sleep(RECONNECT_DELAY)
