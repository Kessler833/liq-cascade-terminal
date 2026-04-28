"""fix_cascade_series.py

One-off migration for cascade_observations rows where cascade_size > 1
have truncated time-series due to the stale _last_delta bug fixed in
commit 76b917e.

The bug caused a phantom delta spike on the first tick after a cascade
refill, instantly draining liq_remaining and closing the tank after only
1-2 ticks. So the series are not empty — they just have 1-3 points
whereas a real cascade_duration_s of e.g. 5s should have ~25 points
(one per 200ms tick).

Detection
---------
A row is considered corrupted if ANY of its series has fewer ticks than
expected given cascade_duration_s, using a threshold of MIN_TICKS_PER_S.
Default: if series length < expected_ticks * 0.25, it's truncated.

What this does
--------------
Replaces truncated series with a synthesised version built from the
intact scalar fields (timestamp, tank_empty_ts, entry_price,
tank_empty_price, initial_expected_price, final_expected_price,
initial_liq_volume). Charts will show a clean start→end line.

Rows with healthy series are left untouched.

Usage
-----
    python3 scripts/fix_cascade_series.py --db ~/.liqterm/liqterm.db
    python3 scripts/fix_cascade_series.py --db ~/.liqterm/liqterm.db --apply

    # Lower the threshold if you want to be more aggressive (default 0.25)
    python3 scripts/fix_cascade_series.py --db ~/.liqterm/liqterm.db --threshold 0.5
"""

import argparse
import json
import os
import sqlite3
import sys

DEFAULT_DB        = os.path.join(os.path.dirname(__file__), "..", "backend", "liqterm.db")
TICK_INTERVAL_S   = 0.2   # 200ms ticks
DEFAULT_THRESHOLD = 0.25  # flag if series has < 25% of expected tick count


def load_series(raw: str | None) -> list:
    if not raw:
        return []
    try:
        return json.loads(raw)
    except Exception:
        return []


def is_truncated(series: list, expected_ticks: float, threshold: float) -> bool:
    """True if series is shorter than threshold * expected_ticks."""
    if expected_ticks < 2:
        # Very short cascade (<0.4s) — can't reliably judge, skip
        return False
    return len(series) < expected_ticks * threshold


def synthesise(row: dict) -> dict:
    """Build replacement series from scalar fields."""
    t0  = row["timestamp"]
    t1  = row["tank_empty_ts"] if row["tank_empty_ts"] else t0
    p0  = row["entry_price"]
    p1  = row["tank_empty_price"] if row["tank_empty_price"] else p0
    ep0 = row["initial_expected_price"] if row["initial_expected_price"] else p0
    ep1 = row["final_expected_price"]   if row["final_expected_price"]   else ep0
    vol = row["initial_liq_volume"] or 0.0
    liq_end = row["liq_remaining"] or 0.0

    ms0 = int(t0 * 1000)
    ms1 = int(t1 * 1000)
    mid = (ms0 + ms1) // 2

    return {
        "delta_series":          json.dumps([[ms0, 0.0], [mid, vol], [ms1, 0.0]]),
        "expected_price_series": json.dumps([[ms0, ep0], [ms1, ep1]]),
        "price_series":          json.dumps([[ms0, p0],  [ms1, p1]]),
        "liq_remaining_series":  json.dumps([[ms0, vol], [ms1, liq_end]]),
    }


def run(db_path: str, apply: bool, threshold: float) -> None:
    db_path = os.path.expanduser(db_path)
    if not os.path.exists(db_path):
        print(f"ERROR: DB not found at {db_path}")
        sys.exit(1)

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    cur.execute(
        """
        SELECT obs_id, timestamp, tank_empty_ts,
               entry_price, tank_empty_price,
               initial_expected_price, final_expected_price,
               initial_liq_volume, liq_remaining, cascade_duration_s,
               delta_series, expected_price_series,
               price_series, liq_remaining_series,
               cascade_size
        FROM cascade_observations
        WHERE cascade_size > 1
        """
    )
    rows = [dict(r) for r in cur.fetchall()]
    print(f"Found {len(rows)} cascade_size > 1 rows. Checking for truncated series...")

    patched = 0
    skipped = 0
    for row in rows:
        dur = row["cascade_duration_s"] or 0.0
        expected_ticks = dur / TICK_INTERVAL_S

        delta_s = load_series(row["delta_series"])
        exp_s   = load_series(row["expected_price_series"])
        price_s = load_series(row["price_series"])
        liq_s   = load_series(row["liq_remaining_series"])

        truncated = (
            is_truncated(delta_s, expected_ticks, threshold) or
            is_truncated(exp_s,   expected_ticks, threshold) or
            is_truncated(price_s, expected_ticks, threshold) or
            is_truncated(liq_s,   expected_ticks, threshold)
        )

        if not truncated:
            skipped += 1
            continue

        patches = synthesise(row)
        set_clause = ", ".join(f"{col} = ?" for col in patches)
        values     = list(patches.values()) + [row["obs_id"]]
        sql        = f"UPDATE cascade_observations SET {set_clause} WHERE obs_id = ?"

        if apply:
            cur.execute(sql, values)
        else:
            actual = min(len(delta_s), len(price_s), len(exp_s), len(liq_s))
            print(
                f"  [DRY-RUN] {row['obs_id']}  size={row['cascade_size']}  "
                f"dur={dur:.1f}s  expected~{expected_ticks:.0f} ticks  "
                f"actual={actual} ticks  → TRUNCATED"
            )
        patched += 1

    if apply:
        con.commit()
        print(f"Done. Patched {patched} rows, skipped {skipped} (series looked healthy).")
    else:
        print(f"\nDry-run: {patched} truncated rows found, {skipped} look healthy.")
        print("Re-run with --apply to overwrite truncated series.")

    con.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply",     action="store_true",        help="Write changes (default: dry-run)")
    parser.add_argument("--db",        default=DEFAULT_DB,          help="Path to liqterm.db")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD,
                        help="Flag series with < THRESHOLD * expected ticks (default 0.25)")
    args = parser.parse_args()
    run(args.db, args.apply, args.threshold)
