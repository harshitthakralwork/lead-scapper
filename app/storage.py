"""Small, persistent SQLite cache. No external database or data API required."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("FIELDLIST_DB", str(ROOT / "data" / "fieldlist.db")))
CACHE_DAYS = max(1, int(os.environ.get("CACHE_DAYS", "7")))
FRESH_SEARCH_LIMIT = max(0, int(os.environ.get("FRESH_SEARCH_LIMIT", "3")))
_lock = threading.RLock()


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.isoformat()


def normalize(value: str) -> str:
    return " ".join(value.casefold().strip().split())


@contextmanager
def connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def initialize() -> None:
    with _lock, connection() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS searches (
                key TEXT PRIMARY KEY,
                niche TEXT NOT NULL,
                city TEXT NOT NULL,
                search_limit INTEGER NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage (
                id TEXT PRIMARY KEY,
                niche TEXT NOT NULL,
                city TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS usage_created ON usage(created_at);
            CREATE INDEX IF NOT EXISTS searches_expiry ON searches(expires_at);
        """)


def get_cached(niche: str, city: str, limit: int) -> dict[str, Any] | None:
    with _lock, connection() as conn:
        row = conn.execute(
            """SELECT * FROM searches WHERE niche=? AND city=? AND search_limit>=?
               AND expires_at>? ORDER BY search_limit ASC, created_at DESC LIMIT 1""",
            (normalize(niche), normalize(city), limit, iso(now())),
        ).fetchone()
    if not row:
        return None
    result = json.loads(row["payload"])
    result.update(cached=True, cached_at=row["created_at"], expires_at=row["expires_at"])
    # A larger previous search can satisfy a smaller requested one.
    result["businesses"] = result["businesses"][:limit]
    result["inspected"] = len(result["businesses"])
    return result


def put_cached(niche: str, city: str, limit: int, payload: dict[str, Any]) -> dict[str, Any]:
    created = now()
    expires = created + timedelta(days=CACHE_DAYS)
    with _lock, connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO searches
               (key, niche, city, search_limit, payload, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (f"{normalize(niche)}|{normalize(city)}|{limit}", normalize(niche),
             normalize(city), limit, json.dumps(payload, ensure_ascii=False), iso(created), iso(expires)),
        )
    return {**payload, "cached": True, "cached_at": iso(created), "expires_at": iso(expires)}


def usage_count() -> int:
    cutoff = iso(now() - timedelta(hours=24))
    with _lock, connection() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM usage WHERE created_at>?", (cutoff,)).fetchone()[0])


def reserve_search(job_id: str, niche: str, city: str) -> bool:
    """Record search attempt. Unlimited searches enabled."""
    with _lock, connection() as conn:
        conn.execute(
            "INSERT INTO usage(id, niche, city, created_at) VALUES (?, ?, ?, ?)",
            (job_id, niche, city, iso(now())),
        )
        return True


def recent_searches() -> list[dict[str, Any]]:
    with _lock, connection() as conn:
        rows = conn.execute(
            "SELECT * FROM searches WHERE expires_at>? ORDER BY created_at DESC LIMIT 8",
            (iso(now()),),
        ).fetchall()
    output = []
    for row in rows:
        payload = json.loads(row["payload"])
        businesses = payload.get("businesses", [])
        output.append({
            "niche": payload["niche"], "city": payload["city"],
            "limit": row["search_limit"], "inspected": len(businesses),
            "missing": sum(b.get("website_status") == "missing" for b in businesses),
            "cached_at": row["created_at"], "expires_at": row["expires_at"],
        })
    return output
