"""One-time backfill: recompute absorbed_by_delta and price_error_pct for all DB rows.

Run from the backend/ directory:
    python ../scripts/fix_absorbed_and_error.py

Or from repo root:
    python scripts/fix_absorbed_and_error.py --db path/to/cascade.db

What this fixes
---------------
absorbed_by_delta
    Old logic: True whenever tank hit zero from any delta drain.
    New logic: True only when the very first tick's counter-flow alone
               was >= initial_liq_volume (market instantly ate the liq).
    Rows where tank never hit zero (closed by silence) are forced to False.

price_error_pct
    Old formula: (final_expected - initial_expected) / entry_price * 100
    New formula: (initial_expected - final_expected) / (final_expected - entry_price) * 100
    Rows where (final_expected - entry_price) == 0 are set to NULL.
"""
import argparse
import json
import os
import sqlite3
import sys

DEFAULT_DB = os.path.join(os.path.dirname(__file__), "..", "backend", "cascade.db")


def _jload(val):
    return json.loads(val) if val else []


def _price_error(initial_expected, final_expected, entry_price):
    if initial_expected is None or final_expected is None or entry_price is None:
        return None
    move = final_expected - entry_price
    if move == 0.0:
        return None
    return (initial_expected - final_expected) / move * 100


def _is_absorbed(side, initial_liq_volume, delta_series):
    """Counter-flow in the very first tick alone >= initial_liq_volume."""
    if not delta_series or initial_liq_volume is None:
        return False
    first_delta_tick = delta_series[0][1]
    direction = 1.0 if side == "long" else -1.0
    counter_flow = -direction * first_delta_tick
    return counter_flow >= initial_liq_volume


def main():
    parser = argparse.ArgumentParser(description="Backfill absorbed_by_delta and price_error_pct")
    parser.add_argument("--db", default=DEFAULT_DB, help="Path to cascade.db")
    parser.add_argument("--dry-run", action="store_true", help="Print changes without writing")
    args = parser.parse_args()

    db_path = os.path.abspath(args.db)
    if not os.path.exists(db_path):
        print(f"ERROR: DB not found at {db_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Opening {db_path}")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    rows = con.execute("SELECT * FROM cascade_observations").fetchall()
    print(f"Found {len(rows)} rows")

    updates = []
    stats = {"absorbed_changed": 0, "error_changed": 0, "skipped": 0}

    for row in rows:
        obs_id              = row["obs_id"]
        side                = row["side"]
        initial_liq_volume  = row["initial_liq_volume"]
        initial_expected    = row["initial_expected_price"]
        final_expected      = row["final_expected_price"]
        entry_price         = row["entry_price"]
        tank_empty_ts       = row["tank_empty_ts"]
        delta_series        = _jload(row["delta_series"])

        # --- absorbed_by_delta ---
        # If tank never emptied (silence closed it), definitely not absorbed.
        if tank_empty_ts is None:
            new_absorbed = 0
        else:
            new_absorbed = 1 if _is_absorbed(side, initial_liq_volume, delta_series) else 0

        old_absorbed = row["absorbed_by_delta"] or 0
        if new_absorbed != old_absorbed:
            stats["absorbed_changed"] += 1

        # --- price_error_pct ---
        new_error = _price_error(initial_expected, final_expected, entry_price)
        old_error = row["price_error_pct"]

        # Compare loosely — treat None vs None as unchanged
        error_changed = False
        if new_error is None and old_error is not None:
            error_changed = True
        elif new_error is not None and old_error is None:
            error_changed = True
        elif new_error is not None and old_error is not None:
            if abs(new_error - old_error) > 1e-9:
                error_changed = True

        if error_changed:
            stats["error_changed"] += 1

        if new_absorbed != old_absorbed or error_changed:
            updates.append((new_absorbed, new_error, obs_id))
        else:
            stats["skipped"] += 1

    print(f"\nChanges to apply:")
    print(f"  absorbed_by_delta changed : {stats['absorbed_changed']}")
    print(f"  price_error_pct changed   : {stats['error_changed']}")
    print(f"  rows unchanged            : {stats['skipped']}")
    print(f"  total rows to update      : {len(updates)}")

    if args.dry_run:
        print("\n--dry-run: no changes written.")
        return

    if not updates:
        print("\nNothing to update.")
        return

    con.executemany(
        "UPDATE cascade_observations SET absorbed_by_delta=?, price_error_pct=? WHERE obs_id=?",
        updates,
    )
    con.commit()
    con.close()
    print(f"\nDone. {len(updates)} rows updated.")


if __name__ == "__main__":
    main()
