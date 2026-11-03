"""Read public Google Maps UI with Playwright. No Places API, API keys, or CAPTCHA bypass.

Google can change its DOM or challenge automated traffic. Unknown website status is
never treated as a missing website. A successful extraction is not guaranteed.
"""
from __future__ import annotations

import asyncio
import math
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from urllib.parse import quote, urlparse

from playwright.async_api import Browser, Page, TimeoutError as PlaywrightTimeout, async_playwright

ProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]
MAX_RUNTIME = int(os.environ.get("SCRAPE_TIMEOUT_SECONDS", "240"))

LISTINGS_JS = r"""
() => {
  const feed = document.querySelector('div[role="feed"]');
  if (!feed) return [];
  const links = feed.querySelectorAll('a[href*="/maps/place/"]');
  return Array.from(links).map(a => ({
    name: (a.getAttribute('aria-label') || a.textContent || '').trim(),
    url: a.href
  })).filter(x => x.name && x.url);
}
"""

DETAIL_JS = r"""
() => {
  const roots = Array.from(document.querySelectorAll('[role="main"]'));
  const root = roots.reverse().find(el => el.querySelector('h1')) || document;
  const q = selector => root.querySelector(selector);
  const text = selector => (q(selector)?.textContent || '').trim();
  const label = selector => (q(selector)?.getAttribute('aria-label') || '').trim();
  const website = q('a[data-item-id="authority"]') || q('a[aria-label^="Website:"]');
  const addressNode = q('button[data-item-id="address"]');
  const phoneNode = q('button[data-item-id^="phone:tel:"]');
  const share = q('button[data-value="Share"]') || q('button[aria-label^="Share"]') || q('[data-item-id="share"]');
  const ratingLabels = Array.from(q('.F7nice')?.querySelectorAll('[aria-label]') || []).map(el => el.getAttribute('aria-label'));
  const reviewLabel = ratingLabels.find(value => /\breviews?\b/i.test(value)) || label('button[jsaction*="review"]')
    || Array.from(q('.F7nice')?.querySelectorAll('span') || []).map(el => el.textContent.trim()).find(value => /^\(\d[\d,]*\)$/.test(value));
  const ratingNode = q('.F7nice span[aria-hidden="true"]');
  return {
    name: text('h1'),
    website: website?.href || '',
    address: addressNode?.getAttribute('aria-label') || addressNode?.textContent || '',
    phone: phoneNode?.getAttribute('aria-label') || phoneNode?.textContent || '',
    category: text('button[jsaction*="category"]'),
    rating_text: ratingNode?.textContent || '',
    reviews_text: reviewLabel,
    profile_ready: Boolean(website || addressNode || phoneNode || share)
  };
}
"""


class ScrapeError(Exception):
    def __init__(self, message: str, code: str = "unavailable"):
        super().__init__(message)
        self.code = code


def clean_label(value: str, prefix: str) -> str:
    return re.sub(rf"^\s*{re.escape(prefix)}\s*:\s*", "", value or "", flags=re.I).strip()


def parse_rating(value: str) -> float | None:
    match = re.search(r"\d+(?:[.,]\d+)?", value or "")
    if not match:
        return None
    rating = float(match.group().replace(",", "."))
    return rating if 0 <= rating <= 5 else None


def parse_reviews(value: str) -> int | None:
    value = (value or "").strip().replace(",", "").replace("\u00a0", " ")
    match = re.search(r"(\d+(?:\.\d+)?)\s*([km])?\s*reviews?", value, re.I)
    if not match:
        match = re.fullmatch(r"\(?\s*(\d+(?:\.\d+)?)\s*([km])?\s*\)?", value, re.I)
    if not match:
        return None
    multiplier = {"k": 1_000, "m": 1_000_000}.get((match.group(2) or "").lower(), 1)
    return int(float(match.group(1)) * multiplier)


def place_key(url: str) -> str:
    match = re.search(r"!1s(0x[0-9a-f]+:0x[0-9a-f]+)", url, re.I)
    if match:
        return match.group(1).lower()
    parsed = urlparse(url)
    return parsed.path.split("/data=")[0].rstrip("/")


def public_http_url(value: str) -> str:
    try:
        parsed = urlparse(value)
        if parsed.scheme in {"http", "https"} and parsed.hostname:
            return value
    except ValueError:
        pass
    return ""


def clean_maps_url(value: str) -> str:
    # Keep the public place data, but discard session/click tracking parameters.
    return value.split("?", 1)[0] + "?hl=en"


