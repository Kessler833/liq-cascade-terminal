"""FastAPI entry point for liq-cascade-terminal backend."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Set

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel

log = logging.getLogger("liqterm.main")
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s  %(asctime)s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)

# ---------------------------------------------------------------------------
# WebSocket broadcast hub
# ---------------------------------------------------------------------------
class BroadcastHub:
    def __init__(self):
        self._clients: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._clients.add(ws)
        log.info(f"WS client connected  ({len(self._clients)} total)")

    def disconnect(self, ws: WebSocket):
        self._clients.discard(ws)
        log.info(f"WS client disconnected  ({len(self._clients)} total)")

    async def broadcast(self, payload: dict):
        dead = set()
        msg = json.dumps(payload)
        for ws in list(self._clients):
            try:
                await ws.send_text(msg)
            except Exception:
                dead.add(ws)
        self._clients -= dead

hub = BroadcastHub()

# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    from engine.state import AppState
    from engine.connections import ConnectionManager

    Path(os.path.expanduser("~/.liqterm")).mkdir(parents=True, exist_ok=True)

    app_state = AppState()
    app.state.app_state = app_state
    app.state.start_time = time.time()

    conn_mgr = ConnectionManager(app_state, hub)
    app.state.conn_mgr = conn_mgr
    await conn_mgr.start()

    log.info("Backend started — connecting to exchanges…")
    yield

    await conn_mgr.stop()
    log.info("Backend stopped.")

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="liq-cascade-terminal", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    uptime = round(time.time() - app.state.start_time, 1)
    s = app.state.app_state
    return {"status": "ok", "uptime_s": uptime, "symbol": s.symbol, "connected_ws": s.connected_ws}

@app.get("/api/state")
async def get_state():
    s = app.state.app_state
    return JSONResponse(s.to_dict())

@app.get("/api/candles")
async def get_candles(sym: str = "BTC", tf: str = "5m"):
    s = app.state.app_state
    return JSONResponse({"candles": s.candles, "liq_bars": s.liq_bars, "delta_bars": s.delta_bars})

class SymbolRequest(BaseModel):
    symbol: str

class TimeframeRequest(BaseModel):
    tf: str

@app.post("/api/symbol")
async def set_symbol(req: SymbolRequest):
    sym = req.symbol.upper()
    if sym not in ("BTC", "ETH", "SOL"):
        return JSONResponse({"error": "unknown symbol"}, status_code=400)
    s = app.state.app_state
    s.symbol = sym
    await app.state.conn_mgr.reconnect_all()
    await hub.broadcast({"type": "symbol_change", "symbol": sym})
    return {"ok": True, "symbol": sym}

@app.post("/api/timeframe")
async def set_timeframe(req: TimeframeRequest):
    valid = ("1m", "3m", "5m", "15m", "1h", "4h")
    if req.tf not in valid:
        return JSONResponse({"error": "unknown timeframe"}, status_code=400)
    s = app.state.app_state
    s.timeframe = req.tf
    s.candles = []
    s.liq_bars = []
    s.delta_bars = []
    await app.state.conn_mgr.reconnect_all()
    await hub.broadcast({"type": "tf_change", "tf": req.tf})
    return {"ok": True, "tf": req.tf}

# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await hub.connect(ws)
    # Send initial state snapshot
    s = app.state.app_state
    await ws.send_text(json.dumps({"type": "state_snapshot", **s.to_dict()}))
    try:
        while True:
            # Keep alive — we only push, but read to detect disconnects
            data = await asyncio.wait_for(ws.receive_text(), timeout=30)
            # Handle ping
            if data == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    finally:
        hub.disconnect(ws)

# ---------------------------------------------------------------------------
# Static frontend (production build)
# ---------------------------------------------------------------------------
_STATIC = Path(__file__).parent.parent / "frontend" / "dist"
if _STATIC.exists():
    app.mount("/", StaticFiles(directory=str(_STATIC), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8743,
        log_level="info",
        reload=False,
    )
