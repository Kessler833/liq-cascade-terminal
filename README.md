# Liq Cascade Terminal

Real-time multi-exchange liquidation cascade monitor with delta tracking, impact recording, and signal detection.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Vite + TypeScript + lightweight-charts)        │
│  localhost:5173                                          │
└────────────────────┬────────────────────────────────────┘
                     │  WS /ws  +  REST /api/*
┌────────────────────▼────────────────────────────────────┐
│  FastAPI backend  (uvicorn)   localhost:8000             │
│  ┌──────────────────────────────────────────────────┐   │
│  │  ConnectionManager                               │   │
│  │  ├─ Binance WS  (liq + kline + aggTrade)         │   │
│  │  ├─ Bybit WS    (liq + trade)                    │   │
│  │  ├─ OKX WS      (liq + trade)                    │   │
│  │  ├─ Bitget WS   (liq + trade)                    │   │
│  │  ├─ Gate WS     (liq + trade)                    │   │
│  │  └─ dYdX WS     (trade / liq heuristic)          │   │
│  ├─ Strategy   (cascade detect, delta, phase FSM)   │   │
│  ├─ ImpactRecorder (per-cascade obs + L2 model)     │   │
│  └─ BroadcastHub  (fan-out to all WS clients)       │   │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### Windows
```bat
scripts\start-all.bat
```

### macOS / Linux
```bash
chmod +x scripts/start-all.sh
./scripts/start-all.sh
```

Open **http://localhost:5173** in your browser.

## Manual Start

**Backend**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

**Frontend**
```bash
cd frontend
npm install
npm run dev
```

## REST API

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/healthz` | — | Liveness probe |
| GET | `/api/state` | — | Full state snapshot |
| GET | `/api/candles?sym=BTC&tf=5m` | — | Candle + liq + delta bars |
| GET | `/api/impact` | — | Impact observations |
| POST | `/api/symbol` | `{"symbol":"ETH"}` | Hot-swap symbol |
| POST | `/api/timeframe` | `{"timeframe":"1h"}` | Hot-swap timeframe |

## WebSocket Events

All events are JSON on `ws://localhost:8000/ws`.

| `type` | Description |
|--------|-------------|
| `snapshot` | Full state on connect |
| `kline` | Candle update (live + closed) |
| `liq` | Liquidation event + updated stats |
| `delta` | Cumulative delta update |
| `phase` | Phase transition (waiting/watching/cascade/long/short) |
| `cascade_meter` | Cascade fill % |
| `history` | Full candle reload after symbol/TF change |
| `impact_update` | Impact observation table update |
| `conn_status` | Per-exchange WS status dot |

## Supported Assets

BTC · ETH · SOL · XRP · DOGE · AVAX · LINK · SUI

## Supported Exchanges

Binance Futures · Bybit · OKX · Bitget · Gate · dYdX

## Project Structure

```
liq-cascade-terminal/
├── backend/
│   ├── main.py              FastAPI app + BroadcastHub
│   ├── requirements.txt
│   ├── start.sh / start.bat
│   └── engine/
│       ├── state.py         AppState + all constants
│       ├── connections.py   6 exchange WS connectors
│       ├── strategy.py      Cascade FSM + delta tracking
│       ├── impact.py        Per-cascade impact recorder
│       └── l2_model.py      Order-book terminal price model
├── frontend/
│   ├── index.html
│   ├── package.json         Vite + TypeScript
│   ├── vite.config.ts       Proxy /api + /ws → backend
│   └── src/
│       ├── main.ts          WS message router
│       ├── state.ts         Typed client state
│       ├── api.ts           WS client + REST helpers
│       ├── charts.ts        lightweight-charts panels
│       ├── ui.ts            DOM updaters
│       ├── utils.ts         Formatters
│       └── style.css        Dark terminal theme
└── scripts/
    ├── start-all.bat
    └── start-all.sh
```
