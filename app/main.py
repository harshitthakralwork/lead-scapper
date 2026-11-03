"""Same-origin web app and background job coordinator for Fieldlist."""
from __future__ import annotations

import asyncio
import logging
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

if sys.platform == "win32":
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except Exception:
        pass

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import storage
from .scraper import ScrapeError, scrape_maps

logger = logging.getLogger("fieldlist")
STATIC = Path(__file__).resolve().parent / "static"
jobs: dict[str, dict[str, Any]] = {}
tasks: dict[str, asyncio.Task] = {}
cancel_events: dict[str, asyncio.Event] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.initialize()
    yield
    for task in tasks.values():
        task.cancel()
    await asyncio.gather(*tasks.values(), return_exceptions=True)


app = FastAPI(title="Fieldlist", version="1.0.0", lifespan=lifespan,
              docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.middleware("http")
async def response_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    # No X-Frame-Options: the workspace's authenticated preview uses an iframe.
    return response


class SearchInput(BaseModel):
    niche: str = Field(min_length=2, max_length=100)
    city: str = Field(min_length=2, max_length=120)
    limit: Literal[10, 20, 40, 60] = 40
    only_missing: bool = True

    @field_validator("niche", "city")
    @classmethod
    def clean_query(cls, value: str) -> str:
        value = " ".join(value.strip().split())
        if len(value) < 2:
            raise ValueError("Please enter at least two characters.")
        if any(ord(character) < 32 for character in value):
            raise ValueError("Please use a single-line search term.")
        return value


def result_view(data: dict[str, Any], only_missing: bool) -> dict[str, Any]:
    """Send every verified row; the client can change filters without another search."""
    businesses = data.get("businesses", [])
    missing = sum(item["website_status"] == "missing" for item in businesses)
    return {
        **data,
        "businesses": businesses,
        "inspected": len(businesses), "missing": missing,
        "with_website": len(businesses) - missing,
        "only_missing": only_missing,  # Initial client-side view preference.
        "cache_days": storage.CACHE_DAYS,
    }


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    output = {key: value for key, value in job.items() if key not in {"data", "only_missing"}}
    if job.get("data") is not None:
        output["result"] = result_view(job["data"], job["only_missing"])
    return output


def active_job() -> bool:
    return any(job["status"] in {"queued", "running"} for job in jobs.values())


def prune_jobs() -> None:
    cutoff = datetime.now(timezone.utc).timestamp() - 3600
    for job_id, job in list(jobs.items()):
        if job["status"] not in {"queued", "running"} and job["created_timestamp"] < cutoff:
            jobs.pop(job_id, None)
            tasks.pop(job_id, None)
            cancel_events.pop(job_id, None)


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/status")
async def status():
    used = storage.usage_count()
    return {
        "ok": True, "source": "Google Maps public pages", "mode": "unlimited",
        "fresh_limit": 999999, "unlimited": True, "fresh_used": used,
        "fresh_remaining": "Unlimited",
        "quota_window_hours": None, "cache_days": storage.CACHE_DAYS,
        "busy": active_job(),
    }


@app.get("/api/history")
async def history():
    return {"searches": storage.recent_searches()}


@app.post("/api/search")
async def search(body: SearchInput):
    prune_jobs()
    cached = storage.get_cached(body.niche, body.city, body.limit)
    if cached:
        return {"kind": "cached", "result": result_view(cached, body.only_missing)}
    if active_job():
        raise HTTPException(409, "A search is already running. Let it finish or cancel it first.")
    job_id = uuid.uuid4().hex
    storage.reserve_search(job_id, body.niche, body.city)
    created = datetime.now(timezone.utc)
    job = {
        "id": job_id, "status": "queued", "stage": "queued",
        "message": "Waiting for the browser…", "niche": body.niche, "city": body.city,
        "limit": body.limit, "only_missing": body.only_missing,
        "created_at": created.isoformat(), "created_timestamp": created.timestamp(),
        "checked": 0, "total": body.limit, "found": 0, "verified": 0,
        "data": None, "error": None,
    }
    jobs[job_id] = job
    cancel_events[job_id] = asyncio.Event()
    tasks[job_id] = asyncio.create_task(run_search(job_id))
    return JSONResponse({"kind": "job", "job": public_job(job)}, status_code=202)


async def run_search(job_id: str) -> None:
    job = jobs[job_id]
    cancelled = cancel_events[job_id]

    async def on_progress(values: dict[str, Any]) -> None:
        if cancelled.is_set():
            raise asyncio.CancelledError
        updates = dict(values)
        if "inspected" in updates:
            updates["checked"] = updates.pop("inspected")
        job.update(updates)

    try:
        job.update(status="running", stage="opening", message="Starting the browser…")
        data = await scrape_maps(job["niche"], job["city"], job["limit"],
                                 progress=on_progress, cancelled=cancelled)
        # Incomplete/challenged runs remain exportable but are not cached as complete.
        if data["complete"] and not data["unverified"] and data.get("attempted", 0) >= data["inspected"]:
            data = storage.put_cached(job["niche"], job["city"], job["limit"], data)
        else:
            data = {**data, "cached": False, "cached_at": datetime.now(timezone.utc).isoformat()}
        job.update(status="completed", stage="finished", message="Search complete", data=data,
                   checked=data.get("attempted", data["inspected"]), verified=data["inspected"])
    except asyncio.CancelledError:
        job.update(status="cancelled", stage="cancelled", message="Search cancelled. No sample data was substituted.")
    except ScrapeError as exc:
        job.update(status="failed", stage="failed", message="Search could not finish",
                   error={"code": exc.code, "message": str(exc)})
        logger.warning("Search %s failed: %s (%s)", job_id, exc, exc.code)
    except Exception:
        logger.exception("Unexpected search error for %s", job_id)
        job.update(status="failed", stage="failed", message="Search could not finish",
                   error={"code": "internal", "message": "Something went wrong while reading Maps. Please try again later."})


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "This search is no longer in memory. Run it again; a completed search may still be cached.")
    return public_job(job)


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Search not found.")
    if job["status"] in {"queued", "running"}:
        cancel_events[job_id].set()
        job.update(status="cancelling", message="Stopping after the current page…")
    return public_job(job)


