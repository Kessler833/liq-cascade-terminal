"""Cascade Impact recorder — with SQLite persistence.

Records per-cascade observations: entry price, liq volume, predicted vs actual
terminal price, delta series, price series, and liq-remaining tank.

DB changes vs. original (all marked  # DB):
  - imports json + db.database
  - _obs_to_db_row() / _db_row_to_obs()  serialise / deserialise
  - _persist_obs()    fire-and-forget INSERT OR REPLACE on cascade close
  - load_from_db()    called by ConnectionManager on startup to restore history
"""
from __future__ import annotations

import asyncio
import json                                   # DB
import logging
import random
import string
import time
from typing import TYPE_CHECKING, Callable, Awaitable

if TYPE_CHECKING:
    from engine.state import AppState
    from engine.l2_model import L2Model

import db.database as _db                    # DB

log = logging.getLogger("liqterm.impact")

SILENCE_WINDOW_S = 30.0
# FIX: lowered from 100_000 to 1_000 to match strategy.py MIN_LIQ_USD.
# The previous 100k threshold silently dropped all liquidations below $100k,
# meaning smaller cascades on lower-cap assets (SUI, LINK, DOGE) were never
# recorded as impact observations. 1k aligns with the feed/stats threshold.
MIN_LIQ_USD      = 1_000
TICK_INTERVAL_S  = 0.2

_INSERT_SQL = """
INSERT OR REPLACE INTO cascade_observations (
    obs_id, asset, timestamp, entry_price, side, exchange,
    cascade_size, initial_liq_volume, initial_delta, initial_expected_price,
    total_liq_volume, liq_remaining, last_liq_ts,
    final_expected_price, actual_terminal_price, price_error_pct,
    cascade_duration_s, absorbed_by_delta,
    delta_series, expected_price_series, price_series,
    liq_remaining_series, cascade_events_json, label_filled
) VALUES (
    :obs_id, :asset, :timestamp, :entry_price, :side, :exchange,
    :cascade_size, :initial_liq_volume, :initial_delta, :initial_expected_price,
    :total_liq_volume, :liq_remaining, :last_liq_ts,
    :final_expected_price, :actual_terminal_price, :price_error_pct,
    :cascade_duration_s, :absorbed_by_delta,
    :delta_series, :expected_price_series, :price_series,
    :liq_remaining_series, :cascade_events_json, :label_filled
)
"""                                           # DB


def _gen_id() -> str:
    ts   = int(time.time() * 1000)
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
    return f"{ts:x}{rand}"


# ---------------------------------------------------------------------------
# DB helpers                                                              # DB
# ---------------------------------------------------------------------------

def _jdump(val) -> str | None:               # DB
    return json.dumps(val) if val else None


def _jload(val) -> list:                     # DB
    return json.loads(val) if val else []


def _obs_to_db_row(obs: dict) -> dict:       # DB
    return {
        "obs_id":                 obs["id"],
        "asset":                  obs["asset"],
        "timestamp":              obs["timestamp"],
        "entry_price":            obs["entry_price"],
        "side":                   obs["side"],
        "exchange":               obs["exchange"],
        "cascade_size":           obs["cascade_size"],
        "initial_liq_volume":     obs["initial_liq_volume"],
        "initial_delta":          obs.get("initial_delta"),
        "initial_expected_price": obs.get("initial_expected_price"),
        "total_liq_volume":       obs.get("total_liq_volume"),
        "liq_remaining":          obs.get("liq_remaining", 0.0),
        "last_liq_ts":            obs.get("last_liq_ts"),
        "final_expected_price":   obs.get("final_expected_price"),
        "actual_terminal_price":  obs.get("actual_terminal_price"),
        "price_error_pct":        obs.get("price_error_pct"),
        "cascade_duration_s":     obs.get("cascade_duration_s"),
        "absorbed_by_delta":      int(bool(obs.get("absorbed_by_delta", False))),
        "delta_series":           _jdump(obs.get("delta_series")),
        "expected_price_series":  _jdump(obs.get("expected_price_series")),
        "price_series":           _jdump(obs.get("price_series")),
        "liq_remaining_series":   _jdump(obs.get("liq_remaining_series")),
        "cascade_events_json":    _jdump(obs.get("cascade_events")),
        "label_filled":           obs.get("label_filled", 1),
    }


