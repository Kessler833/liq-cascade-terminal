"""Real-time Kyle's lambda estimator with adaptive thresholds.

Kyle's lambda is the OLS slope of ΔP = λ·ΔQ — price change regressed on
net order flow without intercept. It measures how much price moves per
dollar of net flow at this specific moment in this specific market regime.

When λ is at baseline the market is absorbing flow efficiently (bilateral,
liquid). When λ spikes the market is one-sided — forced sellers overwhelm
buyers, voluntary sellers pile on, market makers withdraw. A dollar of
flow punches through more book than face value because the book's effective
absorption capacity has collapsed.

This is why lambda scales the L2 walk: the L2 model sees nominal depth.
Lambda tells you what fraction of that depth is real right now.

Adaptive threshold
------------------
No hardcoded multiplier. The cascade threshold is derived from quiet-phase
observations segmented by symbol and 30-minute time-of-day bucket:

    threshold(sym, time) = mean(quiet_lambda) + k * std(quiet_lambda)

where k=2.0 (97.7th percentile event). This adapts automatically to
intraday liquidity patterns, symbol-specific depth, and weekly regimes.

Hysteresis prevents flickering:
    arm    when lambda_now > mean + 2.0 * std  (97.7th pct)
    disarm when lambda_now < mean + 1.0 * std  (84th pct)

Usage
-----
    est = KyleLambda("BTC")
    result = est.update(price=50000.0, cum_flow=12_500_000.0, ts=time.time())
    result.lambda_now      — current OLS estimate
    result.lambda_base     — quiet-period mean for this time bucket
    result.cascade_armed   — True when lambda exceeds adaptive threshold
    result.ratio           — lambda_now / lambda_base (for prediction scaling)
"""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque

# ── Regression window ────────────────────────────────────────────────────────
BUCKET_S        = 5.0    # one (ΔQ, ΔP) sample every 5 seconds
WINDOW_BUCKETS  = 36     # 3-minute rolling OLS window (36 × 5s)
MIN_BUCKETS_FIT = 6      # minimum points before trusting the estimate
MIN_FLOW_USD    = 50_000 # ignore buckets with negligible net flow

# ── Adaptive threshold ───────────────────────────────────────────────────────
K_ARM    = 2.0   # arm:    lambda > mean + K_ARM    * std  (97.7th pct)
K_DISARM = 1.0   # disarm: lambda < mean + K_DISARM * std  (84th pct)

# ── Baseline history (Welford online algorithm per 30-min bucket) ────────────
N_DAY_BUCKETS           = 48     # 48 × 30min = 24h
MIN_BASELINE_SAMPLES    = 24     # need 2 min of quiet samples (24 × 5s)
FULL_CONFIDENCE_SAMPLES = 720    # 1 hour of quiet samples for full confidence


@dataclass
class LambdaResult:
    lambda_now:    float
    lambda_base:   float          # quiet-period mean for current time bucket
    lambda_std:    float          # quiet-period std for current time bucket
    ratio:         float          # lambda_now / lambda_base
    cascade_armed: bool
    threshold_arm:    float       # current arm threshold (mean + K * std)
    threshold_disarm: float       # current disarm threshold
    n_buckets:     int            # OLS window size
    n_baseline:    int            # quiet samples in current time bucket
    confidence:    float          # 0→1, how much to trust lambda vs L2 walk


@dataclass
class _WelfordBucket:
    """Online mean/variance via Welford's algorithm — O(1) memory."""
    n:    int   = 0
    mean: float = 0.0
    m2:   float = 0.0   # running sum of squared deviations

    @property
    def std(self) -> float:
        return math.sqrt(self.m2 / self.n) if self.n > 1 else 0.0

    def update(self, x: float) -> None:
        self.n    += 1
        delta      = x - self.mean
        self.mean += delta / self.n
        delta2     = x - self.mean
        self.m2   += delta * delta2


