import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from scrapling_helper import classify, navigation_error

HELPER = Path(__file__).resolve().parents[1] / "scrapling_helper.py"
MB = 1024 * 1024

# --- pure rules ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status,size,hosts,refused,challenge,expected",
    [
        (200, 1000, ["jobs.example"], {}, None, None),
        (200, 4 * MB, ["jobs.example"], {}, None, "REFUSED"),
        (405, 0, ["jobs.example"], {"jobs.example": "only https pages are read"}, None, "REFUSED"),
        (403, 0, ["jobs.example", "intranet.example"], {"intranet.example": "a private network address"}, None, "REFUSED"),
        # A refusal of some other host (a tracker, an earlier page) doesn't fail a page that loaded.
        (200, 1000, ["jobs.example"], {"ads.example": "a private network address"}, None, None),
        (403, 1000, ["jobs.example"], {}, None, "BLOCKED"),
        (429, 1000, ["jobs.example"], {}, None, "BLOCKED"),
        (503, 1000, ["jobs.example"], {}, None, "BLOCKED"),
        (200, 1000, ["jobs.example"], {}, "managed", "BLOCKED"),
        (200, 1000, ["jobs.example"], {}, "non-interactive", "BLOCKED"),
        # A Turnstile widget inside a normal page (a form) is not a block.
        (200, 1000, ["jobs.example"], {}, "embedded", None),
        (404, 1000, ["jobs.example"], {}, None, "HTTP_ERROR"),
        (500, 1000, ["jobs.example"], {}, None, "HTTP_ERROR"),
    ],
)
def test_classify(status, size, hosts, refused, challenge, expected):
    result = classify(status, size, hosts, refused, 3 * MB, challenge)
    assert (result[0] if result else None) == expected


@pytest.mark.parametrize(
    "text,refused,expected",
    [
        ("Page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://intranet.example/\nCall log:\n  - navigating", {"intranet.example": "a private network address"}, "REFUSED"),
        ("Page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://jobs.example/", {}, "HTTP_ERROR"),
        ("Page.goto: Timeout 60000ms exceeded.", {}, "TIMEOUT"),
        ("BrowserType.launch_persistent_context: Executable doesn't exist at /x/chrome", {}, "NOT_INSTALLED"),
        ("Page.goto: net::ERR_CONNECTION_REFUSED at https://jobs.example/", {}, "HTTP_ERROR"),
    ],
)
def test_navigation_error(text, refused, expected):
    code, message = navigation_error(text, ["jobs.example", "intranet.example"], refused)
    assert code == expected
    assert "Call log" not in message


# --- the process, with a stub Scrapling (no browser) ---------------------------------------------------------

STUB_INIT = """
import os
if os.environ.get("STUB_MISSING"):
    raise ImportError("No module named 'patchright'")
print("noisy stub import")  # Scrapling or its dependencies printing must not reach the protocol stream
__version__ = "9.9.9"
"""

STUB_FETCHERS = """
import asyncio, json, os

class Resp:
    def __init__(self, status, url, body):
        self.status, self.url, self.body = status, url, body

class AsyncStealthySession:
    def __init__(self, **kw):
        self.kw = kw

    @staticmethod
    def _detect_cloudflare(html):
        return "managed" if "cType: 'managed'" in html else None

    async def start(self):
        print("stub session started")
        os.write(1, b"raw fd write\\n")

    async def close(self):
        pass

    async def fetch(self, url, **kw):
        if "slow" in url:
            await asyncio.sleep(3600)
        if "boom" in url:
            raise RuntimeError("Page.goto: net::ERR_CONNECTION_RESET at " + url + "\\nCall log:\\n  - navigating")
        if "kwargs" in url:
            shown = dict(self.kw)
            if "proxy" in shown:
                shown["proxy"] = {"server": shown["proxy"]["server"], "has_auth": bool(shown["proxy"].get("username") and shown["proxy"].get("password"))}
            shown["fetch"] = kw
            return Resp(200, url, json.dumps(shown).encode())
        if "challenge" in url:
            return Resp(200, url, b"<script>cType: 'managed'</script>")
        return Resp(200, url + "#final", b"<html><body>ok</body></html>")
"""


