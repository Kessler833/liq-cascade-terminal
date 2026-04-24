"""SQLite DDL for liq-cascade-terminal observations."""

CREATE_OBSERVATIONS = """
CREATE TABLE IF NOT EXISTS observations (
    obs_id              TEXT PRIMARY KEY,
    asset               TEXT    NOT NULL,
    timestamp           REAL    NOT NULL,
    side                TEXT    NOT NULL,
    price               REAL    NOT NULL,
    cascade_score       REAL,
    cascade_threshold   REAL,
    cascade_pct         REAL,
    liq_1m_usd          REAL,
    cumulative_delta    REAL,
    bnce_long           REAL,
    bnce_short          REAL,
    bybt_long           REAL,
    bybt_short          REAL,
    okx_long            REAL,
    okx_short           REAL,
    bget_long           REAL,
    bget_short          REAL,
    gate_long           REAL,
    gate_short          REAL,
    dydx_long           REAL,
    dydx_short          REAL,
    price_path_json     TEXT,
    peak_return_30m_pct REAL,
    time_to_peak_30m_s  REAL,
    optimal_sharpe_30m  REAL,
    peak_return_60m_pct REAL,
    time_to_peak_60m_s  REAL,
    optimal_sharpe_60m  REAL,
    net_return_2m_pct   REAL,
    label_filled        INTEGER NOT NULL DEFAULT 0
);
"""

CREATE_PRICE_TICKS = """
CREATE TABLE IF NOT EXISTS price_ticks (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    asset     TEXT    NOT NULL,
    timestamp REAL    NOT NULL,
    price     REAL    NOT NULL
);
"""

CREATE_PRICE_TICKS_INDEX = """
CREATE INDEX IF NOT EXISTS idx_price_ticks_asset_ts
    ON price_ticks (asset, timestamp DESC);
"""

CREATE_OBS_INDEX = """
CREATE INDEX IF NOT EXISTS idx_obs_label_ts
    ON observations (label_filled, timestamp DESC);
"""

ALL_DDL = [
    CREATE_OBSERVATIONS,
    CREATE_PRICE_TICKS,
    CREATE_PRICE_TICKS_INDEX,
    CREATE_OBS_INDEX,
]
