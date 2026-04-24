"""Async SQLite access layer — single-queue serialised worker."""
from __future__ import annotations

import asyncio
import logging
import sqlite3
from pathlib import Path

log = logging.getLogger("lct.db")

DB_PATH = Path.home() / ".lct" / "lct.db"

_conn: sqlite3.Connection | None = None
_queue: asyncio.Queue | None = None
_worker_task: asyncio.Task | None = None

_MANY     = object()
_FETCH_ALL = object()
_FETCH_ONE = object()


def _ensure_dir() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)


async def _db_worker() -> None:
    while True:
        job = await _queue.get()
        if job is None:
            _queue.task_done()
            break
        kind, sql, params, fut = job
        try:
            if kind is _FETCH_ALL:
                cur = _conn.execute(sql, params)
                result = [dict(zip([d[0] for d in cur.description], row))
                          for row in cur.fetchall()]
                fut.set_result(result)
            elif kind is _FETCH_ONE:
                cur = _conn.execute(sql, params)
                row = cur.fetchone()
                result = dict(zip([d[0] for d in cur.description], row)) if row else None
                fut.set_result(result)
            elif kind is _MANY:
                _conn.executemany(sql, params)
                _conn.commit()
                fut.set_result(None)
            else:
                _conn.execute(sql, params)
                _conn.commit()
                fut.set_result(None)
        except Exception as exc:
            if not fut.done():
                fut.set_exception(exc)
        finally:
            _queue.task_done()


async def init_db() -> None:
    global _conn, _queue, _worker_task
    from .models import ALL_DDL

    _ensure_dir()
    _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.execute("PRAGMA synchronous=NORMAL")
    _conn.execute("PRAGMA busy_timeout=10000")
    for ddl in ALL_DDL:
        _conn.execute(ddl)
    _conn.commit()

    _queue = asyncio.Queue(maxsize=5000)
    _worker_task = asyncio.create_task(_db_worker(), name="db_worker")
    log.info("DB ready: %s", DB_PATH)


def _make_fut() -> asyncio.Future:
    return asyncio.get_running_loop().create_future()


async def fetchall(sql: str, params: tuple = ()) -> list[dict]:
    fut = _make_fut()
    await _queue.put((_FETCH_ALL, sql, params, fut))
    return await fut


async def fetchone(sql: str, params: tuple = ()) -> dict | None:
    fut = _make_fut()
    await _queue.put((_FETCH_ONE, sql, params, fut))
    return await fut


async def execute(sql: str, params: tuple = ()) -> None:
    fut = _make_fut()
    await _queue.put((None, sql, params, fut))
    await fut


async def execute_nonblocking(sql: str, params: tuple = ()) -> bool:
    fut = _make_fut()
    try:
        _queue.put_nowait((None, sql, params, fut))
        return True
    except Exception:
        if not fut.done():
            fut.cancel()
        return False
