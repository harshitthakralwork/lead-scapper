"""Small, persistent SQLite cache. No external database or data API required."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager, suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("FIELDLIST_DB", str(ROOT / "data" / "fieldlist.db")))
CACHE_DAYS = max(1, int(os.environ.get("CACHE_DAYS", "7")))
FRESH_SEARCH_LIMIT = max(0, int(os.environ.get("FRESH_SEARCH_LIMIT", "0")))
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
            CREATE TABLE IF NOT EXISTS saved_leads (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                category TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                address TEXT DEFAULT '',
                website TEXT DEFAULT '',
                website_status TEXT DEFAULT 'unknown',
                rating REAL,
                reviews INTEGER,
                maps_url TEXT DEFAULT '',
                plus_code TEXT DEFAULT '',
                hours TEXT DEFAULT '',
                is_claimed INTEGER DEFAULT 1,
                status TEXT DEFAULT 'New',
                list_name TEXT DEFAULT 'General',
                notes TEXT DEFAULT '',
                tags TEXT DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS lead_lists (
                name TEXT PRIMARY KEY,
                description TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS website_audits (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                status_code INTEGER,
                response_time_ms INTEGER,
                is_https INTEGER,
                title TEXT,
                meta_description TEXT,
                has_viewport INTEGER,
                has_h1 INTEGER,
                findings_json TEXT,
                recommendations_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS usage_created ON usage(created_at);
            CREATE INDEX IF NOT EXISTS searches_expiry ON searches(expires_at);
            CREATE INDEX IF NOT EXISTS idx_saved_leads_status ON saved_leads(status);
            CREATE INDEX IF NOT EXISTS idx_saved_leads_list ON saved_leads(list_name);
            CREATE INDEX IF NOT EXISTS idx_audits_created ON website_audits(created_at);
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
    """Record search attempt. Unlimited searches when FRESH_SEARCH_LIMIT is 0."""
    with _lock, connection() as conn:
        if FRESH_SEARCH_LIMIT > 0:
            cutoff = iso(now() - timedelta(hours=24))
            count = int(conn.execute("SELECT COUNT(*) FROM usage WHERE created_at>?", (cutoff,)).fetchone()[0])
            if count >= FRESH_SEARCH_LIMIT:
                return False
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


def save_lead(lead: dict[str, Any]) -> dict[str, Any]:
    """Save or update a lead in saved_leads table."""
    lead_id = lead.get("id") or normalize(lead.get("name", "")) + "|" + normalize(lead.get("phone", ""))
    t = iso(now())
    with _lock, connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO saved_leads
               (id, name, category, phone, address, website, website_status, rating, reviews,
                maps_url, plus_code, hours, is_claimed, status, list_name, notes, tags, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                       COALESCE((SELECT created_at FROM saved_leads WHERE id=?), ?), ?)""",
            (
                lead_id,
                lead.get("name", "").strip(),
                lead.get("category", "").strip(),
                lead.get("phone", "").strip(),
                lead.get("address", "").strip(),
                lead.get("website", "").strip(),
                lead.get("website_status", "unknown"),
                lead.get("rating"),
                lead.get("reviews"),
                lead.get("maps_url", ""),
                lead.get("plus_code", ""),
                lead.get("hours", ""),
                1 if lead.get("is_claimed", True) else 0,
                lead.get("status", "New"),
                lead.get("list_name", "General"),
                lead.get("notes", ""),
                json.dumps(lead.get("tags", [])),
                lead_id, t, t
            )
        )
    return get_saved_lead(lead_id) or lead


