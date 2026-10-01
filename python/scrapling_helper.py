"""Reads job pages with Scrapling's stealth browser for the Job Scraper worker.

The worker starts this process and talks to it with one JSON object per line:

  ← {"event": "ready", "scrapling": "0.4.15", "python": "3.12.7"}      (or {"event": "fatal", "error": {...}} and exit 3)
  → {"id": 1, "method": "fetch_page", "params": {"url": ..., "timeoutMs": 60000, "maxBytes": 3145728}}
  ← {"id": 1, "ok": true, "result": {"status": 200, "finalUrl": ..., "html": ...}}
  ← {"id": 1, "ok": false, "error": {"code": "BLOCKED", "message": ...}}
  → {"id": 2, "method": "cancel", "params": {"target": 1}}               (the cancelled request gets no reply)

stdout carries only the protocol: anything else written there (Scrapling, the browser driver) goes to stderr,
which the worker logs. The process ends when stdin closes, so the browser never outlives the worker.

Environment: JOB_SCRAPER_NEVER_FETCH (regex of sites never read), JOB_SCRAPER_GUARD=off (E2E only: no guard proxy).
"""

import asyncio
import json
import os
import platform
import re
import sys
from typing import Optional
from urllib.parse import urlsplit

MB = 1024 * 1024
DEFAULT_TIMEOUT_MS = 60_000  # Scrapling's minimum while solving Cloudflare challenges
DEFAULT_MAX_BYTES = 3 * MB
BLOCKING_CHALLENGES = ("non-interactive", "managed", "interactive")
PROXY_FAILURES = ("ERR_TUNNEL_CONNECTION_FAILED", "ERR_PROXY", "ERR_HTTP_RESPONSE_CODE_FAILURE", "ERR_EMPTY_RESPONSE")
# Playwright's wording when the browser (or its context) died under us.
BROWSER_GONE = re.compile(r"has been closed|Target closed|browser has disconnected|Connection closed", re.I)


class PageError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def classify(status: int, size: int, hosts: list, refused: dict, max_bytes: int, challenge: Optional[str]) -> Optional[tuple]:
    """Why a page that loaded can't be used, as (code, message), or None when it can."""
    if size > max_bytes:
        return "REFUSED", f"The page is larger than {max_bytes // MB} MB."
    if status >= 400:
        for host in hosts:
            if host in refused:
                return "REFUSED", f"{host}: {refused[host]}"
    if challenge in BLOCKING_CHALLENGES or status in (403, 429, 503):
        return "BLOCKED", "The site's bot check didn't let the page through." if challenge in BLOCKING_CHALLENGES else f"The site refused the request (status {status})."
    if status >= 400:
        return "HTTP_ERROR", f"The site answered with status {status}."
    return None


def navigation_error(text: str, hosts: list, refused: dict) -> tuple:
    """(code, message) for a page that failed to load."""
    lines = text.strip().splitlines()
    first = (lines[0] if lines else "unknown error")[:300]
    if "Executable doesn't exist" in text or "playwright install" in text:
        return "NOT_INSTALLED", "Scrapling's browser isn't installed: run `pnpm run setup`."
    host = next((h for h in hosts if h in refused), None)
    if host and any(marker in text for marker in PROXY_FAILURES):
        return "REFUSED", f"{host}: {refused[host]}"
    if "Timeout" in first or "timeout" in first:
        return "TIMEOUT", first
    return "HTTP_ERROR", first