# ==========================================================================
# SparkXFlow Pro Extensions: Metrics, Lead Management, Lists, Website Audit
# ==========================================================================

class SaveLeadInput(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1)
    category: str = ""
    phone: str = ""
    address: str = ""
    website: str = ""
    website_status: str = "unknown"
    rating: float | None = None
    reviews: int | None = None
    maps_url: str = ""
    plus_code: str = ""
    hours: str = ""
    is_claimed: bool = True
    status: str = "New"
    list_name: str = "General"
    notes: str = ""
    tags: list[str] = []


class UpdateLeadInput(BaseModel):
    status: str | None = None
    list_name: str | None = None
    notes: str | None = None
    tags: list[str] | None = None
    phone: str | None = None
    website: str | None = None
    address: str | None = None


class CreateListInput(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = ""


class AuditInput(BaseModel):
    url: str = Field(min_length=3, max_length=500)


@app.get("/api/metrics")
async def get_metrics():
    return storage.get_platform_metrics()


@app.get("/api/leads")
async def get_leads(
    status: str | None = Query(None),
    list_name: str | None = Query(None),
    search: str | None = Query(None),
):
    leads = storage.get_saved_leads(status=status, list_name=list_name, search=search)
    return {"leads": leads, "total": len(leads)}


@app.post("/api/leads")
async def save_lead(body: SaveLeadInput):
    data = body.model_dump()
    saved = storage.save_lead(data)
    return {"ok": True, "lead": saved}


@app.patch("/api/leads/{lead_id}")
async def update_lead(lead_id: str, body: UpdateLeadInput):
    updates = body.model_dump(exclude_unset=True)
    updated = storage.update_saved_lead(lead_id, updates)
    if not updated:
        raise HTTPException(404, "Lead not found.")
    return {"ok": True, "lead": updated}


@app.delete("/api/leads/{lead_id}")
async def delete_lead(lead_id: str):
    success = storage.delete_saved_lead(lead_id)
    if not success:
        raise HTTPException(404, "Lead not found.")
    return {"ok": True}


@app.get("/api/lists")
async def get_lists():
    return {"lists": storage.get_lead_lists()}


@app.post("/api/lists")
async def create_list(body: CreateListInput):
    created = storage.create_lead_list(body.name, body.description)
    return {"ok": True, "list": created}


@app.delete("/api/lists/{name}")
async def delete_list(name: str):
    if name == "General":
        raise HTTPException(400, "Cannot delete default General list.")
    deleted = storage.delete_lead_list(name)
    if not deleted:
        raise HTTPException(404, "List not found.")
    return {"ok": True}


@app.post("/api/audit")
async def run_audit(body: AuditInput):
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    parsed = urlparse(url)
    if not parsed.netloc:
        raise HTTPException(400, "Please provide a valid website address.")

    audit_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc).isoformat()
    t0 = time.monotonic()

    status_code = 0
    resp_time_ms = 0
    is_https = parsed.scheme == "https"
    title = ""
    meta_desc = ""
    has_viewport = False
    has_h1 = False
    findings = []
    recommendations = []

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 SparkXFlow/2.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, verify=False) as client:
            resp = await client.get(url, headers=headers)
            resp_time_ms = round((time.monotonic() - t0) * 1000)
            status_code = resp.status_code
            is_https = str(resp.url).startswith("https://")
            html = resp.text[:150000]

            title_m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
            title = " ".join(title_m.group(1).split()) if title_m else ""

            desc_m = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\'](.*?)["\']', html, re.I | re.S)
            if not desc_m:
                desc_m = re.search(r'<meta[^>]*content=["\'](.*?)["\'][^>]*name=["\']description["\']', html, re.I | re.S)
            meta_desc = " ".join(desc_m.group(1).split()) if desc_m else ""

            has_viewport = bool(re.search(r'<meta[^>]*name=["\']viewport["\']', html, re.I))
            has_h1 = bool(re.search(r'<h1[^>]*>.*?</h1>', html, re.I | re.S))

            if status_code >= 400:
                findings.append(f"HTTP error status code {status_code} returned by web server.")
                recommendations.append("Fix server errors or broken redirects immediately to restore customer access.")
            else:
                findings.append(f"Server is responding with HTTP {status_code} OK ({resp_time_ms}ms).")

            if resp_time_ms > 1400:
                findings.append(f"High server latency detected ({resp_time_ms}ms).")
                recommendations.append("Upgrade hosting or implement CDN caching; slow load times drive away mobile leads.")
            else:
                findings.append(f"Fast initial server response ({resp_time_ms}ms).")

            if is_https:
                findings.append("SSL encryption active (HTTPS).")
            else:
                findings.append("Insecure connection (HTTP only).")
                recommendations.append("Install an SSL certificate to eliminate browser 'Not Secure' warnings.")

            if has_viewport:
                findings.append("Mobile viewport meta tag configured.")
            else:
                findings.append("Missing mobile viewport configuration.")
                recommendations.append("Site may render poorly on smartphones; pitch responsive mobile redesign.")

            if meta_desc:
                findings.append("Search engine meta description tag present.")
            else:
                findings.append("Missing search engine meta description.")
                recommendations.append("Add a compelling meta description to improve Google Search click-through rates.")

            if not has_h1:
                findings.append("No primary H1 heading detected in initial HTML.")
                recommendations.append("Structure page with clear H1 headings matching local search terms.")

    except httpx.ConnectTimeout:
        resp_time_ms = round((time.monotonic() - t0) * 1000)
        findings.append("Connection timed out after 10 seconds.")
        recommendations.append("Website server is unresponsive; pitch reliable modern web hosting.")
    except Exception as exc:
        err_msg = str(exc).splitlines()[0] if str(exc) else "Server unreachable"
        findings.append(f"Connection diagnostic note: {err_msg}")
        recommendations.append("Domain may be parked or misconfigured. Excellent prospect for a fresh web build.")

    audit_record = {
        "id": audit_id,
        "url": url,
        "status_code": status_code,
        "response_time_ms": resp_time_ms,
        "is_https": is_https,
        "title": title,
        "meta_description": meta_desc,
        "has_viewport": has_viewport,
        "has_h1": has_h1,
        "findings": findings,
        "recommendations": recommendations,
        "created_at": created_at,
    }
    storage.save_website_audit(audit_record)
    return audit_record


@app.get("/api/audits")
async def get_audits():
    return {"audits": storage.get_recent_audits(limit=12)}
