"""FastAPI router for observations endpoints."""
from __future__ import annotations

import csv
import io
import json
import math
import time
import uuid

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import db

router = APIRouter()

PAGE_SIZE = 30


# ── POST  /observations ──────────────────────────────────────────────────────

class ObservationIn(BaseModel):
    asset:              str
    side:               str          # 'LONG' | 'SHORT'
    price:              float
    cascade_score:      float | None = None
    cascade_threshold:  float | None = None
    liq_1m_usd:         float | None = None
    cumulative_delta:   float | None = None
    exchanges:          dict  | None = None


@router.post("/observations", status_code=201)
async def create_observation(body: ObservationIn):
    obs_id = str(uuid.uuid4())
    exch   = body.exchanges or {}

    def _g(name, side_):
        return exch.get(name, {}).get(side_, 0.0)

    cascade_pct = None
    if body.cascade_score is not None and body.cascade_threshold:
        cascade_pct = round(body.cascade_score / body.cascade_threshold * 100, 2)

    await db.execute(
        """
        INSERT INTO observations (
            obs_id, asset, timestamp, side, price,
            cascade_score, cascade_threshold, cascade_pct,
            liq_1m_usd, cumulative_delta,
            bnce_long,  bnce_short,
            bybt_long,  bybt_short,
            okx_long,   okx_short,
            bget_long,  bget_short,
            gate_long,  gate_short,
            dydx_long,  dydx_short,
            label_filled
        ) VALUES (
            ?,?,?,?,?,
            ?,?,?,
            ?,?,
            ?,?,?,?,?,?,?,?,?,?,?,?,
            0
        )
        """,
        (
            obs_id, body.asset, time.time(), body.side, body.price,
            body.cascade_score, body.cascade_threshold, cascade_pct,
            body.liq_1m_usd, body.cumulative_delta,
            _g("binance", "long"),  _g("binance", "short"),
            _g("bybit",   "long"),  _g("bybit",   "short"),
            _g("okx",     "long"),  _g("okx",     "short"),
            _g("bitget",  "long"),  _g("bitget",  "short"),
            _g("gate",    "long"),  _g("gate",    "short"),
            _g("dydx",    "long"),  _g("dydx",    "short"),
        ),
    )
    return {"obs_id": obs_id}


# ── POST  /price_tick ─────────────────────────────────────────────────────────

class PriceTick(BaseModel):
    asset: str
    price: float


@router.post("/price_tick", status_code=204)
async def ingest_price(body: PriceTick):
    await db.execute_nonblocking(
        "INSERT INTO price_ticks (asset, timestamp, price) VALUES (?,?,?)",
        (body.asset, time.time(), body.price),
    )


# ── GET   /observations ───────────────────────────────────────────────────────

@router.get("/observations")
async def list_observations(
    asset:   str | None = Query(None),
    side:    str | None = Query(None),
    labeled: int | None = Query(None),   # 0=pending 1=labeled 2=expired
    limit:   int        = Query(PAGE_SIZE, ge=1, le=200),
    offset:  int        = Query(0, ge=0),
):
    conds, params = [], []
    if asset:
        conds.append("asset=?")
        params.append(asset)
    if side:
        conds.append("side=?")
        params.append(side.upper())
    if labeled is not None:
        conds.append("label_filled=?")
        params.append(labeled)

    where = ("WHERE " + " AND ".join(conds)) if conds else ""

    count_row = await db.fetchone(
        f"SELECT COUNT(*) as cnt FROM observations {where}", tuple(params)
    )
    total = count_row["cnt"] if count_row else 0

    rows = await db.fetchall(
        f"""
        SELECT obs_id, asset, timestamp, side, price,
               cascade_pct, liq_1m_usd, cumulative_delta,
               optimal_sharpe_30m, optimal_sharpe_60m,
               peak_return_60m_pct, time_to_peak_60m_s,
               peak_return_30m_pct, time_to_peak_30m_s,
               net_return_2m_pct, label_filled
        FROM observations {where}
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
        """,
        tuple(params) + (limit, offset),
    )
    return {"total": total, "rows": rows}


# ── GET   /observations/count ─────────────────────────────────────────────────

@router.get("/observations/count")
async def obs_count():
    rows = await db.fetchall(
        "SELECT label_filled, COUNT(*) as cnt FROM observations GROUP BY label_filled"
    )
    result = {"total": 0, "recording": 0, "labeled": 0, "expired": 0}
    for r in rows:
        lf  = r["label_filled"]
        cnt = r["cnt"]
        result["total"] += cnt
        if lf == 0:
            result["recording"] = cnt
        elif lf == 1:
            result["labeled"] = cnt
        elif lf == 2:
            result["expired"] = cnt
    return result


# ── GET   /observations/distribution ──────────────────────────────────────────

@router.get("/observations/distribution")
async def sharpe_distribution():
    rows = await db.fetchall(
        "SELECT optimal_sharpe_60m, optimal_sharpe_30m "
        "FROM observations WHERE label_filled=1"
    )
    values = []
    for r in rows:
        v = r["optimal_sharpe_60m"] if r["optimal_sharpe_60m"] is not None else r["optimal_sharpe_30m"]
        if v is not None:
            values.append(v)

    if not values:
        return {"bins": [], "mean": None, "median": None, "std": None, "positive_rate": None}

    # 20 equal-width bins
    lo, hi   = min(values), max(values)
    span     = (hi - lo) or 1.0
    BIN_W    = span / 20
    bin_counts: dict[float, int] = {}
    for v in values:
        b = lo + math.floor((v - lo) / BIN_W) * BIN_W
        b = round(b, 4)
        bin_counts[b] = bin_counts.get(b, 0) + 1

    bins = [{"x": k, "count": v} for k, v in sorted(bin_counts.items())]

    n    = len(values)
    mean = sum(values) / n
    srt  = sorted(values)
    median = srt[n // 2] if n % 2 else (srt[n // 2 - 1] + srt[n // 2]) / 2
    std  = math.sqrt(sum((v - mean) ** 2 for v in values) / n)
    pos  = sum(1 for v in values if v >= 0.25) / n

    return {
        "bins":          bins,
        "mean":          round(mean,   4),
        "median":        round(median, 4),
        "std":           round(std,    4),
        "positive_rate": round(pos,    4),
    }


# ── GET   /observations/{obs_id} ──────────────────────────────────────────────

@router.get("/observations/{obs_id}")
async def get_observation(obs_id: str):
    row = await db.fetchone(
        "SELECT * FROM observations WHERE obs_id=?", (obs_id,)
    )
    if not row:
        raise HTTPException(404, "Not found")
    return row


# ── GET   /observations/export ────────────────────────────────────────────────

@router.get("/observations/export")
async def export_csv():
    rows = await db.fetchall(
        "SELECT * FROM observations ORDER BY timestamp DESC"
    )
    if not rows:
        raise HTTPException(404, "No observations")

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=lct_observations.csv"},
    )
