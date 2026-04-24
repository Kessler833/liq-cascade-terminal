# Liq Cascade Terminal

Multi-exchange liquidation cascade dashboard — real-time BTC/ETH/SOL liquidation monitoring, delta-volume analysis, cascade detection, and price-impact modelling.

## Architecture

```
liq-cascade-terminal/
├── backend/          ← FastAPI + Python WebSocket aggregator
│   ├── main.py       ← Uvicorn entry point (port 8743)
│   ├── engine/       ← Core logic: connections, strategy, impact, L2 model
│   └── requirements.txt
├── frontend/         ← Vite + TypeScript SPA
│   └── src/          ← state, api, charts, ui, utils
└── scripts/
    └── start.bat
```

## Quick Start

### Backend
```bash
cd backend
pip install -r requirements.txt
python main.py
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Or just run `start.bat` from the root to launch both.

## Data Flow

```
Binance ──┐
Bybit  ──┤
OKX    ──┤──► backend engine ──► /ws  ──► frontend
Bitget ──┤          │
Gate   ──┤          └──► /api/state, /api/candles
dYdX   ──┘
```

The backend owns all 6 exchange WebSocket connections. The frontend receives a **single normalized event stream** — no direct exchange connections from the browser.

## API

| Endpoint | Description |
|---|---|
| `GET /health` | Uptime check |
| `GET /api/state` | Current symbol, phase, price, stats |
| `GET /api/candles?sym=BTC&tf=5m` | Historical + live candle array |
| `POST /api/symbol` | Switch active symbol (`{"symbol": "ETH"}`) |
| `POST /api/timeframe` | Switch active timeframe (`{"tf": "15m"}`) |
| `WS /ws` | Normalized event stream |

## WS Event Types

| type | Fields |
|---|---|
| `liq` | `exchange, side, usdVal, price, symbol` |
| `kline` | `t, o, h, l, c, v, closed` |
| `delta` | `cumDelta, barDelta, ts` |
| `phase` | `phase, text, price` |
| `stats` | Full state snapshot |
