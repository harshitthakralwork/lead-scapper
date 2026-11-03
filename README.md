# Fieldlist — local business prospecting

A runnable app inspired by the supplied reference: search Google Maps by **niche + city**, find businesses with **no website link**, inspect public business details, and export CSV. It uses **Playwright browser automation, not a Maps/Places API**. No API key or paid data provider is required.

## What works

- Real Google Maps searches; no fabricated/sample results.
- Business name, category, public business phone, address, rating, review count when exposed, website URL, and a direct Maps link.
- “No website linked” filter, or view every checked business.
- Unique-place deduplication, live progress, cancellation, rating sort, and a detail panel.
- UTF-8 CSV export of the current view, with spreadsheet-formula injection protection.
- Persistent SQLite cache: complete searches are reusable for **7 days**, including smaller limits and either filter.
- A configurable demo allowance of **3 fresh attempts per rolling 24 hours**, shared across this installation. Cached searches do not count. Failed/cancelled fresh attempts still count.
- Responsive interface, keyboard-accessible controls, recent searches, and explicit error/partial-result states.

**Important:** Google sometimes serves a limited Maps view that does not expose review counts. Those fields remain blank/“Not available”; they are never guessed. Service-area businesses may have no public street address. A missing Maps website link does **not** establish that a business has no website elsewhere. Social/booking links count as linked websites.

## Run locally

Requires Python 3.11+ (tested with Python 3.13).

```bash
cd maps-prospector
python -m venv .venv

# macOS / Linux
source .venv/bin/activate
# Windows PowerShell instead: .venv\Scripts\Activate.ps1

pip install -r requirements.txt
python -m playwright install chromium
# If Linux reports missing browser libraries:
# python -m playwright install-deps chromium

python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Open **http://localhost:8000** in your browser. Enter a niche and a city with its state/country, then select **Find businesses**. Start with 10–20 listings to test your connection. A 40-listing search may take a minute or longer.

The server's own JSON endpoints are only for its UI and background jobs. They are not external data APIs. The scraper navigates the ordinary Maps website and reads rendered DOM elements.

## Run with Docker

```bash
docker build -t fieldlist .
docker run --rm -p 8000:8000 \
  -v fieldlist-data:/srv/fieldlist/data \
  --init --shm-size=1g fieldlist
```

Open http://localhost:8000. The image includes Chromium and its system dependencies. Keep the data volume to preserve cache and allowance across restarts. Run one application worker: job state is in memory and the demo is designed for a single instance.

## Configuration

Export environment variables before starting; `.env.example` is a reference, not an automatically loaded configuration file.

| Variable | Default | Meaning |
|---|---:|---|
| `FIELDLIST_DB` | `./data/fieldlist.db` | SQLite path, relative to the working directory |
| `FRESH_SEARCH_LIMIT` | `3` | Fresh attempts per rolling 24 hours, per installation |
| `CACHE_DAYS` | `7` | Complete-search cache lifetime |
| `SCRAPE_TIMEOUT_SECONDS` | `240` | Overall extraction budget; partial verified results may be returned |

To disable the demo allowance for your own private installation, set `FRESH_SEARCH_LIMIT` to a suitable larger number. The current implementation treats `0` as zero remaining searches, not unlimited. This is **not a billing/authentication system**.

## How the scraper works

1. Open `google.com/maps/search/<niche in city>/?hl=en` in Chromium.
2. Scroll the public results feed and collect unique business-profile URLs.
3. Open each profile and read its rendered fields.
4. Mark website status as `linked`, `missing`, or `unknown`.
5. Exclude unverified/unknown profiles from lead results. Never treat a loading failure as “no website.”
6. Cache only complete, verified extractions. Partial runs can be viewed/exported but are not saved as complete searches.

The main selectors live in `app/scraper.py`. Google can change them. The app uses ordinary browser selectors and does not solve CAPTCHAs, rotate identities/proxies, or bypass access controls. Images, media, and fonts are skipped to reduce bandwidth; page scripts and styles still load.

## Project structure

```text
app/
  main.py          FastAPI app, validation, background jobs, cancellation
  scraper.py       Playwright navigation and public-page extraction
  storage.py       SQLite cache and demo allowance
  static/
    index.html     Accessible app interface
    styles.css     Responsive styling; no external assets
    app.js         Search UI, progress, filtering, details, CSV
tests/
  test_helpers.py  Parsing, tri-state website logic, cache and quota tests
  test_jobs.py     Background progress, cancellation, failure and empty-cache tests
requirements.txt
Dockerfile
.dockerignore
.env.example
```

## Test

```bash
pip install pytest
python -m pytest -q
node --check app/static/app.js  # optional, if Node is installed
```

Unit tests do not contact Google. A live browser smoke test requires normal Google Maps access from the machine running the app.

## Verified in this workspace

- 13 automated tests passed (parsing, website tri-state, cache reuse, quota, job progress/cancel/failure, empty-result caching).
- A live Google Maps search inspected 40 electricians in Madison, WI and returned 4 profiles with no website link at the time of the test.
- Cached reload, all/missing filters, 40-row CSV export, rating sort, detail/help dialogs, recent searches, and a 390px mobile viewport passed browser checks with no JavaScript errors.
- Google's limited view did not expose review counts in that live test, so those cells were intentionally left blank.

## Limitations and responsible use

- **No reliability guarantee:** this is browser automation, not a supported Google data feed. Layout changes, consent screens, limited views, rate limits, and network restrictions can reduce or stop results.
- **Not an exhaustive census:** the selected limit is the maximum number of listings inspected, not a guaranteed number of missing-website leads. Maps ranking and location affect what is returned.
- **Terms and privacy:** automated collection may be restricted by Google's terms. Review the terms and laws applicable to your use. Use public business information responsibly, verify it before outreach, suppress personal/residential information, and follow applicable privacy, do-not-call, and marketing rules.
- **Not production multi-tenant SaaS:** before selling access, add authentication, per-account quotas, billing if desired, a durable distributed job queue, monitoring, abuse controls, and appropriate authorization. Do not expose this unauthenticated demo as a public production service.
- **Hosting:** use a container/VPS that supports Chromium and long-running jobs. A short-lived serverless function is a poor fit. A production deployment also needs HTTPS and an appropriate browser sandbox/isolation configuration.
- **Data retention:** cached searches and attempt timestamps are stored locally in SQLite. Deleting the database clears them. Establish a retention/deletion policy before a public launch.

No affiliation with Google. “Google Maps” identifies the source of the public listings.