class Helper:
    def __init__(self, send, session_cls, never_fetch: re.Pattern, guard_on: bool):
        self.send = send
        self.session_cls = session_cls
        self.never_fetch = never_fetch
        self.guard_on = guard_on
        self.guard = None
        self._session = None
        self._lock = asyncio.Lock()

    async def session(self):
        async with self._lock:
            if self._session is None:
                options = dict(
                    headless=True,
                    solve_cloudflare=True,
                    block_ads=True,
                    network_idle=True,
                    block_webrtc=True,
                    retries=1,
                    max_pages=2,
                    timeout=DEFAULT_TIMEOUT_MS,
                    # Scrapling's stealth context ignores certificate errors; job pages must be the real ones.
                    additional_args={"ignore_https_errors": False},
                )
                if self.guard_on and self.guard is None:
                    from guard import GuardProxy

                    self.guard = GuardProxy(self.never_fetch)
                    self.proxy_port = await self.guard.start()
                if self.guard is not None:
                    options["proxy"] = {"server": f"http://127.0.0.1:{self.proxy_port}", "username": self.guard.username, "password": self.guard.password}
                session = self.session_cls(**options)
                await session.start()
                self._session = session
            return self._session

    async def _drop_session(self, dead) -> None:
        """Forgets a session whose browser died, so the next page starts a new browser."""
        async with self._lock:
            if self._session is not dead:
                return
            self._session = None
        try:
            await asyncio.wait_for(dead.close(), 10)
        except Exception:
            pass

    def _refusals(self, hosts: list, mark: int) -> tuple:
        if self.guard is None:
            return hosts, {}
        relevant = dict(self.guard.refusals_since(mark))
        relevant.update({h: self.guard.refused[h] for h in hosts if h in self.guard.refused})
        return hosts + [h for h in relevant if h not in hosts], relevant

    async def fetch_page(self, params: dict) -> dict:
        url = params["url"]
        timeout_ms = int(params.get("timeoutMs") or DEFAULT_TIMEOUT_MS)
        max_bytes = int(params.get("maxBytes") or DEFAULT_MAX_BYTES)
        host = urlsplit(url).hostname or ""
        mark = self.guard.total if self.guard else 0
        try:
            for attempt in range(2):
                session = await self.session()
                mark = self.guard.total if self.guard else 0
                try:
                    page = await asyncio.wait_for(session.fetch(url, timeout=timeout_ms), timeout_ms * 2 / 1000)
                    break
                except Exception as e:
                    if attempt or not BROWSER_GONE.search(str(e)):
                        raise
                    await self._drop_session(session)
        except asyncio.TimeoutError:
            raise PageError("TIMEOUT", f"The page didn't finish loading within {timeout_ms * 2 // 1000} seconds.")
        except Exception as e:  # Playwright/Scrapling errors carry the reason in their text
            hosts, refused = self._refusals([host], mark)
            raise PageError(*navigation_error(f"{type(e).__name__}: {e}" if not str(e) else str(e), hosts, refused))
        body = page.body or b""
        final_url = page.url or url
        hosts, refused = self._refusals([host, urlsplit(final_url).hostname or ""], mark)
        html = body.decode("utf-8", "replace")
        problem = classify(page.status, len(body), hosts, refused, max_bytes, self.session_cls._detect_cloudflare(html) if len(body) <= max_bytes else None)
        if problem:
            raise PageError(*problem)
        return {"status": page.status, "finalUrl": final_url, "html": html}

    async def respond(self, msg: dict) -> None:
        rid = msg.get("id")
        try:
            result = await self.fetch_page(msg.get("params") or {})
            self.send({"id": rid, "ok": True, "result": result})
        except asyncio.CancelledError:
            raise
        except PageError as e:
            self.send({"id": rid, "ok": False, "error": {"code": e.code, "message": str(e)}})
        except Exception as e:  # a bug here must not end the helper
            self.send({"id": rid, "ok": False, "error": {"code": "HELPER_FAILED", "message": f"{type(e).__name__}: {e}"[:500]}})

    async def close(self) -> None:
        if self._session is not None:
            try:
                await asyncio.wait_for(self._session.close(), 10)
            except Exception:
                pass
        if self.guard is not None:
            await self.guard.close()


async def serve(send) -> int:
    try:
        import scrapling
        from scrapling.fetchers import AsyncStealthySession
    except ImportError as e:
        send({"event": "fatal", "error": {"code": "NOT_INSTALLED", "message": f"Scrapling could not be loaded ({e}): run `pnpm run setup`."}})
        return 3
    send({"event": "ready", "scrapling": scrapling.__version__, "python": platform.python_version()})

    never_fetch = re.compile(os.environ.get("JOB_SCRAPER_NEVER_FETCH") or r"(?!)", re.I)
    helper = Helper(send, AsyncStealthySession, never_fetch, guard_on=os.environ.get("JOB_SCRAPER_GUARD") != "off")
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=4 * MB)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    tasks: dict = {}
    while line := await reader.readline():
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        method = msg.get("method")
        if method == "cancel":
            task = tasks.pop((msg.get("params") or {}).get("target"), None)
            if task:
                task.cancel()
        elif method == "fetch_page":
            rid = msg.get("id")
            task = asyncio.create_task(helper.respond(msg))
            tasks[rid] = task
            task.add_done_callback(lambda _t, rid=rid: tasks.pop(rid, None) if tasks.get(rid) is _t else None)
        else:
            send({"id": msg.get("id"), "ok": False, "error": {"code": "HELPER_FAILED", "message": f"Unknown method {method!r}"}})
    for task in list(tasks.values()):
        task.cancel()
    await asyncio.gather(*tasks.values(), return_exceptions=True)
    await helper.close()
    return 0


def main() -> int:
    # Keep the real stdout for the protocol and point fd 1 (and sys.stdout) at stderr, so nothing else
    # (Scrapling, the browser driver it starts) can write into the protocol stream.
    protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def send(msg: dict) -> None:
        protocol.write(json.dumps(msg, ensure_ascii=False) + "\n")
        protocol.flush()

    return asyncio.run(serve(send))


if __name__ == "__main__":
    sys.exit(main())