@pytest.fixture
def stub(tmp_path):
    pkg = tmp_path / "scrapling"
    pkg.mkdir()
    (pkg / "__init__.py").write_text(textwrap.dedent(STUB_INIT))
    (pkg / "fetchers.py").write_text(textwrap.dedent(STUB_FETCHERS))
    return tmp_path


class Helper:
    def __init__(self, stub_dir, **env):
        full_env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(stub_dir), "JOB_SCRAPER_NEVER_FETCH": r"(^|\.)linkedin\.com$", **env}
        self.proc = subprocess.Popen([sys.executable, str(HELPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=full_env, text=True)

    def send(self, msg):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def read(self):
        line = self.proc.stdout.readline()
        assert line, "helper closed stdout"
        return json.loads(line)

    def finish(self):
        self.proc.stdin.close()
        code = self.proc.wait(timeout=10)
        rest_out = self.proc.stdout.read()
        err = self.proc.stderr.read()
        return code, rest_out, err


def test_ready_comes_first_and_stdout_only_carries_the_protocol(stub):
    h = Helper(stub, JOB_SCRAPER_GUARD="off")
    assert h.read() == {"event": "ready", "scrapling": "9.9.9", "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"}
    h.send({"id": 1, "method": "fetch_page", "params": {"url": "https://jobs.example/ok", "timeoutMs": 60000, "maxBytes": 3 * MB}})
    reply = h.read()
    assert reply == {"id": 1, "ok": True, "result": {"status": 200, "finalUrl": "https://jobs.example/ok#final", "html": "<html><body>ok</body></html>"}}
    code, rest, err = h.finish()
    assert code == 0
    assert rest == ""
    assert "noisy stub import" in err and "stub session started" in err and "raw fd write" in err


def test_reports_a_missing_scrapling_and_exits(stub):
    h = Helper(stub, STUB_MISSING="1")
    msg = h.read()
    assert msg["event"] == "fatal"
    assert msg["error"]["code"] == "NOT_INSTALLED"
    assert h.proc.wait(timeout=10) == 3


def test_a_cancelled_request_gets_no_reply(stub):
    h = Helper(stub, JOB_SCRAPER_GUARD="off")
    h.read()
    h.send({"id": 1, "method": "fetch_page", "params": {"url": "https://jobs.example/slow"}})
    h.send({"id": 2, "method": "cancel", "params": {"target": 1}})
    h.send({"id": 3, "method": "fetch_page", "params": {"url": "https://jobs.example/ok"}})
    assert h.read()["id"] == 3
    code, rest, _ = h.finish()
    assert code == 0
    assert rest == ""


def test_errors_and_challenges_come_back_as_codes(stub):
    h = Helper(stub, JOB_SCRAPER_GUARD="off")
    h.read()
    h.send({"id": 1, "method": "fetch_page", "params": {"url": "https://jobs.example/boom"}})
    h.send({"id": 2, "method": "fetch_page", "params": {"url": "https://jobs.example/challenge"}})
    h.send({"id": 3, "method": "nonsense"})
    replies = {r["id"]: r for r in (h.read(), h.read(), h.read())}
    assert replies[1]["error"]["code"] == "HTTP_ERROR"
    assert "Call log" not in replies[1]["error"]["message"]
    assert replies[2]["error"]["code"] == "BLOCKED"
    assert replies[3]["error"]["code"] == "HELPER_FAILED"
    h.finish()


def test_the_stealth_session_goes_through_the_guard_proxy(stub):
    h = Helper(stub)
    h.read()
    h.send({"id": 1, "method": "fetch_page", "params": {"url": "https://kwargs.example/", "timeoutMs": 60000}})
    shown = json.loads(h.read()["result"]["html"])
    assert shown["proxy"]["server"].startswith("http://127.0.0.1:")
    assert shown["proxy"]["has_auth"] is True
    assert shown["solve_cloudflare"] is True and shown["block_ads"] is True and shown["network_idle"] is True and shown["block_webrtc"] is True
    assert shown["headless"] is True and shown["retries"] == 1 and shown["max_pages"] == 2
    assert shown["fetch"] == {"timeout": 60000}
    h.finish()


def test_without_the_guard_there_is_no_proxy(stub):
    h = Helper(stub, JOB_SCRAPER_GUARD="off")
    h.read()
    h.send({"id": 1, "method": "fetch_page", "params": {"url": "https://kwargs.example/"}})
    assert "proxy" not in json.loads(h.read()["result"]["html"])
    h.finish()
