"""All 6 exchange WebSocket connectors — Python port of websocket.js.

Each connector runs as an independent asyncio Task with auto-reconnect.
Normalized events are forwarded to Strategy, which handles state mutation
and broadcasts to frontend clients via the BroadcastHub.
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

RECONNECT_DELAY = 3.0  # seconds before reconnect attempt


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

    # expose for REST layer
    @property
    def strategy(self) -> "Strategy":
        return self._strategy

    @property
    def impact(self) -> "ImpactRecorder":
        return self._impact

    # ------------------------------------------------------------------
    async def start(self):
        await self._l2.start()
        await self._connect_all()

    async def stop(self):
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self._l2.stop()

    async def reconnect_all(self):
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        self._s.connected_ws = 0
        await self._connect_all()

    async def _connect_all(self):
        sym = self._s.symbol
        self._tasks = [
            asyncio.create_task(self._run_binance(sym), name="binance"),
            asyncio.create_task(self._run_bybit(sym),   name="bybit"),
            asyncio.create_task(self._run_okx(sym),     name="okx"),
            asyncio.create_task(self._run_bitget(sym),  name="bitget"),
            asyncio.create_task(self._run_gate(sym),    name="gate"),
            asyncio.create_task(self._run_dydx(sym),    name="dydx"),
        ]

    # ------------------------------------------------------------------
    async def _set_dot(self, name: str, status: str):
        self._dot_status[name] = status
        await self._hub.broadcast({"type": "conn_status", "exchange": name, "status": status})

    async def _on_connected(self, name: str):
        if self._dot_status.get(name) != "connected":
            self._s.connected_ws += 1
        await self._set_dot(name, "connected")
        await self._hub.broadcast({"type": "ws_count", "count": self._s.connected_ws})

    async def _on_disconnected(self, name: str):
        if self._s.connected_ws > 0:
            self._s.connected_ws -= 1
        await self._set_dot(name, "error")
        await self._hub.broadcast({"type": "ws_count", "count": self._s.connected_ws})

    # ------------------------------------------------------------------
    # History fetch (Binance REST)
    # ------------------------------------------------------------------
    async def _fetch_binance_history(self, sym: str, tf: str):
        from engine.state import SYMBOL_MAP, TF_BINANCE
        s_name = SYMBOL_MAP[sym]["binance"].upper()
        tf_b   = TF_BINANCE[tf]
        url = f"https://fapi.binance.com/fapi/v1/klines?symbol={s_name}&interval={tf_b}&limit=300"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(url)
                r.raise_for_status()
                data = r.json()
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
                "type":    "history",
                "candles": self._s.candles,
                "liq_bars": self._s.liq_bars,
                "delta_bars": self._s.delta_bars,
                "price":   self._s.price,
            })
            log.info(f"Loaded {len(self._s.candles)} candles for {sym} {tf}")
        except Exception as e:
            log.warning(f"History fetch failed: {e}")

    # ------------------------------------------------------------------
    # Binance
    # ------------------------------------------------------------------
    async def _run_binance(self, sym: str):
        from engine.state import SYMBOL_MAP, TF_BINANCE
        await self._set_dot("binance", "connecting")
        while True:
            s_name = SYMBOL_MAP[sym]["binance"]
            tf_b   = TF_BINANCE[self._s.timeframe]
            url = (f"wss://fstream.binance.com/stream?streams="
                   f"{s_name}@forceOrder/{s_name}@kline_{tf_b}/{s_name}@aggTrade")
            try:
                async with websockets.connect(url, ping_interval=20) as ws:
                    await self._on_connected("binance")
                    log.info("Binance: connected")
                    asyncio.create_task(self._fetch_binance_history(sym, self._s.timeframe))
                    async for raw in ws:
                        if self._s.symbol != sym:
                            break
                        msg = _safe_json(raw)
                        if not msg or "stream" not in msg:
                            continue
                        stream = msg["stream"]
                        data   = msg.get("data", {})
                        if "forceOrder" in stream:
                            await self._handle_binance_liq(data.get("o", {}))
                        elif "kline" in stream:
                            await self._handle_binance_kline(data.get("k", {}))
                        elif "aggTrade" in stream:
                            await self._handle_binance_trade(data)
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug(f"Binance WS error: {e}")
            await self._on_disconnected("binance")
            await asyncio.sleep(RECONNECT_DELAY)

    async def _handle_binance_liq(self, o: dict):
        side  = "short" if o.get("S") == "BUY" else "long"
        price = float(o.get("ap") or o.get("p") or 0)
        usd   = float(o.get("q", 0)) * price
        await self._strategy.on_liquidation("binance", side, usd, price, o.get("s", ""))
        await self._impact.on_liquidation("binance", side, usd, price)

    async def _handle_binance_kline(self, k: dict):
        c = {"t": k["t"], "o": float(k["o"]), "h": float(k["h"]),
             "l": float(k["l"]), "c": float(k["c"]), "v": float(k["v"])}
        self._strategy.update_candle(c, k.get("x", False))
        self._s.price = c["c"]
        await self._hub.broadcast({"type": "kline", **c, "closed": k.get("x", False)})

    async def _handle_binance_trade(self, d: dict):
        is_buy = not d.get("m", True)
        vol    = float(d.get("q", 0)) * float(d.get("p", 0))
        await self._strategy.update_delta(vol if is_buy else -vol, int(d.get("T", 0)))

    # ------------------------------------------------------------------
    # Bybit
    # ------------------------------------------------------------------
    async def _run_bybit(self, sym: str):
        from engine.state import SYMBOL_MAP
        await self._set_dot("bybit", "connecting")
        s_name = SYMBOL_MAP[sym]["bybit"]
        url = "wss://stream.bybit.com/v5/public/linear"
        while True:
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("bybit")
                    log.info("Bybit: connected")
                    await ws.send(json.dumps({"op": "subscribe", "args": [
                        f"allLiquidation.{s_name}", f"publicTrade.{s_name}"
                    ]}))
                    ping_task = asyncio.create_task(self._bybit_ping(ws))
                    try:
                        async for raw in ws:
                            if self._s.symbol != sym:
                                break
                            msg = _safe_json(raw)
                            if not msg or "topic" not in msg:
                                continue
                            topic = msg["topic"]
                            data  = msg.get("data", [])
                            items = data if isinstance(data, list) else [data]
                            if topic.startswith("allLiquidation"):
                                for d in items:
                                    side  = "short" if d.get("S") == "Buy" else "long"
                                    price = float(d.get("p", 0))
                                    usd   = float(d.get("v", 0)) * price
                                    await self._strategy.on_liquidation("bybit", side, usd, price, d.get("s", ""))
                                    await self._impact.on_liquidation("bybit", side, usd, price)
                            elif topic.startswith("publicTrade"):
                                for d in items:
                                    notional = self._strategy.get_trade_notional("bybit", sym, float(d.get("v", 0)), float(d.get("p", 0)))
                                    await self._strategy.update_delta(notional if d.get("S") == "Buy" else -notional, int(d.get("T", 0)))
                    finally:
                        ping_task.cancel()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug(f"Bybit WS error: {e}")
            await self._on_disconnected("bybit")
            await asyncio.sleep(RECONNECT_DELAY)

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
    async def _run_okx(self, sym: str):
        from engine.state import SYMBOL_MAP
        await self._set_dot("okx", "connecting")
        s_name = SYMBOL_MAP[sym]["okx"]
        url = "wss://ws.okx.com:8443/ws/v5/public"
        while True:
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("okx")
                    log.info("OKX: connected")
                    await ws.send(json.dumps({"op": "subscribe", "args": [
                        {"channel": "liquidation-orders", "instType": "SWAP"},
                        {"channel": "trades", "instId": s_name},
                    ]}))
                    ping_task = asyncio.create_task(self._okx_ping(ws))
                    try:
                        async for raw in ws:
                            if self._s.symbol != sym:
                                break
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
                                    if d.get("instId") != s_name:
                                        continue
                                    for det in d.get("details", []):
                                        ps = det.get("posSide", "")
                                        side = ("long"  if ps == "long" else
                                                "short" if ps == "short" else
                                                "long"  if det.get("side") == "sell" else "short")
                                        bk_px = float(det.get("bkPx") or det.get("px") or 0)
                                        usd   = float(det.get("sz", 0)) * bk_px
                                        if usd > 0:
                                            await self._strategy.on_liquidation("okx", side, usd, bk_px, s_name)
                                            await self._impact.on_liquidation("okx", side, usd, bk_px)
                            elif ch == "trades" and data:
                                for d in data:
                                    notional = self._strategy.get_trade_notional("okx", sym, float(d.get("sz", 0)), float(d.get("px", 0)))
                                    await self._strategy.update_delta(notional if d.get("side") == "buy" else -notional, int(d.get("ts", 0)))
                    finally:
                        ping_task.cancel()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug(f"OKX WS error: {e}")
            await self._on_disconnected("okx")
            await asyncio.sleep(RECONNECT_DELAY)

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
    async def _run_bitget(self, sym: str):
        from engine.state import SYMBOL_MAP
        await self._set_dot("bitget", "connecting")
        s_name = SYMBOL_MAP[sym]["bitget"]
        url = "wss://ws.bitget.com/v2/ws/public"
        while True:
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("bitget")
                    log.info("Bitget: connected")
                    await ws.send(json.dumps({"op": "subscribe", "args": [
                        {"instType": "USDT-FUTURES", "channel": "liquidation-order", "instId": s_name},
                        {"instType": "USDT-FUTURES", "channel": "trade",             "instId": s_name},
                    ]}))
                    ping_task = asyncio.create_task(self._bitget_ping(ws))
                    try:
                        async for raw in ws:
                            if self._s.symbol != sym:
                                break
                            if raw == "pong":
                                continue
                            msg = _safe_json(raw)
                            if not msg or "arg" not in msg:
                                continue
                            ch   = msg["arg"].get("channel", "")
                            data = msg.get("data", [])
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
                                        await self._strategy.on_liquidation("bitget", side, usd, fp, s_name)
                                        await self._impact.on_liquidation("bitget", side, usd, fp)
                            elif ch == "trade" and items:
                                for d in items:
                                    notional = self._strategy.get_trade_notional("bitget", sym, float(d.get("sz", 0)), float(d.get("price", 0)))
                                    await self._strategy.update_delta(notional if d.get("side") == "buy" else -notional, int(d.get("ts", 0)))
                    finally:
                        ping_task.cancel()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug(f"Bitget WS error: {e}")
            await self._on_disconnected("bitget")
            await asyncio.sleep(RECONNECT_DELAY)

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
    async def _run_gate(self, sym: str):
        from engine.state import SYMBOL_MAP
        await self._set_dot("gate", "connecting")
        s_name = SYMBOL_MAP[sym]["gate"]
        url = "wss://fx-ws.gateio.ws/v4/ws/usdt"
        while True:
            try:
                async with websockets.connect(url, ping_interval=None) as ws:
                    await self._on_connected("gate")
                    log.info("Gate: connected")
                    t = int(time.time())
                    await ws.send(json.dumps({"time": t, "channel": "futures.liquidates", "event": "subscribe", "payload": [s_name]}))
                    await ws.send(json.dumps({"time": t, "channel": "futures.trades",     "event": "subscribe", "payload": [s_name]}))
                    ping_task = asyncio.create_task(self._gate_ping(ws))
                    try:
                        async for raw in ws:
                            if self._s.symbol != sym:
                                break
                            msg = _safe_json(raw)
                            if not msg or "channel" not in msg:
                                continue
                            ch     = msg["channel"]
                            result = msg.get("result", [])
                            items  = result if isinstance(result, list) else [result]
                            if ch == "futures.liquidates" and items:
                                for d in items:
                                    side = "short" if d.get("order_side") == "buy" else "long"
                                    fp   = float(d.get("fill_price", 0))
                                    sz   = abs(float(d.get("size", 0)))
                                    usd  = sz * fp
                                    if usd > 0:
                                        await self._strategy.on_liquidation("gate", side, usd, fp, s_name)
                                        await self._impact.on_liquidation("gate", side, usd, fp)
                            elif ch == "futures.trades" and items:
                                for d in items:
                                    sz   = float(d.get("size", 0))
                                    fp   = float(d.get("price", 0))
                                    notional = self._strategy.get_trade_notional("gate", sym, abs(sz), fp)
                                    ts_ms = int(float(d.get("create_time", 0)) * 1000)
                                    await self._strategy.update_delta(notional if sz > 0 else -notional, ts_ms)
                    finally:
                        ping_task.cancel()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug(f"Gate WS error: {e}")
            await self._on_disconnected("gate")
            await asyncio.sleep(RECONNECT_DELAY)

    async def _gate_ping(self, ws):
        while True:
            await asyncio.sleep(20)
            try:
                await ws.send(json.dumps({"time": int(time.time()), "channel": "futures.ping"}))
            except Exception:
                break

    # ------------------------------------------------------------------
    # dYdX
    # ------------------------------------------------------------------
    async def _run_dydx(self, sym: str):
        from engine.state import SYMBOL_MAP
        await self._set_dot("dydx", "connecting")
        s_name = SYMBOL_MAP[sym]["dydx"]
        url = "wss://indexer.dydx.trade/v4/ws"
        while True:
            try:
                async with websockets.connect(url, ping_interval=20) as ws:
                    await self._on_connected("dydx")
                    log.info("dYdX: connected")
                    await ws.send(json.dumps({"type": "subscribe", "channel": "v4_trades", "id": s_name}))
                    async for raw in ws:
                        if self._s.symbol != sym:
                            break
                        msg = _safe_json(raw)
                        if not msg or "contents" not in msg:
                            continue
                        for t in msg["contents"].get("trades", []):
                            is_buy   = t.get("side") == "BUY"
                            size     = float(t.get("size",  0))
                            price    = float(t.get("price", 0))
                            vol      = size * price
                            notional = self._strategy.get_trade_notional("dydx", sym, size, price)
                            ts_ms    = int(datetime.fromisoformat(
                                t["createdAt"].replace("Z", "+00:00")
                            ).timestamp() * 1000) if t.get("createdAt") else int(time.time() * 1000)
                            await self._strategy.update_delta(notional if is_buy else -notional, ts_ms)
                            # dYdX heuristic: large trade ≈ 8% liquidation
                            if vol > 50_000:
                                liq_side = "short" if is_buy else "long"
                                await self._strategy.on_liquidation("dydx", liq_side, vol * 0.08, price, s_name)
                                await self._impact.on_liquidation("dydx", liq_side, vol * 0.08, price)
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug(f"dYdX WS error: {e}")
            await self._on_disconnected("dydx")
            await asyncio.sleep(RECONNECT_DELAY)