class KyleLambda:
    """Per-symbol online Kyle's lambda estimator."""

    def __init__(self, sym: str):
        self.sym = sym

        # ── OLS rolling window ───────────────────────────────────────────────
        self._buckets: Deque[tuple[float, float]] = deque(maxlen=WINDOW_BUCKETS)
        self._bucket_start_ts:    float = 0.0
        self._bucket_start_price: float = 0.0
        self._bucket_start_flow:  float = 0.0
        self._initialised:        bool  = False

        # ── Adaptive baseline: one Welford bucket per 30-min time slot ───────
        # Index 0 = 00:00–00:30 UTC, 1 = 00:30–01:00 UTC, ..., 47 = 23:30–00:00
        self._baseline: list[_WelfordBucket] = [
            _WelfordBucket() for _ in range(N_DAY_BUCKETS)
        ]

        # ── Hysteresis state ─────────────────────────────────────────────────
        self._cascade_armed: bool = False

        # ── Last computed result ─────────────────────────────────────────────
        self._last: LambdaResult | None = None

    # ── Public API ────────────────────────────────────────────────────────────

    def update(
        self,
        price:    float,
        cum_flow: float,   # sym_impact_delta — monotonic, never resets
        ts:       float,
    ) -> LambdaResult:
        """Call on every trade tick.  Internally quantises to BUCKET_S so
        call frequency doesn't matter — only bucket boundaries trigger OLS."""
        if not self._initialised:
            self._open_bucket(price, cum_flow, ts)
            self._initialised = True
            return self._empty_result(ts)

        if ts - self._bucket_start_ts >= BUCKET_S:
            self._close_bucket(price, cum_flow)
            self._open_bucket(price, cum_flow, ts)
            self._last = self._fit(ts)

        return self._last or self._empty_result(ts)

    def current(self) -> LambdaResult:
        return self._last or self._empty_result(time.time())

    def record_quiet_sample(self, ts: float) -> None:
        """Call when no cascade observation is active for this symbol.
        Feeds the current lambda estimate into the quiet-period baseline
        for this (symbol, 30-min time bucket)."""
        if self._last is None or self._last.lambda_now <= 0:
            return
        slot = self._time_slot(ts)
        self._baseline[slot].update(self._last.lambda_now)

    # ── Internal ─────────────────────────────────────────────────────────────

    def _time_slot(self, ts: float) -> int:
        """0..47 — which 30-minute bucket of the UTC day."""
        return int((ts % 86400) / 1800)

    def _open_bucket(self, price: float, cum_flow: float, ts: float) -> None:
        self._bucket_start_ts    = ts
        self._bucket_start_price = price
        self._bucket_start_flow  = cum_flow

    def _close_bucket(self, price: float, cum_flow: float) -> None:
        dQ = cum_flow - self._bucket_start_flow
        dP = price    - self._bucket_start_price
        if abs(dQ) >= MIN_FLOW_USD:
            self._buckets.append((dQ, dP))

    def _fit(self, ts: float) -> LambdaResult:
        if len(self._buckets) < MIN_BUCKETS_FIT:
            return self._empty_result(ts)

        sum_QP = sum(dQ * dP for dQ, dP in self._buckets)
        sum_Q2 = sum(dQ * dQ for dQ, dP in self._buckets)

        if sum_Q2 < 1e-12:
            return self._empty_result(ts)

        lam_now = max(sum_QP / sum_Q2, 0.0)

        slot     = self._time_slot(ts)
        baseline = self._baseline[slot]

        # ── Adaptive thresholds ───────────────────────────────────────────
        if baseline.n >= MIN_BASELINE_SAMPLES:
            mean = baseline.mean
            std  = baseline.std if baseline.std > 0 else mean * 0.1
        else:
            # cold start: fall back to a fraction of current lambda
            mean = lam_now * 0.6
            std  = lam_now * 0.2

        t_arm    = mean + K_ARM    * std
        t_disarm = mean + K_DISARM * std

        # ── Hysteresis ────────────────────────────────────────────────────
        if not self._cascade_armed:
            if lam_now > t_arm:
                self._cascade_armed = True
        else:
            if lam_now < t_disarm:
                self._cascade_armed = False

        ratio      = lam_now / mean if mean > 1e-20 else 1.0
        confidence = min(1.0, baseline.n / FULL_CONFIDENCE_SAMPLES)

        return LambdaResult(
            lambda_now       = lam_now,
            lambda_base      = mean,
            lambda_std       = std,
            ratio            = ratio,
            cascade_armed    = self._cascade_armed,
            threshold_arm    = t_arm,
            threshold_disarm = t_disarm,
            n_buckets        = len(self._buckets),
            n_baseline       = baseline.n,
            confidence       = confidence,
        )

    def _empty_result(self, ts: float) -> LambdaResult:
        slot = self._time_slot(ts)
        b    = self._baseline[slot]
        mean = b.mean if b.n > 0 else 0.0
        std  = b.std  if b.n > 0 else 0.0
        return LambdaResult(
            lambda_now       = 0.0,
            lambda_base      = mean,
            lambda_std       = std,
            ratio            = 1.0,
            cascade_armed    = False,
            threshold_arm    = mean + K_ARM    * std,
            threshold_disarm = mean + K_DISARM * std,
            n_buckets        = 0,
            n_baseline       = b.n,
            confidence       = min(1.0, b.n / FULL_CONFIDENCE_SAMPLES),
        )
