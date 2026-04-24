"""Cascade Impact recorder — Python port of cascade_impact.js.

Records per-cascade observations: entry price, liq volume, predicted vs actual
terminal price, delta series, price series, and liq-remaining tank.
"""
from __future__ import annotations

import asyncio
import logging
import random
import string
import time
from typing import TYPE_CHECKING, Callable, Awaitable

if TYPE_CHECKING:
    from engine.state import AppState
    from engine.l2_model import L2Model

log = logging.getLogger("liqterm.impact")

SILENCE_WINDOW_S  = 30.0    # new liq within 30s extends current cascade
MIN_LIQ_USD       = 100_000
TICK_INTERVAL_S   = 0.2     # sample every 200ms while recording


def _gen_id() -> str:
    ts = int(time.time() * 1000)
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
    return f"{ts:x}{rand}"


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
        self.active: dict[str, dict] = {}    # sym → in-progress obs
        self._tick_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    async def on_liquidation(self, exchange: str, side: str, usd_val: float, price: float):
        if usd_val < MIN_LIQ_USD:
            return
        sym = self._s.symbol
        now = time.time()
        active = self.active.get(sym)

        if active and now - active["last_liq_ts"] < SILENCE_WINDOW_S:
            # Extend existing cascade
            active["cascade_size"] += 1
            active["total_liq_volume"] += usd_val
            active["last_liq_ts"] = now
            active["liq_remaining"] += usd_val
            active["cascade_events"].append([now, usd_val, exchange])
        else:
            if active:
                await self._close_obs(sym)
            # Open new observation
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
                # time series
                "delta_series":          [],
                "expected_price_series": [],
                "price_series":          [],
                "liq_remaining_series":  [],
                "cascade_events":        [[now, usd_val, exchange]],
                # filled at close
                "final_expected_price":  None,
                "actual_terminal_price": None,
                "price_error_pct":       None,
                "cascade_duration_s":    None,
                "absorbed_by_delta":     False,
                "label_filled":          0,
            }
            self.active[sym] = obs
            if self._tick_task is None or self._tick_task.done():
                self._tick_task = asyncio.create_task(self._tick_loop())

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
        now = time.time()
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
            if res["absorbed"]:
                obs["absorbed_by_delta"] = True
            silence_expired = now - obs["last_liq_ts"] > SILENCE_WINDOW_S
            tank_dry = obs["liq_remaining"] < obs["initial_liq_volume"] * 0.02
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
        obs["cascade_duration_s"] = (events[-1][0] - events[0][0]) if len(events) > 1 else 0.0
        self.observations.insert(0, obs)
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
            "timestamp": ts(obs["timestamp"]),
            "last_liq_ts": ts(obs["last_liq_ts"]),
            "delta_series":          [[ts(t), v] for t, v in obs["delta_series"]],
            "expected_price_series": [[ts(t), v] for t, v in obs["expected_price_series"]],
            "price_series":          [[ts(t), v] for t, v in obs["price_series"]],
            "liq_remaining_series":  [[ts(t), v] for t, v in obs["liq_remaining_series"]],
            "cascade_events":        [[ts(t), v, ex] for t, v, ex in obs["cascade_events"]],
        }

    async def _broadcast_table_update(self):
        all_obs = self.get_all()
        await self._broadcast({
            "type": "impact_update",
            "observations": [self.to_serialisable(o) for o in all_obs[:50]],
            "stats": self._calc_stats(all_obs),
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
