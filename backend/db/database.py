"""SQLite persistence layer for liq-cascade-terminal.

Architecture: single asyncio worker queue serialises all writes so SQLite's
single-writer requirement is never violated under concurrent async coroutines.
Reads run in a thread-pool executor (non-blocking, concurrent).
The queue is bounded at 5 000 entries to cap memory during cascades.

Public API
----------
    await init_db()                          -- call once in FastAPI lifespan startup
    await close_db()                         -- call once in FastAPI lifespan shutdown
    await fetchall(sql, params)  -> list[dict]
    await fetchone(sql, params)  -> dict | None
    await execute(sql, params)               -- write, awaits completion
    execute_nonblocking(sql, params) -> bool -- fire-and-forget, drops if queue full
    await executemany(sql, params_list)      -- bulk write
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from pathlib import Path
from typing import Any

from db.models import ALL_DDL, CASCADE_OBS_REQUIRED_COLUMNS, INDEXES

log = logging.getLogger("liqterm.db")

DB_PATH = Path.home() / ".liqterm" / "liqterm.db"

_conn:        sqlite3.Connection | None = None
_queue:       asyncio.Queue       | None = None
_worker_task: asyncio.Task        | None = None


# ---------------------------------------------------------------------------
# Internal write worker
# ---------------------------------------------------------------------------

async def _db_worker(queue: asyncio.Queue) -> None:
    while True:
        job = await queue.get()
        if job is None:          # poison-pill -> graceful shutdown
            queue.task_done()
            break
        sql, params, many, fut = job
        try:
            if many:
                _conn.executemany(sql, params)
            else:
                _conn.execute(sql, params)
            _conn.commit()
            if fut is not None and not fut.done():
                fut.set_result(None)
        except Exception as exc:
            log.exception("DB worker error executing: %s", sql[:120])
            if fut is not None and not fut.done():
                fut.set_exception(exc)
        finally:
            queue.task_done()


# ---------------------------------------------------------------------------
# Internal read helper
# ---------------------------------------------------------------------------

def _read_sync(sql: str, params: tuple, one: bool) -> Any:
    cur  = _conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    if one:
        row = cur.fetchone()
        return dict(zip(cols, row)) if row else None
    return [dict(zip(cols, r)) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Public async API
# ---------------------------------------------------------------------------

async def fetchall(sql: str, params: tuple = ()) -> list[dict]:
    """Return all matching rows as a list of dicts."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _read_sync, sql, params, False)


async def fetchone(sql: str, params: tuple = ()) -> dict | None:
    """Return the first matching row as a dict, or None."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _read_sync, sql, params, True)


async def execute(sql: str, params: tuple = ()) -> None:
    """Queue a write and await its completion."""
    fut = asyncio.get_event_loop().create_future()
    await _queue.put((sql, params, False, fut))
    await fut


def execute_nonblocking(sql: str, params: tuple = ()) -> bool:
    """Fire-and-forget write.  Returns False (and drops silently) if queue full."""
    try:
        _queue.put_nowait((sql, params, False, None))
        return True
    except asyncio.QueueFull:
        log.warning("DB queue full — dropping write")
        return False


async def executemany(sql: str, params_list: list) -> None:
    """Bulk write; awaits completion."""
    fut = asyncio.get_event_loop().create_future()
    await _queue.put((sql, params_list, True, fut))
    await fut


# ---------------------------------------------------------------------------
# Migration — additive only (ALTER TABLE ADD COLUMN)
# ---------------------------------------------------------------------------

def _migrate_sync(conn: sqlite3.Connection) -> None:
    cur     = conn.execute("PRAGMA table_info(cascade_observations)")
    existing = {row[1] for row in cur.fetchall()}
    added   = 0
    for col_name, col_type in CASCADE_OBS_REQUIRED_COLUMNS:
        if col_name not in existing:
            # SQLite forbids ADD COLUMN ... NOT NULL without a DEFAULT
            safe_type = col_type.replace(" NOT NULL", "")
            conn.execute(
                f"ALTER TABLE cascade_observations ADD COLUMN {col_name} {safe_type}"
            )
            added += 1
    for idx_sql in INDEXES:
        conn.execute(idx_sql)
    conn.commit()
    if added:
        log.info("Migration: added %d column(s) to cascade_observations", added)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

async def init_db() -> None:
    """Create/open the database, run DDL + migrations, start the worker."""
    global _conn, _queue, _worker_task
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA foreign_keys=ON")
    _conn.execute("PRAGMA busy_timeout=10000")
    _conn.execute("PRAGMA synchronous=NORMAL")
    for ddl in ALL_DDL:
        _conn.execute(ddl)
    _conn.commit()
    _migrate_sync(_conn)
    _queue       = asyncio.Queue(maxsize=5_000)
    _worker_task = asyncio.create_task(_db_worker(_queue))
    log.info("DB initialised at %s", DB_PATH)


async def close_db() -> None:
    """Flush the queue, stop the worker, close the connection."""
    global _conn, _queue, _worker_task
    if _queue is not None:
        await _queue.put(None)   # poison pill
        await _queue.join()
    if _worker_task is not None:
        await _worker_task
    if _conn is not None:
        _conn.close()
        _conn = None
    log.info("DB closed")
