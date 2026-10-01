import asyncio
import base64
import json
import re
from pathlib import Path

import pytest

from guard import GuardProxy, is_private_address

ROOT = Path(__file__).resolve().parents[2]
TABLE = json.loads((ROOT / "src/server/http/private-addresses.json").read_text())
NEVER_FETCH = re.compile(r"(^|\.)(linkedin\.com|indeed\.[a-z.]+)$", re.I)


@pytest.mark.parametrize("ip", TABLE["private"])
def test_private_addresses_match_the_node_check(ip):
    assert is_private_address(ip) is True


@pytest.mark.parametrize("ip", TABLE["public"])
def test_public_addresses_match_the_node_check(ip):
    assert is_private_address(ip) is False


def run(coro):
    return asyncio.run(coro)


async def echo_server():
    async def handle(reader, writer):
        data = await reader.read(100)
        writer.write(b"echo:" + data)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


async def proxy_request(port, head: bytes, payload: bytes = b""):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(head)
    await writer.drain()
    status = await reader.readuntil(b"\r\n\r\n")
    body = b""
    if payload and b" 200 " in status.split(b"\r\n")[0]:
        writer.write(payload)
        await writer.drain()
        body = await reader.read(100)
    writer.close()
    return status.decode(), body


def auth(proxy):
    token = base64.b64encode(f"{proxy.username}:{proxy.password}".encode()).decode()
    return f"Proxy-Authorization: Basic {token}\r\n"


def make_proxy(addresses, connected=None, echo_port=None, failing=(), hanging=(), lookups=None, **kw):
    async def resolver(host, port):
        if lookups is not None:
            lookups.append(host)
        answer = addresses[host]
        return answer(len(lookups or [])) if callable(answer) else answer

    async def connect(ip, port):
        if connected is not None:
            connected.append((ip, port))
        if ip in failing:
            raise OSError("network is unreachable")
        if ip in hanging:
            await asyncio.sleep(3600)
        return await asyncio.open_connection("127.0.0.1", echo_port)

    return GuardProxy(NEVER_FETCH, resolver=resolver, connect=connect, **kw)


def test_asks_for_credentials_first():
    async def scenario():
        proxy = make_proxy({"jobs.example": ["93.184.216.34"]})
        port = await proxy.start()
        try:
            return await proxy_request(port, b"CONNECT jobs.example:443 HTTP/1.1\r\nHost: jobs.example:443\r\n\r\n")
        finally:
            await proxy.close()

    status, _ = run(scenario())
    assert status.startswith("HTTP/1.1 407")
    assert "Proxy-Authenticate: Basic" in status


def test_refuses_wrong_credentials():
    async def scenario():
        proxy = make_proxy({"jobs.example": ["93.184.216.34"]})
        port = await proxy.start()
        try:
            bad = base64.b64encode(b"someone:guess").decode()
            return await proxy_request(port, f"CONNECT jobs.example:443 HTTP/1.1\r\nProxy-Authorization: Basic {bad}\r\n\r\n".encode())
        finally:
            await proxy.close()

    status, _ = run(scenario())
    assert status.startswith("HTTP/1.1 407")


def test_tunnels_to_the_address_it_checked():
    connected = []
    lookups = []

    async def scenario():
        server, echo_port = await echo_server()
        # A second lookup would say "private" (DNS rebinding): the host is looked up once, and only that checked answer is used.
        answers = lambda n: ["93.184.216.34"] if n <= 1 else ["127.0.0.1"]
        proxy = make_proxy({"jobs.example": answers}, connected=connected, echo_port=echo_port, lookups=lookups)
        port = await proxy.start()
        try:
            return await proxy_request(port, f"CONNECT jobs.example:443 HTTP/1.1\r\n{auth(proxy)}\r\n".encode(), b"hello")
        finally:
            await proxy.close()
            server.close()

    status, body = run(scenario())
    assert status.startswith("HTTP/1.1 200")
    assert body == b"echo:hello"
    assert connected == [("93.184.216.34", 443)]
    assert lookups == ["jobs.example"]