def get_saved_lead(lead_id: str) -> dict[str, Any] | None:
    with _lock, connection() as conn:
        row = conn.execute("SELECT * FROM saved_leads WHERE id=?", (lead_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["is_claimed"] = bool(d.get("is_claimed", 1))
    with suppress(Exception):
        d["tags"] = json.loads(d.get("tags") or "[]")
    return d


def get_saved_leads(status: str | None = None, list_name: str | None = None, search: str | None = None) -> list[dict[str, Any]]:
    query = "SELECT * FROM saved_leads WHERE 1=1"
    params: list[Any] = []
    if status and status != "all":
        query += " AND status=?"
        params.append(status)
    if list_name and list_name != "all":
        query += " AND list_name=?"
        params.append(list_name)
    if search:
        query += " AND (name LIKE ? OR category LIKE ? OR address LIKE ? OR phone LIKE ?)"
        term = f"%{search.strip()}%"
        params.extend([term, term, term, term])
    query += " ORDER BY updated_at DESC"
    
    with _lock, connection() as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
    output = []
    for row in rows:
        d = dict(row)
        d["is_claimed"] = bool(d.get("is_claimed", 1))
        with suppress(Exception):
            d["tags"] = json.loads(d.get("tags") or "[]")
        output.append(d)
    return output


def update_saved_lead(lead_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"status", "list_name", "notes", "tags", "phone", "website", "address"}
    filtered = {k: v for k, v in updates.items() if k in allowed}
    if not filtered:
        return get_saved_lead(lead_id)
    if "tags" in filtered and isinstance(filtered["tags"], (list, set)):
        filtered["tags"] = json.dumps(list(filtered["tags"]))
    filtered["updated_at"] = iso(now())

    set_clause = ", ".join(f"{k}=?" for k in filtered.keys())
    values = list(filtered.values()) + [lead_id]

    with _lock, connection() as conn:
        conn.execute(f"UPDATE saved_leads SET {set_clause} WHERE id=?", tuple(values))
    return get_saved_lead(lead_id)


def delete_saved_lead(lead_id: str) -> bool:
    with _lock, connection() as conn:
        cursor = conn.execute("DELETE FROM saved_leads WHERE id=?", (lead_id,))
        return cursor.rowcount > 0


def get_lead_lists() -> list[dict[str, Any]]:
    with _lock, connection() as conn:
        # Default 'General' list if table empty
        rows = conn.execute("""
            SELECT l.name, l.description, l.created_at, COUNT(s.id) as lead_count, COUNT(s.id) as count
            FROM lead_lists l
            LEFT JOIN saved_leads s ON s.list_name = l.name
            GROUP BY l.name
            ORDER BY l.created_at ASC
        """).fetchall()
        if not rows:
            conn.execute("INSERT OR IGNORE INTO lead_lists (name, description, created_at) VALUES ('General', 'Default leads list', ?)", (iso(now()),))
            rows = conn.execute("""
                SELECT l.name, l.description, l.created_at, COUNT(s.id) as lead_count, COUNT(s.id) as count
                FROM lead_lists l
                LEFT JOIN saved_leads s ON s.list_name = l.name
                GROUP BY l.name
            """).fetchall()
    return [dict(r) for r in rows]


def create_lead_list(name: str, description: str = "") -> dict[str, Any]:
    name = " ".join(name.strip().split())
    with _lock, connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO lead_lists (name, description, created_at) VALUES (?, ?, ?)",
            (name, description.strip(), iso(now()))
        )
    return {"name": name, "description": description.strip(), "count": 0}


def delete_lead_list(name: str) -> bool:
    if name == "General":
        return False
    with _lock, connection() as conn:
        conn.execute("UPDATE saved_leads SET list_name='General' WHERE list_name=?", (name,))
        cursor = conn.execute("DELETE FROM lead_lists WHERE name=?", (name,))
        return cursor.rowcount > 0


def save_website_audit(audit: dict[str, Any]) -> dict[str, Any]:
    with _lock, connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO website_audits
               (id, url, status_code, response_time_ms, is_https, title, meta_description,
                has_viewport, has_h1, findings_json, recommendations_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                audit["id"], audit["url"], audit.get("status_code", 0),
                audit.get("response_time_ms", 0), 1 if audit.get("is_https") else 0,
                audit.get("title", ""), audit.get("meta_description", ""),
                1 if audit.get("has_viewport") else 0, 1 if audit.get("has_h1") else 0,
                json.dumps(audit.get("findings", [])),
                json.dumps(audit.get("recommendations", [])),
                audit.get("created_at", iso(now()))
            )
        )
    return audit


def get_recent_audits(limit: int = 10) -> list[dict[str, Any]]:
    with _lock, connection() as conn:
        rows = conn.execute("SELECT * FROM website_audits ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    output = []
    for r in rows:
        d = dict(r)
        d["is_https"] = bool(d.get("is_https"))
        d["has_viewport"] = bool(d.get("has_viewport"))
        d["has_h1"] = bool(d.get("has_h1"))
        with suppress(Exception):
            d["findings"] = json.loads(d.get("findings_json") or "[]")
        with suppress(Exception):
            d["recommendations"] = json.loads(d.get("recommendations_json") or "[]")
        output.append(d)
    return output


def get_platform_metrics() -> dict[str, Any]:
    with _lock, connection() as conn:
        searches_rows = conn.execute("SELECT payload FROM searches WHERE expires_at>?", (iso(now()),)).fetchall()
        total_discovered = 0
        missing_website = 0
        has_phone = 0
        categories = set()
        seen_ids = set()

        for (raw_payload,) in searches_rows:
            with suppress(Exception):
                p = json.loads(raw_payload)
                for b in p.get("businesses", []):
                    bid = b.get("id") or b.get("name")
                    if bid and bid not in seen_ids:
                        seen_ids.add(bid)
                        total_discovered += 1
                        if b.get("website_status") == "missing":
                            missing_website += 1
                        if b.get("phone"):
                            has_phone += 1
                        if b.get("category"):
                            categories.add(b.get("category"))

        saved_leads_count = int(conn.execute("SELECT COUNT(*) FROM saved_leads").fetchone()[0])
        audits_count = int(conn.execute("SELECT COUNT(*) FROM website_audits").fetchone()[0])
        usage_last_24h = int(conn.execute("SELECT COUNT(*) FROM usage WHERE created_at>?", (iso(now() - timedelta(hours=24)),)).fetchone()[0])

    return {
        "total_discovered": total_discovered,
        "missing_website": missing_website,
        "has_phone": has_phone,
        "saved_leads": saved_leads_count,
        "audits_performed": audits_count,
        "unique_categories": len(categories),
        "searches_last_24h": usage_last_24h,
        "opportunity_percentage": round((missing_website / total_discovered * 100), 1) if total_discovered else 0
    }
