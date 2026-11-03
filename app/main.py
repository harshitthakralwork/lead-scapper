"""Same-origin web app and background job coordinator for Fieldlist."""
from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
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
