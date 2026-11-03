"""SparkXFlow Local Server Entrypoint.
Ensures Windows ProactorEventLoop is used so Playwright headless Chromium
can spawn its driver subprocess without NotImplementedError.
"""
import sys
import asyncio
import uvicorn

if __name__ == "__main__":
    if sys.platform == "win32":
        try:
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        except Exception:
            pass
        loop = "asyncio.windows_events:ProactorEventLoop"
    else:
        loop = "auto"

    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        loop=loop,
        workers=1,
    )