def normalize_name(value: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", "", value.casefold()).split())


def extract_business(listing: dict[str, str], detail: dict[str, Any], source_url: str) -> dict[str, Any] | None:
    name = (detail.get("name") or listing.get("name") or "").strip()
    expected = normalize_name(listing.get("name", ""))
    actual = normalize_name(detail.get("name", ""))
    # Do not accidentally read the search page or a previous profile.
    if not actual or (expected and expected not in actual and actual not in expected):
        return None
    website = public_http_url(detail.get("website", ""))
    ready = bool(detail.get("profile_ready"))
    status = "linked" if website else ("missing" if ready else "unknown")
    return {
        "id": place_key(source_url),
        "name": name,
        "category": (detail.get("category") or "").strip(),
        "phone": clean_label(detail.get("phone", ""), "Phone"),
        "address": clean_label(detail.get("address", ""), "Address"),
        "rating": parse_rating(detail.get("rating_text", "")),
        "reviews": parse_reviews(detail.get("reviews_text", "")),
        "website": website,
        "website_status": status,
        "maps_url": clean_maps_url(source_url),
        "observed_at": datetime.now(timezone.utc).isoformat(),
    }


async def _progress(callback: ProgressCallback | None, **values: Any) -> None:
    if callback:
        await callback(values)


def _check_cancel(cancelled: asyncio.Event | None) -> None:
    if cancelled and cancelled.is_set():
        raise asyncio.CancelledError


async def _consent(page: Page) -> None:
    # Only interact with a normal consent dialog; never solve or bypass a challenge.
    if "consent.google" not in page.url and await page.locator('button[aria-label="Reject all"]').count() == 0:
        return
    for name in ("Reject all", "Accept all", "Alle ablehnen", "Tout refuser"):
        button = page.get_by_role("button", name=name, exact=True)
        if await button.count() and await button.first.is_visible():
            await button.first.click(timeout=5000)
            await page.wait_for_timeout(1200)
            return


async def _blocked(page: Page) -> bool:
    if "/sorry/" in page.url or "google.com/sorry" in page.url:
        return True
    if await page.locator("form#captcha-form").count():
        return True
    title = (await page.title()).lower()
    return title in {"sorry", "unusual traffic", "captcha"}


async def _guard(page: Page) -> None:
    if await _blocked(page):
        raise ScrapeError(
            "Google presented an automated-traffic challenge. No results were invented. "
            "Try again later; this network may not permit automated browsing.", "blocked"
        )


async def _new_page(browser: Browser) -> Page:
    context = await browser.new_context(
        locale="en-US", viewport={"width": 1440, "height": 1000},
        reduced_motion="reduce", service_workers="block",
    )
    page = await context.new_page()
    page.set_default_timeout(12000)
    # Keep layout and scripts, but avoid downloading photographs, fonts and video.
    await page.route("**/*", lambda route: route.abort()
                     if route.request.resource_type in {"image", "media", "font"} else route.continue_())
    return page


async def _collect_listings(page: Page, query: str, limit: int, cancelled: asyncio.Event | None,
                            callback: ProgressCallback | None, deadline: float) -> tuple[list[dict[str, str]], bool]:
    url = "https://www.google.com/maps/search/" + quote(query, safe="") + "/?hl=en"
    await _progress(callback, stage="opening", message="Opening Google Maps…")
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=40000)
        await _consent(page)
        await _guard(page)
        await page.wait_for_selector('div[role="feed"]', timeout=20000)
    except PlaywrightTimeout:
        await _guard(page)
        # A very specific query can redirect straight to a single public profile.
        if "/maps/place/" in page.url:
            try:
                await page.wait_for_selector('[role="main"] h1', timeout=5000)
                name = (await page.locator('[role="main"] h1').last.inner_text()).strip()
                if name and name.casefold() != "results":
                    return [{"name": name, "url": page.url}], True
            except PlaywrightTimeout:
                pass
        body = (await page.locator("body").inner_text())[:10000].lower()
        if "no results found" in body or "no results for" in body:
            return [], True
        raise ScrapeError(
            "Google Maps did not expose a readable results list. The page may have changed, "
            "or this network cannot load Maps. Try a more specific city later.", "layout"
        )

    unique: dict[str, dict[str, str]] = {}
    stale_rounds = 0
    exhausted = False
    for _ in range(max(12, math.ceil(limit / 3))):
        _check_cancel(cancelled)
        await _guard(page)
        previous = len(unique)
        for item in await page.evaluate(LISTINGS_JS):
            key = place_key(item["url"])
            if key and key not in unique:
                unique[key] = item
        await _progress(callback, stage="collecting", found=len(unique),
                        message=f"Collecting listings · {len(unique)} found")
        if len(unique) >= limit:
            break
        if time.monotonic() >= deadline:
            break
        state = await page.locator('div[role="feed"]').evaluate("""el => {
          const end = /You've reached the end of the list|Das Ende der Liste erreicht/i.test(el.innerText);
          const before = el.scrollTop;
          el.scrollBy(0, Math.max(500, el.clientHeight - 100));
          return {end, moved: el.scrollTop !== before};
        }""")
        exhausted = bool(state["end"])
        if exhausted:
            break
        await page.wait_for_timeout(1000)
        stale_rounds = stale_rounds + 1 if len(unique) == previous and not state["moved"] else 0
        if stale_rounds >= 5:
            break
    return list(unique.values())[:limit], exhausted


