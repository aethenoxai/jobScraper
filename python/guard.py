"""The guard proxy in front of the stealth browser.

Every connection the browser makes (each redirect hop, frame, script and socket) goes through this proxy, which
refuses sites Job Scraper never reads and anything that resolves to this machine or the local network. It
connects to the exact address it checked, so a second DNS answer can't swap in a private address. Only CONNECT
is served: pages are read over HTTPS.
"""

import asyncio
import base64
import ipaddress
import re
import secrets
import socket
from typing import Awaitable, Callable, Optional
from urllib.parse import urlsplit

Resolver = Callable[[str, int], Awaitable[list]]
Connector = Callable[[str, int], Awaitable[tuple]]

HEAD_LIMIT = 16 * 1024
HEAD_TIMEOUT_S = 30


def is_private_address(address: str) -> bool:
    """True for loopback, private, link-local, shared, multicast, reserved and unspecified addresses (IPv4-mapped too).

    At least as strict as isPrivateAddress in src/server/http: the shared table in
    src/server/http/private-addresses.json is checked against both.
    """
    host = address.strip().strip("[]").split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not ip.is_global or ip.is_multicast or ip.is_reserved


async def _default_resolver(host: str, port: int) -> list:
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


async def _default_connect(ip: str, port: int) -> tuple:
    return await asyncio.open_connection(ip, port)


def _split_target(target: str) -> tuple[str, int]:
    if target.startswith("["):
        end = target.index("]")
        return target[1:end], int(target[end + 2 :] or 443)
    host, _, port = target.rpartition(":")
    return (host, int(port)) if host else (target, 443)


class GuardProxy:
    def __init__(
        self,
        never_fetch: re.Pattern,
        resolver: Optional[Resolver] = None,
        connect: Optional[Connector] = None,
        allow_private: bool = False,
    ):
        self.never_fetch = never_fetch
        self.resolver = resolver or _default_resolver
        self.connect = connect or _default_connect
        self.allow_private = allow_private
        self.username = secrets.token_urlsafe(18)
        self.password = secrets.token_urlsafe(18)
        # Host → why it was refused, and every refusal in order: the helper reads them to explain a failed page.
        self.refused: dict[str, str] = {}
        self.log: list[tuple[str, str]] = []
        self.total = 0
        self._server: Optional[asyncio.base_events.Server] = None
        self._writers: set[asyncio.StreamWriter] = set()

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0, limit=HEAD_LIMIT)
        return self._server.sockets[0].getsockname()[1]

    async def close(self) -> None:
        if self._server:
            self._server.close()
        for w in list(self._writers):
            w.close()
        self._writers.clear()

    def _authorized(self, headers: dict) -> bool:
        value = headers.get("proxy-authorization", "")
        if not value.lower().startswith("basic "):
            return False
        try:
            given = base64.b64decode(value[6:].strip()).decode()
        except (ValueError, UnicodeDecodeError):
            return False
        return secrets.compare_digest(given, f"{self.username}:{self.password}")

    async def _check(self, host: str, port: int) -> tuple[Optional[str], Optional[str]]:
        """The address to connect to, or why the host is refused."""
        if self.never_fetch.search(host):
            return None, "a site Job Scraper never reads"
        try:
            addresses = await self.resolver(host, port)
        except OSError:
            addresses = []
        if not addresses:
            return None, "could not resolve the site's address"
        if not self.allow_private and any(is_private_address(a) for a in addresses):
            return None, "a private network address"
        return addresses[0], None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        try:
            await self._serve(reader, writer)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ConnectionError, ValueError):
            pass
        finally:
            self._writers.discard(writer)
            writer.close()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        head = (await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HEAD_TIMEOUT_S)).decode("latin-1")
        lines = head.split("\r\n")
        method, target, _ = lines[0].split(" ", 2)
        headers = {k.strip().lower(): v.strip() for k, _, v in (line.partition(":") for line in lines[1:] if ":" in line)}

        if not self._authorized(headers):
            await self._reply(writer, '407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="job-scraper"\r\n')
            return
        if method.upper() != "CONNECT":
            self._refuse(urlsplit(target).hostname or target, "only https pages are read")
            await self._reply(writer, "405 Method Not Allowed")
            return

        host, port = _split_target(target)
        address, reason = await self._check(host, port)
        if reason:
            self._refuse(host, reason)
            await self._reply(writer, "403 Forbidden")
            return
        try:
            up_reader, up_writer = await self.connect(address, port)
        except OSError:
            await self._reply(writer, "502 Bad Gateway")
            return
        self._writers.add(up_writer)
        writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        await writer.drain()
        try:
            await asyncio.gather(self._pipe(reader, up_writer), self._pipe(up_reader, writer))
        finally:
            self._writers.discard(up_writer)
            up_writer.close()

    def _refuse(self, host: str, reason: str) -> None:
        self.refused[host] = reason
        self.log.append((host, reason))
        self.total += 1
        if len(self.log) > 500:
            del self.log[:100]

    def refusals_since(self, mark: int) -> list[tuple[str, str]]:
        """Refusals after `mark` (a value of `total` read earlier)."""
        n = self.total - mark
        return self.log[-n:] if n > 0 else []

    @staticmethod
    async def _reply(writer: asyncio.StreamWriter, status: str, extra: str = "") -> None:
        writer.write(f"HTTP/1.1 {status}\r\n{extra}Content-Length: 0\r\nConnection: close\r\n\r\n".encode())
        await writer.drain()

    @staticmethod
    async def _pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
        try:
            while data := await src.read(65536):
                dst.write(data)
                await dst.drain()
        except ConnectionError:
            pass
        finally:
            dst.close()