def _db_row_to_obs(row: dict) -> dict:       # DB
    """Reconstruct an in-memory observation dict from a DB row."""
    return {
        "id":                     row["obs_id"],
        "asset":                  row["asset"],
        "timestamp":              row["timestamp"],
        "entry_price":            row["entry_price"],
        "side":                   row["side"],
        "exchange":               row["exchange"],
        "cascade_size":           row.get("cascade_size", 1),
        "initial_liq_volume":     row.get("initial_liq_volume", 0.0),
        "initial_delta":          row.get("initial_delta"),
        "initial_expected_price": row.get("initial_expected_price"),
        "total_liq_volume":       row.get("total_liq_volume", 0.0),
        "liq_remaining":          row.get("liq_remaining", 0.0),
        "last_liq_ts":            row.get("last_liq_ts") or row["timestamp"],
        "final_expected_price":   row.get("final_expected_price"),
        "actual_terminal_price":  row.get("actual_terminal_price"),
        "price_error_pct":        row.get("price_error_pct"),
        "cascade_duration_s":     row.get("cascade_duration_s"),
        "absorbed_by_delta":      bool(row.get("absorbed_by_delta", 0)),
        "delta_series":           _jload(row.get("delta_series")),
        "expected_price_series":  _jload(row.get("expected_price_series")),
        "price_series":           _jload(row.get("price_series")),
        "liq_remaining_series":   _jload(row.get("liq_remaining_series")),
        "cascade_events":         _jload(row.get("cascade_events_json")),
        "label_filled":           row.get("label_filled", 1),
        # Cutoff fields: not stored in DB (stale after restart anyway)
        "beyond_cutoff":          False,
        "cutoff_price":           None,
    }


# ---------------------------------------------------------------------------
# ImpactRecorder
# ---------------------------------------------------------------------------