async def scrape_maps(niche: str, city: str, limit: int = 40, *,
                      progress: ProgressCallback | None = None,
                      cancelled: asyncio.Event | None = None) -> dict[str, Any]:
    """Inspect at most `limit` unique listings, then let the caller filter the results."""
    browser = None
    started = time.monotonic()
    deadline = started + MAX_RUNTIME
    businesses: list[dict[str, Any]] = []
    unverified = 0
    inspected = 0
    complete = False
    notice = ""
    try:
        async with async_playwright() as playwright:
            try:
                browser = await playwright.chromium.launch(
                    headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"],
                    timeout=30000,
                )
            except Exception as exc:
                raise ScrapeError(
                    "The browser could not start. Install it with: python -m playwright install chromium. "
                    "On Linux, missing system libraries may require playwright install-deps chromium."
                ) from exc
            page = await _new_page(browser)
            listings, exhausted = await _collect_listings(page, f"{niche} in {city}", limit, cancelled, progress, deadline)
            if not listings:
                return {"niche": niche, "city": city, "businesses": [], "inspected": 0,
                        "attempted": 0, "unverified": 0, "complete": True,
                        "notice": "No matching listings were found.",
                        "elapsed_seconds": round(time.monotonic() - started, 1)}
            detail_page = await _new_page(browser)
            for index, listing in enumerate(listings):
                _check_cancel(cancelled)
                if time.monotonic() >= deadline:
                    notice = "The time limit was reached. Only the profiles checked so far are shown."
                    break
                await _progress(callback=progress, stage="inspecting", inspected=index,
                                total=len(listings), verified=len(businesses),
                                message=f"Checking business profiles · {index + 1} of {len(listings)}")
                try:
                    await detail_page.goto(listing["url"], wait_until="domcontentloaded", timeout=20000)
                    await _guard(detail_page)
                    await detail_page.wait_for_selector('[role="main"] h1', timeout=12000)
                    try:
                        await detail_page.wait_for_function("""() => {
                          const root = Array.from(document.querySelectorAll('[role="main"]')).reverse().find(el => el.querySelector('h1'));
                          return root && root.querySelector('a[data-item-id="authority"], button[data-item-id="address"], button[data-item-id^="phone:tel:"], button[data-value="Share"], button[aria-label^="Share"]');
                        }""", timeout=5000)
                    except PlaywrightTimeout:
                        pass  # extract_business will mark this profile unknown, not missing.
                    detail = await detail_page.evaluate(DETAIL_JS)
                    business = extract_business(listing, detail, listing["url"])
                    if business:
                        businesses.append(business)
                    else:
                        unverified += 1
                except ScrapeError as exc:
                    if exc.code == "blocked":
                        notice = str(exc)
                        break
                    unverified += 1
                except PlaywrightTimeout:
                    if await _blocked(detail_page):
                        notice = "Google challenged the browser. Only profiles checked before the challenge are shown."
                        break
                    unverified += 1
                except Exception:
                    # A single changed/broken profile must not fabricate a lead or lose all others.
                    unverified += 1
                inspected = index + 1
                await _progress(progress, stage="inspecting", inspected=inspected,
                                total=len(listings), verified=len(businesses),
                                message=f"Checking business profiles · {inspected} of {len(listings)}")
                await detail_page.wait_for_timeout(1100)
            else:
                complete = len(listings) >= limit or exhausted
            if unverified:
                notice = (notice + f" {unverified} profile(s) could not be verified and were excluded.").strip()
            if not complete and not notice:
                notice = "Google did not expose the full requested list. These are partial results."
            if not businesses and not complete:
                raise ScrapeError(notice or "No business profiles could be verified. Please try again later.", "unverified")
            if businesses and all(item["reviews"] is None for item in businesses):
                notice = (notice + " Google's limited view did not expose review counts; those fields are left blank.").strip()
            return {
                "niche": niche, "city": city, "businesses": businesses,
                "inspected": len(businesses), "attempted": inspected,
                "unverified": unverified, "complete": complete, "notice": notice,
                "elapsed_seconds": round(time.monotonic() - started, 1),
            }
    except (asyncio.CancelledError, ScrapeError):
        raise
    except PlaywrightTimeout:
        raise ScrapeError("Google Maps took too long to respond. Please try again later.", "timeout")
    except Exception as exc:
        raise ScrapeError("Browser extraction failed. Google may be unavailable or may have changed its page layout.") from exc
    finally:
        if browser:
            await browser.close()


if __name__ == "__main__":
    import argparse
    import json
    parser = argparse.ArgumentParser(description="Inspect public Google Maps listings without an API.")
    parser.add_argument("--niche", required=True)
    parser.add_argument("--city", required=True)
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    async def report(values):
        print(values, flush=True)
    print(json.dumps(asyncio.run(scrape_maps(args.niche, args.city, args.limit, progress=report)), indent=2))
