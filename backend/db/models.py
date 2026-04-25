"""DDL schema for liq-cascade-terminal SQLite persistence."""

# ---------------------------------------------------------------------------
# Table: cascade_observations  (primary ML / analysis table)
# ---------------------------------------------------------------------------
CREATE_CASCADE_OBSERVATIONS = """
CREATE TABLE IF NOT EXISTS cascade_observations (
    obs_id                  TEXT PRIMARY KEY,
    asset                   TEXT NOT NULL,
    timestamp               REAL NOT NULL,
    entry_price             REAL NOT NULL,
    side                    TEXT NOT NULL,
    exchange                TEXT NOT NULL,
    cascade_size            INTEGER NOT NULL DEFAULT 1,
    initial_liq_volume      REAL,
    initial_delta           REAL,
    initial_expected_price  REAL,
    total_liq_volume        REAL,
    liq_remaining           REAL,
    last_liq_ts             REAL,
    final_expected_price    REAL,
    actual_terminal_price   REAL,
    price_error_pct         REAL,
    cascade_duration_s      REAL,
    absorbed_by_delta       INTEGER NOT NULL DEFAULT 0,
    delta_series            TEXT,
    expected_price_series   TEXT,
    price_series            TEXT,
    liq_remaining_series    TEXT,
    cascade_events_json     TEXT,
    label_filled            INTEGER NOT NULL DEFAULT 0
)
"""
# NOTE: no trailing semicolon inside the triple-quote — sqlite3.execute()
# raises ProgrammingError("You can only execute one statement at a time")
# if the string ends with a semicolon followed by whitespace.

# ---------------------------------------------------------------------------
# Table: liq_events  (raw per-liquidation-message log)
# ---------------------------------------------------------------------------
CREATE_LIQ_EVENTS = """
CREATE TABLE IF NOT EXISTS liq_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset       TEXT NOT NULL,
    timestamp   REAL NOT NULL,
    side        TEXT NOT NULL,
    usd_val     REAL NOT NULL,
    price       REAL NOT NULL,
    exchange    TEXT NOT NULL
)
"""

# ---------------------------------------------------------------------------
# Indexes
# ---------------------------------------------------------------------------
_IDX_OBS_LABEL_TS  = "CREATE INDEX IF NOT EXISTS idx_obs_label_ts    ON cascade_observations (label_filled, timestamp DESC)"
_IDX_OBS_ASSET_TS  = "CREATE INDEX IF NOT EXISTS idx_obs_asset_ts    ON cascade_observations (asset, timestamp DESC)"
_IDX_EVENTS_ASSET  = "CREATE INDEX IF NOT EXISTS idx_liq_events_asset ON liq_events (asset, timestamp)"

INDEXES = [_IDX_OBS_LABEL_TS, _IDX_OBS_ASSET_TS, _IDX_EVENTS_ASSET]

ALL_DDL = [
    CREATE_CASCADE_OBSERVATIONS,
    CREATE_LIQ_EVENTS,
    *INDEXES,
]

# ---------------------------------------------------------------------------
# Migration manifest — additive ALTER TABLE ADD COLUMN
# ---------------------------------------------------------------------------
CASCADE_OBS_REQUIRED_COLUMNS: list[tuple[str, str]] = [
    ("obs_id",                  "TEXT"),
    ("asset",                   "TEXT NOT NULL"),
    ("timestamp",               "REAL NOT NULL"),
    ("entry_price",             "REAL NOT NULL"),
    ("side",                    "TEXT NOT NULL"),
    ("exchange",                "TEXT NOT NULL"),
    ("cascade_size",            "INTEGER"),
    ("initial_liq_volume",      "REAL"),
    ("initial_delta",           "REAL"),
    ("initial_expected_price",  "REAL"),
    ("total_liq_volume",        "REAL"),
    ("liq_remaining",           "REAL"),
    ("last_liq_ts",             "REAL"),
    ("final_expected_price",    "REAL"),
    ("actual_terminal_price",   "REAL"),
    ("price_error_pct",         "REAL"),
    ("cascade_duration_s",      "REAL"),
    ("absorbed_by_delta",       "INTEGER"),
    ("delta_series",            "TEXT"),
    ("expected_price_series",   "TEXT"),
    ("price_series",            "TEXT"),
    ("liq_remaining_series",    "TEXT"),
    ("cascade_events_json",     "TEXT"),
    ("label_filled",            "INTEGER"),
]