def test_tries_the_next_checked_address_when_one_cannot_be_reached():
    # E.g. an IPv6 answer first on a network (or Docker) without IPv6, or an address that never answers.
    connected = []

    async def scenario():
        server, echo_port = await echo_server()
        addresses = {"jobs.example": ["2606:4700::6810:84e5", "2606:4700::6810:85e5", "104.16.132.229"]}
        proxy = make_proxy(addresses, connected=connected, echo_port=echo_port, failing={"2606:4700::6810:84e5"}, hanging={"2606:4700::6810:85e5"}, connect_timeout=0.2)
        port = await proxy.start()
        try:
            return await proxy_request(port, f"CONNECT jobs.example:443 HTTP/1.1\r\n{auth(proxy)}\r\n".encode(), b"hi")
        finally:
            await proxy.close()
            server.close()

    status, body = run(scenario())
    assert status.startswith("HTTP/1.1 200")
    assert body == b"echo:hi"
    assert [ip for ip, _ in connected] == ["2606:4700::6810:84e5", "2606:4700::6810:85e5", "104.16.132.229"]


def test_a_trailing_dot_does_not_get_past_the_never_read_list():
    async def scenario():
        proxy = make_proxy({"www.linkedin.com.": ["13.107.42.14"]})
        port = await proxy.start()
        try:
            status, _ = await proxy_request(port, f"CONNECT www.linkedin.com.:443 HTTP/1.1\r\n{auth(proxy)}\r\n".encode())
            return status, dict(proxy.refused)
        finally:
            await proxy.close()

    status, refused = run(scenario())
    assert status.startswith("HTTP/1.1 403")
    assert "never" in refused["www.linkedin.com"]


@pytest.mark.parametrize(
    "target,addresses,reason",
    [
        ("intranet.example:443", {"intranet.example": ["93.184.216.34", "10.0.0.5"]}, "private"),
        ("127.0.0.1:3000", {"127.0.0.1": ["127.0.0.1"]}, "private"),
        ("[::1]:443", {"::1": ["::1"]}, "private"),
        ("www.linkedin.com:443", {"www.linkedin.com": ["13.107.42.14"]}, "never"),
        ("nowhere.example:443", {"nowhere.example": []}, "resolve"),
    ],
)
def test_refuses_private_never_read_and_unresolvable_hosts(target, addresses, reason):
    connected = []

    async def scenario():
        proxy = make_proxy(addresses, connected=connected)
        port = await proxy.start()
        try:
            status, _ = await proxy_request(port, f"CONNECT {target} HTTP/1.1\r\n{auth(proxy)}\r\n".encode())
            return status, dict(proxy.refused), list(proxy.log)
        finally:
            await proxy.close()

    status, refused, log = run(scenario())
    assert status.startswith("HTTP/1.1 403")
    assert connected == []
    host = target.rsplit(":", 1)[0].strip("[]")
    assert reason in refused[host]
    # In order, so the helper can tell which refusals happened while a given page loaded.
    assert log == [(host, refused[host])]


def test_refuses_plain_http_requests():
    async def scenario():
        proxy = make_proxy({})
        port = await proxy.start()
        try:
            status, _ = await proxy_request(port, f"GET http://127.0.0.1:3000/admin HTTP/1.1\r\n{auth(proxy)}\r\n".encode())
            return status, dict(proxy.refused)
        finally:
            await proxy.close()

    status, refused = run(scenario())
    assert status.startswith("HTTP/1.1 405")
    assert "https" in refused["127.0.0.1"]


def test_allow_private_mode_still_refuses_never_read_hosts():
    async def scenario():
        server, echo_port = await echo_server()
        proxy = make_proxy({"127.0.0.1": ["127.0.0.1"], "www.linkedin.com": ["13.107.42.14"]}, echo_port=echo_port, allow_private=True)
        port = await proxy.start()
        try:
            local, _ = await proxy_request(port, f"CONNECT 127.0.0.1:443 HTTP/1.1\r\n{auth(proxy)}\r\n".encode(), b"x")
            linkedin, _ = await proxy_request(port, f"CONNECT www.linkedin.com:443 HTTP/1.1\r\n{auth(proxy)}\r\n".encode())
            return local, linkedin
        finally:
            await proxy.close()
            server.close()

    local, linkedin = run(scenario())
    assert local.startswith("HTTP/1.1 200")
    assert linkedin.startswith("HTTP/1.1 403")
