"""Cascade Impact recorder — with SQLite persistence.

Algorithm
---------
Two completely separate components:

1. Tank (liq_remaining)
   Updated every 200ms tick using real per-tick market flow:
       liq_remaining = max(0, liq_remaining - direction * delta_tick)
   delta_tick = increment of net buy/sell flow in this 200ms window only.
   Long liq: positive delta_tick (net buying) drains the tank.
   Short liq: negative delta_tick (net selling) drains the tank.
   Amplifying flow (same direction as forced flow) refills the tank.
   The bucket walk NEVER modifies liq_remaining.

   delta_tick is derived from sym_impact_delta, which is a monotonically
   accumulating counter that never resets. This prevents phantom tank
   inflation at second boundaries that would occur with sym_snapshot_delta.

   If a new liquidation arrives within the silence window, the tank is
   refilled: liq_remaining += new_usd_val. The tank_empty markers are
   reset so they get re-recorded at the next true depletion.

2. Bucket walk (read-only prediction)
   Given the current liq_remaining, walks L2 buckets to predict the
   terminal price. Changes no state whatsoever.

Key field definitions
---------------------
entry_price             — price when the first liquidation fired (START)
initial_expected_price  — first bucket walk prediction when liq fires
final_expected_price    — bucket walk prediction at the exact tick
                          liq_remaining first hits zero
tank_empty_ts           — wall-clock timestamp when liq_remaining → 0
tank_empty_price        — real market price at that moment (END)
price_difference        — tank_empty_price - entry_price (actual move)
cascade_duration_s      — tank_empty_ts - obs.timestamp
price_error_pct         — how far off the initial prediction was relative to
                          the actual predicted move size:
                          (initial_expected - final_expected)
                          / (final_expected - entry_price) * 100
                          0% = perfect prediction, 20% = off by one fifth, etc.
absorbed_by_delta       — the market instantly ate the liq: counter-flow in
                          the very first tick alone >= initial_liq_volume,
                          AND cascade_size == 1 (refilled cascades are never
                          absorbed — they survived long enough to attract more
                          liquidations).

Observation closes only on silence_expired (30s no new liq).
Tank hitting zero does NOT close — a new cluster may refill it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import string
import time
from typing import TYPE_CHECKING, Callable, Awaitable

if TYPE_CHECKING:
    from engine.state import AppState
    from engine.l2_model import L2Model

import db.database as _db

log = logging.getLogger("liqterm.impact")

SILENCE_WINDOW_S = 30.0
MIN_LIQ_USD      = 1_000
TICK_INTERVAL_S  = 0.2

_INSERT_SQL = """
INSERT OR REPLACE INTO cascade_observations (
    obs_id, asset, timestamp, entry_price, side, exchange,
    cascade_size, initial_liq_volume, initial_delta, initial_expected_price,
    total_liq_volume, liq_remaining, last_liq_ts,
    final_expected_price, tank_empty_ts, tank_empty_price, price_difference,
    actual_terminal_price, price_error_pct,
    cascade_duration_s, absorbed_by_delta,
    delta_series, expected_price_series, price_series,
    liq_remaining_series, cascade_events_json, label_filled
) VALUES (
    :obs_id, :asset, :timestamp, :entry_price, :side, :exchange,
    :cascade_size, :initial_liq_volume, :initial_delta, :initial_expected_price,
    :total_liq_volume, :liq_remaining, :last_liq_ts,
    :final_expected_price, :tank_empty_ts, :tank_empty_price, :price_difference,
    :actual_terminal_price, :price_error_pct,
    :cascade_duration_s, :absorbed_by_delta,
    :delta_series, :expected_price_series, :price_series,
    :liq_remaining_series, :cascade_events_json, :label_filled
)
"""


def _gen_id() -> str:
    ts   = int(time.time() * 1000)
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
    return f"{ts:x}{rand}"


def _jdump(val) -> str | None:
    return json.dumps(val) if val else None


def _jload(val) -> list:
    return json.loads(val) if val else []


def _price_error(initial_expected: float, final_expected: float, entry_price: float) -> float | None:
    """How far off the initial prediction was, as a fraction of the actual predicted move.

    Formula: (initial_expected - final_expected) / (final_expected - entry_price) * 100

    0%  = model nailed it (initial == final prediction)
    20% = initial was off by one fifth of the actual move size

    Returns None if the predicted move is zero (flat/no-move prediction).
    """
    move = final_expected - entry_price
    if move == 0.0:
        return None
    return (initial_expected - final_expected) / move * 100


def _is_absorbed(side: str, cascade_size: int, initial_liq_volume: float, delta_series: list) -> bool:
    """True if the market instantly ate the liq in the very first tick.

    Conditions (all must be true):
      1. cascade_size == 1: refilled cascades survived long enough to attract
         more liquidations, so they were never instantly absorbed.
      2. First delta tick was counter-flow (opposite to the forced direction).
      3. That single tick's counter-flow magnitude >= initial_liq_volume.

    Sign convention (matches _tick_all tank drain):
      Long liq (direction=+1): positive delta_tick is counter-flow (net buying
        absorbs forced selling). counter_flow = +1 * positive_delta > 0. ✓
      Short liq (direction=-1): negative delta_tick is counter-flow (net selling
        absorbs forced buying). counter_flow = -1 * negative_delta > 0. ✓
    """
    if cascade_size > 1:
        return False
    if not delta_series:
        return False
    first_delta_tick = delta_series[0][1]
    direction = 1.0 if side == "long" else -1.0
    # No negation: direction * delta_tick is positive when flow opposes forced order.
    counter_flow = direction * first_delta_tick
    return counter_flow >= initial_liq_volume


def _obs_to_db_row(obs: dict) -> dict:
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
        "tank_empty_ts":          obs.get("tank_empty_ts"),
        "tank_empty_price":       obs.get("tank_empty_price"),
        "price_difference":       obs.get("price_difference"),
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


def _db_row_to_obs(row: dict) -> dict:
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
        "tank_empty_ts":          row.get("tank_empty_ts"),
        "tank_empty_price":       row.get("tank_empty_price"),
        "price_difference":       row.get("price_difference"),
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
        "beyond_cutoff":          False,
        "cutoff_price":           None,
        "_last_delta":            0.0,
    }


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
        self.observations: list[dict] = []
        self.active: dict[str, dict] = {}
        self._tick_task: asyncio.Task | None = None

    async def load_from_db(self, limit: int = 200) -> None:
        try:
            rows = await _db.fetchall(
                "SELECT * FROM cascade_observations "
                "WHERE label_filled = 1 "
                "ORDER BY timestamp DESC LIMIT ?",
                (limit,),
            )
        except Exception as exc:
            log.warning("load_from_db failed: %s", exc)
            return
        self.observations = [_db_row_to_obs(r) for r in rows]
        log.info("Loaded %d observations from DB", len(self.observations))

    def _persist_obs(self, obs: dict) -> None:
        _db.execute_nonblocking(_INSERT_SQL, _obs_to_db_row(obs))

    async def delete_observations(self, ids: list[str]) -> int:
        if not ids:
            return 0
        id_set = set(ids)
        before = len(self.observations)
        self.observations = [o for o in self.observations if o["id"] not in id_set]
        removed = before - len(self.observations)
        for sym in list(self.active):
            if self.active[sym]["id"] in id_set:
                del self.active[sym]
                removed += 1
        if ids:
            placeholders = ",".join("?" * len(ids))
            await _db.execute(
                f"DELETE FROM cascade_observations WHERE obs_id IN ({placeholders})",
                tuple(ids),
            )
        if removed:
            await self._broadcast_table_update()
        return removed

    async def on_liquidation(
        self,
        exchange: str,
        side: str,
        usd_val: float,
        price: float,
        sym: str | None = None,
    ):
        if usd_val < MIN_LIQ_USD:
            return
        if sym is None:
            sym = self._s.symbol
        now    = time.time()
        active = self.active.get(sym)

        if active and now - active["last_liq_ts"] < SILENCE_WINDOW_S:
            # Refill the tank
            active["cascade_size"]     += 1
            active["total_liq_volume"] += usd_val
            active["last_liq_ts"]       = now
            active["liq_remaining"]    += usd_val
            # Reset _last_delta to the current monotonic counter so the next
            # 200ms tick computes a clean delta_tick from this baseline.
            active["_last_delta"]       = self._s.sym_impact_delta.get(sym, 0.0)
            active["cascade_events"].append([now, usd_val, exchange])
            # Reset tank-empty markers — tank is alive again
            active["tank_empty_ts"]        = None
            active["tank_empty_price"]     = None
            active["final_expected_price"] = None
            active["cascade_duration_s"]   = None
            active["price_difference"]     = None
        else:
            if self._tick_task is None or self._tick_task.done():
                self._tick_task = asyncio.create_task(self._tick_loop())
            if active:
                await self._close_obs(sym)

            current_delta = self._s.sym_impact_delta.get(sym, 0.0)
            res = self._l2.compute_terminal_price(usd_val, side, sym=sym)

            obs = {
                "id":                     _gen_id(),
                "asset":                  sym,
                "timestamp":              now,
                "entry_price":            price,
                "side":                   side,
                "exchange":               exchange,
                "cascade_size":           1,
                "initial_liq_volume":     usd_val,
                "initial_delta":          current_delta,
                "initial_expected_price": res["terminal_price"],
                "total_liq_volume":       usd_val,
                "liq_remaining":          usd_val,
                "last_liq_ts":            now,
                "tank_empty_ts":          None,
                "tank_empty_price":       None,
                "price_difference":       None,
                "final_expected_price":   None,
                "cascade_duration_s":     None,
                "actual_terminal_price":  None,
                "price_error_pct":        None,
                "absorbed_by_delta":      False,
                "label_filled":           0,
                "delta_series":           [],
                "expected_price_series":  [],
                "price_series":           [],
                "liq_remaining_series":   [],
                "beyond_cutoff":          res["beyond_cutoff"],
                "cutoff_price":           res["cutoff_price"],
                "cascade_events":         [[now, usd_val, exchange]],
                "_last_delta":            current_delta,
            }
            self.active[sym] = obs

        await self._broadcast_table_update()

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
            sym_price = self._s.sym_price.get(sym) or self._s.price

            # Step 1: Update the tank with this tick's real market flow.
            # sym_impact_delta is a monotonic counter (never resets), so
            # differencing it always yields a small, correct per-200ms value
            # with no phantom spikes at second boundaries.
            current_delta  = self._s.sym_impact_delta.get(sym, 0.0)
            last_delta     = obs.get("_last_delta", current_delta)
            delta_tick     = current_delta - last_delta
            obs["_last_delta"] = current_delta

            direction      = 1.0 if obs["side"] == "long" else -1.0
            prev_remaining = obs["liq_remaining"]
            obs["liq_remaining"] = max(
                0.0,
                obs["liq_remaining"] - direction * delta_tick
            )

            # Step 2: Read-only bucket walk — purely a prediction.
            res = self._l2.compute_terminal_price(
                obs["liq_remaining"], obs["side"], sym=sym
            )

            # Step 3: Record the exact moment the tank first hits zero.
            if (
                obs["liq_remaining"] == 0.0
                and prev_remaining > 0.0
                and obs.get("tank_empty_ts") is None
            ):
                obs["tank_empty_ts"]        = now
                obs["tank_empty_price"]     = sym_price
                obs["final_expected_price"] = res["terminal_price"]
                obs["cascade_duration_s"]   = now - obs["timestamp"]
                obs["price_difference"]     = sym_price - obs["entry_price"]
                obs["price_error_pct"]      = _price_error(
                    obs["initial_expected_price"],
                    res["terminal_price"],
                    obs["entry_price"],
                )
                obs["absorbed_by_delta"] = _is_absorbed(
                    obs["side"],
                    obs["cascade_size"],
                    obs["initial_liq_volume"],
                    obs["delta_series"],
                )

            # Record time series
            obs["delta_series"].append([now, delta_tick])
            obs["expected_price_series"].append([now, res["terminal_price"]])
            obs["price_series"].append([now, sym_price])
            obs["liq_remaining_series"].append([now, obs["liq_remaining"]])

            if res["beyond_cutoff"]:
                obs["beyond_cutoff"] = True
            if res["cutoff_price"] is not None:
                obs["cutoff_price"] = res["cutoff_price"]

            # Only silence closes the observation
            if now - obs["last_liq_ts"] > SILENCE_WINDOW_S:
                to_close.append(sym)

        for sym in to_close:
            await self._close_obs(sym)

    async def _close_obs(self, sym: str):
        obs = self.active.pop(sym, None)
        if obs is None:
            return
        now = time.time()
        obs["label_filled"]          = 1
        obs["actual_terminal_price"] = self._s.sym_price.get(sym) or self._s.price

        if obs.get("tank_empty_ts") is None:
            obs["tank_empty_ts"]        = now
            obs["tank_empty_price"]     = obs["actual_terminal_price"]
            obs["price_difference"]     = obs["tank_empty_price"] - obs["entry_price"]
            obs["final_expected_price"] = (
                obs["expected_price_series"][-1][1]
                if obs["expected_price_series"]
                else obs["initial_expected_price"]
            )
            obs["cascade_duration_s"] = now - obs["timestamp"]
            obs["price_error_pct"]    = _price_error(
                obs["initial_expected_price"],
                obs["final_expected_price"],
                obs["entry_price"],
            )
            # Tank never emptied — not absorbed, the liq just expired
            obs["absorbed_by_delta"] = False

        obs.pop("_last_delta", None)
        self.observations.insert(0, obs)
        self._persist_obs(obs)
        await self._broadcast_table_update()

    def get_all(self) -> list[dict]:
        return list(self.active.values()) + self.observations

    def to_serialisable(self, obs: dict) -> dict:
        def ts(t: float) -> int:
            return int(t * 1000)
        def tsn(t) -> int | None:
            return int(t * 1000) if t is not None else None
        return {
            **obs,
            "timestamp":             ts(obs["timestamp"]),
            "last_liq_ts":           ts(obs["last_liq_ts"]),
            "tank_empty_ts":         tsn(obs.get("tank_empty_ts")),
            "delta_series":          [[ts(t), v] for t, v in obs["delta_series"]],
            "expected_price_series": [[ts(t), v] for t, v in obs["expected_price_series"]],
            "price_series":          [[ts(t), v] for t, v in obs["price_series"]],
            "liq_remaining_series":  [[ts(t), v] for t, v in obs["liq_remaining_series"]],
            "cascade_events":        [[ts(t), v, ex] for t, v, ex in obs["cascade_events"]],
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
