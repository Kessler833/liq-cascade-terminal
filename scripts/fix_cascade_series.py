"""fix_cascade_series.py

One-off migration for cascade_observations rows where cascade_size > 1
have empty time-series (delta_series, price_series, etc.) due to the
stale _last_delta bug fixed in commit 76b917e.

What this does
--------------
The raw tick data is gone, but all scalar fields are intact:
  timestamp, tank_empty_ts, entry_price, tank_empty_price,
  initial_expected_price, final_expected_price, initial_liq_volume.

For each affected row we synthesise a minimal 2-point series
(t=start, t=end) from those scalars so the Impact detail charts
render a meaningful start→end line instead of being blank.

Rows that already have series data are left untouched.

Usage
-----
    python scripts/fix_cascade_series.py              # dry-run, prints summary
    python scripts/fix_cascade_series.py --apply      # writes to DB
    python scripts/fix_cascade_series.py --db PATH    # explicit DB path
    python scripts/fix_cascade_series.py --apply --db PATH
"""

import argparse
import json
import os
import sqlite3
import sys

DEFAULT_DB = os.path.join(os.path.dirname(__file__), "..", "backend", "liqterm.db")


def synthesise_series(row: dict) -> dict | None:
    """Return a dict of patched JSON series, or None if nothing to fix."""
    t0  = row["timestamp"]       # seconds float
    t1  = row["tank_empty_ts"]   # may be None
    p0  = row["entry_price"]
    p1  = row["tank_empty_price"]
    ep0 = row["initial_expected_price"]
    ep1 = row["final_expected_price"]
    vol = row["initial_liq_volume"] or 0.0

    # Parse existing series
    def load(col: str) -> list:
        raw = row.get(col)
        if not raw:
            return []
        try:
            return json.loads(raw)
        except Exception:
            return []

    delta_s    = load("delta_series")
    exp_s      = load("expected_price_series")
    price_s    = load("price_series")
    liq_s      = load("liq_remaining_series")

    # Nothing to fix if all series already have data
    if delta_s and exp_s and price_s and liq_s:
        return None

    # We need at least t0 and p0 to do anything useful
    if t0 is None or p0 is None:
        return None

    # If we have t1/p1 use them, otherwise duplicate t0 point
    t_end  = t1  if t1  is not None else t0
    p_end  = p1  if p1  is not None else p0
    ep_end = ep1 if ep1 is not None else (ep0 or p0)
    ep_start = ep0 if ep0 is not None else p0

    # Convert to milliseconds (what the frontend expects)
    ms0 = int(t0   * 1000)
    ms1 = int(t_end * 1000)

    patches: dict = {}

    if not delta_s:
        # We can't recover real delta ticks; use 0-baseline with total vol as
        # a single mid-point impulse so the chart isn't completely flat.
        mid_ms = (ms0 + ms1) // 2
        patches["delta_series"] = json.dumps(
            [[ms0, 0.0], [mid_ms, vol], [ms1, 0.0]]
        )

    if not exp_s:
        patches["expected_price_series"] = json.dumps(
            [[ms0, ep_start], [ms1, ep_end]]
        )

    if not price_s:
        patches["price_series"] = json.dumps(
            [[ms0, p0], [ms1, p_end]]
        )

    if not liq_s:
        # Tank started at initial_liq_volume, ended at 0 (or liq_remaining)
        liq_end = row.get("liq_remaining") or 0.0
        patches["liq_remaining_series"] = json.dumps(
            [[ms0, vol], [ms1, liq_end]]
        )

    return patches if patches else None


def run(db_path: str, apply: bool) -> None:
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
               initial_liq_volume, liq_remaining,
               delta_series, expected_price_series,
               price_series, liq_remaining_series,
               cascade_size
        FROM cascade_observations
        WHERE cascade_size > 1
        """
    )
    rows = [dict(r) for r in cur.fetchall()]
    print(f"Found {len(rows)} cascade_size > 1 rows.")

    patched = 0
    skipped = 0
    for row in rows:
        patches = synthesise_series(row)
        if patches is None:
            skipped += 1
            continue

        set_clause = ", ".join(f"{col} = ?" for col in patches)
        values     = list(patches.values()) + [row["obs_id"]]
        sql        = f"UPDATE cascade_observations SET {set_clause} WHERE obs_id = ?"

        if apply:
            cur.execute(sql, values)
        else:
            cols = list(patches.keys())
            print(f"  [DRY-RUN] {row['obs_id']} (size={row['cascade_size']}) → patch {cols}")

        patched += 1

    if apply:
        con.commit()
        print(f"Done. Patched {patched} rows, skipped {skipped} (already had data).")
    else:
        print(f"\nDry-run complete. {patched} rows would be patched, {skipped} already have series data.")
        print("Re-run with --apply to write changes.")

    con.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill empty series on cascade_size > 1 DB rows.")
    parser.add_argument("--apply",  action="store_true", help="Write changes to DB (default: dry-run)")
    parser.add_argument("--db",     default=DEFAULT_DB,  help="Path to liqterm.db")
    args = parser.parse_args()
    run(args.db, args.apply)
