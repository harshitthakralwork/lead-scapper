"""Job lifecycle tests with a fake scraper; these never contact Google."""
import asyncio

from app import main, storage
from app.scraper import ScrapeError


def test_progress_cancel_failure_and_empty_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, 'DB_PATH', tmp_path / 'jobs.db')
    monkeypatch.setattr(storage, 'FRESH_SEARCH_LIMIT', 3)
    storage.initialize()
    monkeypatch.setattr(main, 'jobs', {})
    monkeypatch.setattr(main, 'tasks', {})
    monkeypatch.setattr(main, 'cancel_events', {})

    async def scenario():
        async def slow_scraper(niche, city, limit, *, progress, cancelled):
            await progress({'stage': 'inspecting', 'inspected': 3, 'total': 10})
            while not cancelled.is_set():
                await asyncio.sleep(0.01)
            raise asyncio.CancelledError

        monkeypatch.setattr(main, 'scrape_maps', slow_scraper)
        await main.search(main.SearchInput(niche='Plumbers', city='Madison', limit=10))
        job_id = next(iter(main.jobs))
        await asyncio.sleep(0.04)
        assert main.jobs[job_id]['checked'] == 3
        await main.cancel_job(job_id)
        await main.tasks[job_id]
        assert main.jobs[job_id]['status'] == 'cancelled'

        async def failed_scraper(*args, **kwargs):
            raise ScrapeError('Test challenge', 'blocked')

        monkeypatch.setattr(main, 'scrape_maps', failed_scraper)
        await main.search(main.SearchInput(niche='Dentists', city='Austin', limit=10))
        job_id = [key for key, job in main.jobs.items() if job['niche'] == 'Dentists'][0]
        await main.tasks[job_id]
        assert main.jobs[job_id]['status'] == 'failed'
        assert main.jobs[job_id]['error']['code'] == 'blocked'
        assert main.jobs[job_id]['data'] is None

        async def empty_scraper(*args, **kwargs):
            return {'niche': 'Roofers', 'city': 'Dallas', 'businesses': [],
                    'inspected': 0, 'attempted': 0, 'unverified': 0,
                    'complete': True, 'notice': 'No matching listings were found.'}

        monkeypatch.setattr(main, 'scrape_maps', empty_scraper)
        body = main.SearchInput(niche='Roofers', city='Dallas', limit=10)
        await main.search(body)
        job_id = [key for key, job in main.jobs.items() if job['niche'] == 'Roofers'][0]
        await main.tasks[job_id]
        assert main.jobs[job_id]['status'] == 'completed'
        assert main.jobs[job_id]['data']['cached'] is True
        assert storage.usage_count() == 3
        cached = await main.search(body)
        assert cached['kind'] == 'cached'
        assert cached['result']['inspected'] == 0
        assert storage.usage_count() == 3

    asyncio.run(scenario())
