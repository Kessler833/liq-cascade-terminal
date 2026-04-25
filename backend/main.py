"""FastAPI application entry-point.

Exposes:
  WS  /ws                  — single broadcast channel to all frontend clients
  GET /api/state           — snapshot of AppState
  GET /api/candles         — ?sym=BTC&tf=5m  (returns cached candles)
  GET /api/history         — ?sym=BTC&tf=5m&limit=500[&before=<ms>]  (REST candle fetch)
  GET /api/impact          — impact observations
  POST /api/symbol         — {symbol: "ETH"}  (hot-swap symbol; reconnect is fire-and-forget)
  POST /api/timeframe      — {timeframe: "1h"} (hot-swap timeframe; no reconnect needed)
  GET /healthz             — liveness probe
"""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from engine.state import AppState, DEFAULT_CASCADE_THRESHOLDS, SYMBOL_MAP

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("liqterm.main")


# ---------------------------------------------------------------------------
# Broadcast hub
# ---------------------------------------------------------------------------

class BroadcastHub:
    """Fan-out JSON messages to all connected WS clients."""

    def __init__(self):
        self._clients: set[WebSocket] = set()

    def add(self, ws: WebSocket):
        self._clients.add(ws)

    def remove(self, ws: WebSocket):
        self._clients.discard(ws)

    async def broadcast(self, data: dict):
        dead: list[WebSocket] = []
        payload = json.dumps(data)
        for ws in list(self._clients):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)

    @property
    def count(self) -> int:
        return len(self._clients)


# ---------------------------------------------------------------------------
# App bootstrap
# ---------------------------------------------------------------------------

app_state = AppState()
hub       = BroadcastHub()
conn_mgr  = None   # populated in lifespan


@asynccontextmanager
async def lifespan(app: FastAPI):
    global conn_mgr
    from engine.connections import ConnectionManager
    conn_mgr = ConnectionManager(app_state, hub)
    await conn_mgr.start()
    log.info("ConnectionManager started")
    yield
    await conn_mgr.stop()
    log.info("ConnectionManager stopped")


app = FastAPI(title="Liq Cascade Terminal", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    hub.add(ws)
    log.info(f"WS client connected ({hub.count} total)")
    # Send immediate snapshot
    await ws.send_text(json.dumps(_build_snapshot()))
    try:
        while True:
            await ws.receive_text()   # keep-alive; ignore client messages
    except WebSocketDisconnect:
        pass
    finally:
        hub.remove(ws)
        log.info(f"WS client disconnected ({hub.count} total)")


def _build_snapshot() -> dict:
    s = app_state
    return {
        "type":      "snapshot",
        "symbol":    s.symbol,
        "timeframe": s.timeframe,
        "price":     s.price,
        "phase":     s.phase,
        "candles":   s.candles,
        "liq_bars":  s.liq_bars,
        "delta_bars":s.delta_bars,
        "feed":      s.feed[:40],
        "signal_log":s.signal_log[:30],
        "stats": {
            "total_liq":        s.total_liq,
            "total_liq_events": s.total_liq_events,
            "longs_liq_usd":    s.longs_liq_usd,
            "shorts_liq_usd":   s.shorts_liq_usd,
            "cascade_score":    s.cascade_score,
            "cascade_count":    s.cascade_count,
            "cumulative_delta": s.cumulative_delta,
            "liq_1m_bucket":    s.liq_1m_bucket,
            "exchanges":        s.exchanges,
        },
        "connected_ws": s.connected_ws,
        "conn_status":  dict(s.conn_status),
    }


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------

@app.get("/healthz")
async def healthz():
    return {"ok": True, "connected_ws": app_state.connected_ws}


@app.get("/api/state")
async def get_state():
    return _build_snapshot()


@app.get("/api/candles")
async def get_candles(sym: str = "BTC", tf: str = "5m"):
    return {
        "candles":    app_state.candles,
        "liq_bars":   app_state.liq_bars,
        "delta_bars": app_state.delta_bars,
    }


@app.get("/api/history")
async def get_history(sym: str = "BTC", tf: str = "5m", before: int = 0, limit: int = 500):
    """REST candle fetch.
    - before: endTime in ms for lazy-load pagination (omit for latest)
    - limit: max candles to return (capped at 500)
    """
    from engine.state import SYMBOL_MAP, TF_BINANCE
    import httpx
    mapping = SYMBOL_MAP.get(sym.upper(), {})
    s_name  = mapping.get("binance", "btcusdt").upper()
    tf_b    = TF_BINANCE.get(tf, "5m")
    limit   = min(max(limit, 1), 500)
    url     = f"https://fapi.binance.com/fapi/v1/klines?symbol={s_name}&interval={tf_b}&limit={limit}"
    if before:
        url += f"&endTime={before - 1}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url)
            r.raise_for_status()
        candles = [
            {"t": d[0], "o": float(d[1]), "h": float(d[2]),
             "l": float(d[3]), "c": float(d[4]), "v": float(d[5])}
            for d in r.json()
        ]
        return {"candles": candles}
    except Exception as e:
        log.warning(f"History fetch failed: {e}")
        return {"candles": []}


@app.get("/api/impact")
async def get_impact():
    if conn_mgr is None:
        return {"observations": []}
    obs = conn_mgr.impact.get_all()
    return {
        "observations": [conn_mgr.impact.to_serialisable(o) for o in obs[:50]],
    }


class SymbolRequest(BaseModel):
    symbol: str

class TimeframeRequest(BaseModel):
    timeframe: str


@app.post("/api/symbol")
async def set_symbol(req: SymbolRequest):
    sym = req.symbol.upper()
    if sym not in SYMBOL_MAP:
        return {"error": f"Unknown symbol {sym}", "valid": list(SYMBOL_MAP.keys())}
    if sym == app_state.symbol:
        return {"ok": True, "symbol": sym}
    app_state.symbol = sym
    app_state.cascade_threshold = DEFAULT_CASCADE_THRESHOLDS.get(sym, 5_000_000)
    app_state.reset_stats()
    await hub.broadcast({"type": "symbol_change", "symbol": sym})
    if conn_mgr:
        asyncio.create_task(conn_mgr.reconnect_all())
    return {"ok": True, "symbol": sym}


@app.post("/api/timeframe")
async def set_timeframe(req: TimeframeRequest):
    tf = req.timeframe
    from engine.state import TF_MINUTES
    if tf not in TF_MINUTES:
        return {"error": f"Unknown timeframe {tf}", "valid": list(TF_MINUTES.keys())}
    if tf == app_state.timeframe:
        return {"ok": True, "timeframe": tf}
    app_state.timeframe = tf
    app_state.candles    = []
    app_state.liq_bars   = []
    app_state.delta_bars = []
    await hub.broadcast({"type": "timeframe_change", "timeframe": tf})
    if conn_mgr:
        # No WS reconnect needed — the permanent @kline_1m stream keeps running.
        # on_timeframe_change resets agg state and re-fetches REST history.
        asyncio.create_task(conn_mgr.on_timeframe_change(app_state.symbol, tf))
    return {"ok": True, "timeframe": tf}