class ImpactRecorder:
    def __init__(
        self,
        app_state: "AppState",
        l2_model: "L2Model",
        broadcast: Callable[[dict], Awaitable[None]],
    ):
        self._s = app_state
        self._l2 = l2_model
        self._broadcast = broadcast
        self.observations: list[dict] = []   # completed, newest first
        self.active: dict[str, dict] = {}    # sym -> in-progress obs
        self._tick_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # DB: restore completed observations from disk on startup          # DB
    # ------------------------------------------------------------------
    async def load_from_db(self, limit: int = 200) -> None:            # DB
        try:
            rows = await _db.fetchall(
                "SELECT * FROM cascade_observations "
                "WHERE label_filled = 1 "
                "ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            )
        except Exception as exc:
            log.warning("load_from_db failed (DB not ready?): %s", exc)
            return
        self.observations = [_db_row_to_obs(r) for r in rows]
        log.info("Loaded %d observations from DB", len(self.observations))

    # ------------------------------------------------------------------
    # DB: persist a closed observation (fire-and-forget)               # DB
    # ------------------------------------------------------------------
    def _persist_obs(self, obs: dict) -> None:                         # DB
        _db.execute_nonblocking(_INSERT_SQL, _obs_to_db_row(obs))

    # ------------------------------------------------------------------
    async def on_liquidation(self, exchange: str, side: str, usd_val: float, price: float):
        if usd_val < MIN_LIQ_USD:
            return
        sym    = self._s.symbol
        now    = time.time()
        active = self.active.get(sym)

        if active and now - active["last_liq_ts"] < SILENCE_WINDOW_S:
            # Extend existing cascade — no await, no suspension point.
            active["cascade_size"]     += 1
            active["total_liq_volume"] += usd_val
            active["last_liq_ts"]       = now
            active["liq_remaining"]    += usd_val
            active["cascade_events"].append([now, usd_val, exchange])
        else:
            # FIX: _tick_task singleton race — task created BEFORE any await.
            if self._tick_task is None or self._tick_task.done():
                self._tick_task = asyncio.create_task(self._tick_loop())

            if active:
                await self._close_obs(sym)

            res = self._l2.compute_terminal_price(usd_val, self._s.cumulative_delta, side)
            obs = {
                "id":                    _gen_id(),
                "asset":                 sym,
                "timestamp":             now,
                "entry_price":           price,
                "side":                  side,
                "exchange":              exchange,
                "cascade_size":          1,
                "initial_liq_volume":    usd_val,
                "initial_delta":         self._s.cumulative_delta,
                "initial_expected_price": res["terminal_price"],
                "total_liq_volume":      usd_val,
                "liq_remaining":         usd_val,
                "last_liq_ts":           now,
                "delta_series":          [],
                "expected_price_series": [],
                "price_series":          [],
                "liq_remaining_series":  [],
                # cutoff tracking (updated every tick)
                "beyond_cutoff":         res["beyond_cutoff"],
                "cutoff_price":          res["cutoff_price"],
                "cascade_events":        [[now, usd_val, exchange]],
                "final_expected_price":  None,
                "actual_terminal_price": None,
                "price_error_pct":       None,
                "cascade_duration_s":    None,
                "absorbed_by_delta":     False,
                "label_filled":          0,
            }
            self.active[sym] = obs

        await self._broadcast_table_update()

    # ------------------------------------------------------------------
    async def _tick_loop(self):
        while True:
            await asyncio.sleep(TICK_INTERVAL_S)
            if not self.active:
                break
            await self._tick_all()
        self._tick_task = None

    async def _tick_all(self):
        now      = time.time()
        to_close = []
        for sym, obs in list(self.active.items()):
            obs["liq_remaining"] = max(0, obs["liq_remaining"] * 0.97)
            res = self._l2.compute_terminal_price(
                obs["liq_remaining"], self._s.cumulative_delta, obs["side"]
            )
            obs["delta_series"].append([now, self._s.cumulative_delta])
            obs["expected_price_series"].append([now, res["terminal_price"]])
            obs["price_series"].append([now, self._s.price])
            obs["liq_remaining_series"].append([now, obs["liq_remaining"]])

            # Track cutoff: once beyond_cutoff is True it stays True for the
            # life of the observation (pressure only decreases, so if we crossed
            # the cutoff line we never come back within it on this cascade).
            if res["beyond_cutoff"]:
                obs["beyond_cutoff"] = True
            # Always update cutoff_price in case the book was refreshed
            if res["cutoff_price"] is not None:
                obs["cutoff_price"] = res["cutoff_price"]

            if res["absorbed"]:
                obs["absorbed_by_delta"] = True
            silence_expired = now - obs["last_liq_ts"] > SILENCE_WINDOW_S
            tank_dry        = obs["liq_remaining"] < obs["initial_liq_volume"] * 0.02
            if silence_expired or tank_dry:
                to_close.append(sym)
        for sym in to_close:
            await self._close_obs(sym)

    async def _close_obs(self, sym: str):
        obs = self.active.pop(sym, None)
        if obs is None:
            return
        obs["label_filled"] = 1
        obs["final_expected_price"] = (
            obs["expected_price_series"][-1][1]
            if obs["expected_price_series"]
            else obs["initial_expected_price"]
        )
        obs["actual_terminal_price"] = self._s.price
        if obs["entry_price"]:
            obs["price_error_pct"] = (
                (obs["actual_terminal_price"] - obs["final_expected_price"])
                / obs["entry_price"] * 100
            )
        events = obs["cascade_events"]
        obs["cascade_duration_s"] = (
            (events[-1][0] - events[0][0]) if len(events) > 1 else 0.0
        )
        self.observations.insert(0, obs)
        self._persist_obs(obs)           # DB: fire-and-forget write to SQLite
        await self._broadcast_table_update()

    # ------------------------------------------------------------------
    def get_all(self) -> list[dict]:
        return list(self.active.values()) + self.observations

    def to_serialisable(self, obs: dict) -> dict:
        """Convert float timestamps to ms ints for JSON transport."""
        def ts(t: float) -> int:
            return int(t * 1000)
        return {
            **obs,
            "timestamp":             ts(obs["timestamp"]),
            "last_liq_ts":           ts(obs["last_liq_ts"]),
            "delta_series":          [[ts(t), v] for t, v in obs["delta_series"]],
            "expected_price_series": [[ts(t), v] for t, v in obs["expected_price_series"]],
            "price_series":          [[ts(t), v] for t, v in obs["price_series"]],
            "liq_remaining_series":  [[ts(t), v] for t, v in obs["liq_remaining_series"]],
            "cascade_events":        [[ts(t), v, ex] for t, v, ex in obs["cascade_events"]],
            # cutoff fields passed through as-is (bool + float|None)
            "beyond_cutoff":         obs.get("beyond_cutoff", False),
            "cutoff_price":          obs.get("cutoff_price"),
        }

    async def _broadcast_table_update(self):
        all_obs = self.get_all()
        await self._broadcast({
            "type":         "impact_update",
            "observations": [self.to_serialisable(o) for o in all_obs[:50]],
            "stats":        self._calc_stats(all_obs),
        })

    def _calc_stats(self, all_obs: list[dict]) -> dict:
        recording = [o for o in all_obs if o["label_filled"] == 0]
        complete  = [o for o in all_obs if o["label_filled"] == 1]
        absorbed  = [o for o in complete if o["absorbed_by_delta"]]
        errors    = [o for o in complete if o["price_error_pct"] is not None]
        avg_err   = (
            sum(abs(o["price_error_pct"]) for o in errors) / len(errors)
            if errors else None
        )
        return {
            "total":     len(all_obs),
            "recording": len(recording),
            "avg_err":   avg_err,
            "absorbed":  len(absorbed),
        }
