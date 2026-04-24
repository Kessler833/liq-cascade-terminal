"""Background labeling loop.

Every 30 s it scans for observations whose label window has closed
and computes peak return, time-to-peak, and an optimal Sharpe from
the stored price_ticks.

30-min window  → label_filled = 1   (sets 30m fields)
60-min window  → label_filled = 1   (upgrades to 60m fields, keeps 30m)
Expiry (90 min passed, < 60 recorded ticks) → label_filled = 2
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time

from . import db

log = logging.getLogger("lct.labeler")

WINDOW_30M  = 30 * 60      # seconds
WINDOW_60M  = 60 * 60
EXPIRY      = 90 * 60      # expire if still unlabeled after 90 min
MIN_TICKS   = 10           # need at least this many ticks to label


def _optimal_sharpe(returns: list[float], horizon_s: float) -> float:
    """Simple Sharpe proxy: mean return / std over the path."""
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    std = math.sqrt(variance) if variance > 0 else 1e-9
    # annualise relative to horizon
    ann_factor = math.sqrt(max(horizon_s / 3600, 1e-6))
    return (mean / std) * ann_factor


async def _label_one(obs: dict, now: float) -> None:
    obs_id     = obs["obs_id"]
    asset      = obs["asset"]
    entry_ts   = obs["timestamp"]
    entry_px   = obs["price"]
    side       = obs["side"]   # 'LONG' or 'SHORT'
    direction  = 1 if side == "LONG" else -1

    age = now - entry_ts

    # Fetch all price ticks from entry up to now
    ticks = await db.fetchall(
        "SELECT timestamp, price FROM price_ticks "
        "WHERE asset=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp ASC",
        (asset, entry_ts, now),
    )

    if len(ticks) < MIN_TICKS:
        if age > EXPIRY:
            await db.execute(
                "UPDATE observations SET label_filled=2 WHERE obs_id=?",
                (obs_id,),
            )
        return

    # Build return path as dict {offset_s: return_pct}
    path: dict[str, float] = {}
    for t in ticks:
        offset_s = round(t["timestamp"] - entry_ts)
        ret_pct  = direction * (t["price"] - entry_px) / entry_px * 100
        path[str(offset_s)] = round(ret_pct, 4)

    returns_30m = [v for k, v in path.items() if int(k) <= WINDOW_30M]
    returns_60m = [v for k, v in path.items() if int(k) <= WINDOW_60M]

    def _calc_window(returns: list[float], window_s: float):
        if not returns:
            return None, None, None
        peak  = max(returns)
        tpeak = None
        for t_tick in ticks:
            offset_s = t_tick["timestamp"] - entry_ts
            ret_pct  = direction * (t_tick["price"] - entry_px) / entry_px * 100
            if abs(ret_pct - peak) < 0.0001:
                tpeak = offset_s
                break
        sharpe = _optimal_sharpe(returns, window_s)
        return round(peak, 4), round(tpeak, 1) if tpeak else None, round(sharpe, 4)

    has_30m = age >= WINDOW_30M and len(returns_30m) >= MIN_TICKS
    has_60m = age >= WINDOW_60M and len(returns_60m) >= MIN_TICKS

    if not has_30m:
        return  # not ready yet

    peak30, tp30, sh30 = _calc_window(returns_30m, WINDOW_30M)
    peak60, tp60, sh60 = (None, None, None)
    if has_60m:
        peak60, tp60, sh60 = _calc_window(returns_60m, WINDOW_60M)

    net_2m_returns = [v for k, v in path.items() if int(k) <= 120]
    net_2m = round(net_2m_returns[-1], 4) if net_2m_returns else None

    path_json = json.dumps(path)

    await db.execute(
        """
        UPDATE observations SET
            price_path_json     = ?,
            peak_return_30m_pct = ?,
            time_to_peak_30m_s  = ?,
            optimal_sharpe_30m  = ?,
            peak_return_60m_pct = ?,
            time_to_peak_60m_s  = ?,
            optimal_sharpe_60m  = ?,
            net_return_2m_pct   = ?,
            label_filled        = 1
        WHERE obs_id = ?
        """,
        (path_json, peak30, tp30, sh30,
         peak60, tp60, sh60,
         net_2m, obs_id),
    )
    log.debug("Labeled %s  30m_sharpe=%.3f  60m_sharpe=%s", obs_id, sh30 or 0, sh60)


async def run_labeler_loop() -> None:
    log.info("Labeler loop started")
    while True:
        await asyncio.sleep(30)
        try:
            now     = time.time()
            pending = await db.fetchall(
                "SELECT obs_id, asset, timestamp, price, side "
                "FROM observations WHERE label_filled=0"
            )
            for obs in pending:
                await _label_one(obs, now)
        except Exception as exc:
            log.exception("Labeler error: %s", exc)
