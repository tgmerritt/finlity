"""SafeClient: the only way the connector core reaches the network (design 8.1).

Every outgoing request is checked against an exact-host allowlist (https, port
absent or 443, no IP literal, provider path rules), sent by a fresh
``httpx.Client`` with redirects off, environment trust off (no proxy variables,
no netrc, no SSL_CERT_FILE) and TLS verification on, and read through a byte
counter under a wall clock.

The socket layer is pinned: ``PinnedBackend`` resolves the host itself, refuses
the request when any answer is a private, loopback, link-local, reserved or
otherwise non-global address (cloud metadata included), and connects to the
vetted address. TLS still uses the hostname for SNI and certificate checks, so
a DNS answer that changes between the check and the connect cannot redirect
the call.

Credentials travel only as ``auth=`` or headers, never in the URL, so request
URLs, httpx and httpcore log lines and errors carry no secret. Errors are fresh
``ConnectorError`` instances with fixed messages, raised outside any ``except``
block so neither ``__cause__`` nor ``__context__`` links back to an httpx
exception (whose request carries the Authorization header). Nothing here logs a
URL, host, header, body or exception text.

Every call runs under one wall clock: DNS resolution runs in a helper thread
bounded by the time left, at most two vetted addresses are tried, and connect
and read timeouts shrink to the time remaining.

This module relies on httpx's private ``HTTPTransport._pool`` attribute to fit
the pinned network backend (checked by a test, pinned at httpx 0.28.1 and
httpcore 1.0.9).
"""

from __future__ import annotations

import contextvars
import ipaddress
import json
import logging
import os
import re
import socket
import ssl
import threading
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal
from urllib.parse import unquote, urlsplit

import certifi
import httpcore
import httpx

from .env import shared_deployment
from .errors import ConnectorError
from .limits import (
    CALL_WALL_CLOCK_SECONDS,
    CONNECT_TIMEOUT_SECONDS,
    MAX_CLAIM_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
    POOL_TIMEOUT_SECONDS,
    READ_TIMEOUT_SECONDS,
    WRITE_TIMEOUT_SECONDS,
)
from .registry import PROVIDER_IDS

_log = logging.getLogger(__name__)

# --- keeping request URLs out of library logs ----------------------------------
#
# httpx logs "HTTP Request: <method> <url>" at INFO and httpcore logs request
# traces at DEBUG. A SafeClient URL can be secret (the SimpleFIN claim path is
# the setup token) or private (account ids in the query), so records emitted
# while a SafeClient request runs are dropped by a filter on every httpx and
# httpcore logger. Records from other httpx users in the app pass unchanged,
# and no logger level or propagation is touched. Logger filters are not
# inherited by child loggers, so each logger the libraries create is listed
# (a test checks this list against the installed library sources).
_LIBRARY_LOGGERS = (
    "httpx",
    "httpcore",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
    "httpcore.socks",
)
_IN_SAFE_REQUEST: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "connector_safe_request", default=False
)


class _DropSafeClientRecords(logging.Filter):
    """Drops library log records emitted during a SafeClient request."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not _IN_SAFE_REQUEST.get()


_LIBRARY_LOG_FILTER = _DropSafeClientRecords("connector-safe-request")


def _install_library_log_filter() -> None:
    for name in _LIBRARY_LOGGERS:
        lib_logger = logging.getLogger(name)
        if not any(isinstance(f, _DropSafeClientRecords) for f in lib_logger.filters):
            lib_logger.addFilter(_LIBRARY_LOG_FILTER)


_install_library_log_filter()

SIMPLEFIN_HOSTS: frozenset[str] = frozenset(
    {"bridge.simplefin.org", "beta-bridge.simplefin.org"}
)
AKAHU_HOSTS: frozenset[str] = frozenset({"api.akahu.io"})
EXTRA_HOSTS_ENV = "CONNECTORS_SIMPLEFIN_EXTRA_HOSTS"

MAX_URL_CHARS = 2048
_SIMPLEFIN_PREFIX = "/simplefin"
# A claim URL (decoded setup token) is the only SimpleFIN URL ever POSTed to.
_SIMPLEFIN_CLAIM_PREFIX = "/simplefin/claim/"
# Lowercase DNS name with at least one dot and an alphabetic TLD, so numeric
# forms (decimal, hex or dotted IPv4) and single labels never match.
_HOSTNAME = re.compile(
    r"(?=.{4,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]"
)
# Akahu personal app tokens can read and also move money; only the two GET
# collections the provider uses.
_AKAHU_PATHS = re.compile(r"/v1/(?:accounts|transactions)")
# Addresses tried per connect; each attempt is bounded by the wall clock.
MAX_CONNECT_ADDRESSES = 2
# Response encodings accepted. Compressed bodies are refused: the size cap
# counts decoded bytes, and refusing keeps a small body from inflating.
_IDENTITY_ENCODINGS = frozenset({"", "identity"})

_TIMEOUT = httpx.Timeout(
    connect=CONNECT_TIMEOUT_SECONDS,
    read=READ_TIMEOUT_SECONDS,
    write=WRITE_TIMEOUT_SECONDS,
    pool=POOL_TIMEOUT_SECONDS,
)
_DEFAULT_HEADERS = {"User-Agent": "Finlity", "Accept-Encoding": "identity"}
_STATUS_ERRORS: dict[int, str] = {
    401: "reconnect_needed",
    403: "reconnect_needed",
    402: "payment_required",
    429: "provider_rate_limited",
}
_CLAIM_STATUS_ERRORS: dict[int, str] = {401: "claim_refused", 403: "claim_refused"}


class _Refused(Exception):
    """Internal: a URL failed a check. Callers turn it into a ConnectorError."""


# --- allowlist ----------------------------------------------------------------


def _extra_simplefin_hosts() -> frozenset[str]:
    """Operator-set self-hosted SimpleFIN servers; server mode only (design 8.1)."""
    if shared_deployment():
        return frozenset()
    raw = os.environ.get(EXTRA_HOSTS_ENV, "")
    hosts = set()
    for part in raw.split(","):
        host = part.strip().lower()
        if host and _is_dns_name(host):
            hosts.add(host)
    return frozenset(hosts)


def allowed_hosts(provider_id: str) -> frozenset[str]:
    """Exact hostnames a provider's client may reach (read from the env now)."""
    if provider_id == "simplefin":
        return SIMPLEFIN_HOSTS | _extra_simplefin_hosts()
    if provider_id == "akahu":
        return AKAHU_HOSTS
    return frozenset()


def _is_dns_name(host: str) -> bool:
    if not _HOSTNAME.fullmatch(host):
        return False
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return True
    return False


@dataclass(frozen=True)
class _Parsed:
    host: str
    path: str
    has_userinfo: bool
    username: str = field(repr=False)
    password: str = field(repr=False)
    has_query: bool
    has_fragment: bool

    @property
    def base_url(self) -> str:
        return "https://" + self.host + self.path


def _parse(url: object, hosts: frozenset[str]) -> _Parsed:
    """Split and vet an https URL against an exact host set. Raises _Refused."""
    if not isinstance(url, str) or not 0 < len(url) <= MAX_URL_CHARS:
        raise _Refused
    # Printable ASCII only: no spaces, controls, backslashes or Unicode lookalikes.
    if any(not ("!" <= ch <= "~") for ch in url) or "\\" in url:
        raise _Refused
    parts = urlsplit(url)
    if parts.scheme != "https" or not url.startswith("https://"):
        raise _Refused
    host = parts.hostname or ""
    if not _is_dns_name(host) or host not in hosts:
        raise _Refused
    port: int | None = -1
    try:
        port = parts.port
    except ValueError:
        pass
    if port not in (None, 443):
        raise _Refused
    path = parts.path or "/"
    if not path.startswith("/"):
        raise _Refused
    if any(seg in (".", "..") for seg in unquote(path).split("/")):
        raise _Refused
    # A second parser must see the same scheme, host and port.
    other: httpx.URL | None = None
    try:
        other = httpx.URL(url)
    except (httpx.InvalidURL, ValueError):
        pass
    if other is None:
        raise _Refused
    if other.scheme != "https" or other.host != host or other.port not in (None, 443):
        raise _Refused
    has_userinfo = "@" in parts.netloc
    if bool(other.userinfo) != has_userinfo:
        raise _Refused
    # One "@" at most: a raw "@" inside the userinfo is ambiguous between parsers.
    if parts.netloc.count("@") > 1:
        raise _Refused
    return _Parsed(
        host=host,
        path=path,
        has_userinfo=has_userinfo,
        username=parts.username or "",
        password=parts.password or "",
        has_query=bool(parts.query) or "?" in url,
        has_fragment=bool(parts.fragment) or "#" in url,
    )


def _parse_or_none(url: object, hosts: frozenset[str]) -> _Parsed | None:
    """``_parse`` that returns None, so callers raise with no exception context."""
    try:
        return _parse(url, hosts)
    except _Refused:
        return None


def _simplefin_path_ok(path: str) -> bool:
    return path == _SIMPLEFIN_PREFIX or path.startswith(_SIMPLEFIN_PREFIX + "/")


def _simplefin_claim_path_ok(path: str) -> bool:
    """``/simplefin/claim/<token>``, with something after the prefix."""
    if not path.startswith(_SIMPLEFIN_CLAIM_PREFIX):
        return False
    return bool(path[len(_SIMPLEFIN_CLAIM_PREFIX) :].strip("/"))


@dataclass(frozen=True, repr=False)
class SplitUrl:
    """A vetted SimpleFIN URL: ``base_url`` without userinfo, query or fragment,
    and for an Access URL the ``(user, password)`` pair to send as Basic auth."""

    base_url: str
    auth: tuple[str, str] | None

    def __repr__(self) -> str:
        return "SplitUrl(<redacted>)"

    def __str__(self) -> str:
        return "SplitUrl(<redacted>)"


def check_simplefin_url(url: str, *, kind: Literal["claim", "access"]) -> SplitUrl:
    """Vet a claim URL (decoded setup token) or an Access URL (design 8.1).

    A claim URL must carry no userinfo and sit under ``/simplefin/claim/``
    with a token after it; a failure is ``bad_setup_token``. An
    Access URL must carry a user and a password; a failure is
    ``host_not_allowed``. Both need https, an allowlisted host, port absent or
    443, a path under ``/simplefin`` and no query or fragment.
    """
    if kind not in ("claim", "access"):
        raise ValueError("kind must be 'claim' or 'access'")
    code = "bad_setup_token" if kind == "claim" else "host_not_allowed"
    parsed = _parse_or_none(url, allowed_hosts("simplefin"))
    if parsed is None:
        raise ConnectorError(code)
    if parsed.has_query or parsed.has_fragment or not _simplefin_path_ok(parsed.path):
        raise ConnectorError(code)
    path = parsed.path.rstrip("/") or "/"
    base_url = "https://" + parsed.host + path
    if kind == "claim":
        if parsed.has_userinfo or not _simplefin_claim_path_ok(parsed.path):
            raise ConnectorError(code)
        return SplitUrl(base_url=base_url, auth=None)
    if not (parsed.username and parsed.password):
        raise ConnectorError(code)
    return SplitUrl(
        base_url=base_url,
        auth=(unquote(parsed.username), unquote(parsed.password)),
    )


# --- address vetting and pinning ------------------------------------------------

_IP = ipaddress.IPv4Address | ipaddress.IPv6Address
# IPv6 prefixes whose low 32 bits are an IPv4 address: NAT64 well-known prefix
# (RFC 6052) and the deprecated IPv4-compatible block.
_EMBEDS_IPV4_LOW32 = (
    ipaddress.IPv6Network("64:ff9b::/96"),
    ipaddress.IPv6Network("::/96"),
)


def is_public_address(ip: _IP) -> bool:
    """Globally routable unicast only. IPv6 forms that embed an IPv4 address
    (mapped, 6to4, Teredo, NAT64 64:ff9b::/96, IPv4-compatible ::/96) are
    checked on the embedded address too."""
    candidates: list[_IP] = [ip]
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            candidates.append(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            candidates.append(ip.sixtofour)
        if ip.teredo is not None:
            candidates.extend(ip.teredo)
        if any(ip in net for net in _EMBEDS_IPV4_LOW32):
            candidates.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return all(c.is_global and not c.is_multicast for c in candidates)


def _remaining(deadline: float | None) -> float | None:
    """Seconds left before the deadline (None: no deadline); raises at zero."""
    if deadline is None:
        return None
    left = deadline - time.monotonic()
    if left <= 0:
        raise ConnectorError("provider_timeout")
    return left


def _getaddrinfo_bounded(host: str, port: int, limit: float) -> list[Any] | None:
    """``socket.getaddrinfo`` in a daemon thread, waited on for ``limit``
    seconds. Returns None when it failed; raises ``provider_timeout`` when it
    is still running (the thread finishes on its own and its answer is
    dropped)."""
    box: dict[str, Any] = {}

    def run() -> None:
        try:
            box["infos"] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except (OSError, UnicodeError):
            box["failed"] = True

    worker = threading.Thread(target=run, name="connector-dns", daemon=True)
    worker.start()
    worker.join(limit)
    if worker.is_alive():
        raise ConnectorError("provider_timeout")
    infos = box.get("infos")
    return None if infos is None else list(infos)


def resolve_public_addresses(
    host: str, port: int, *, deadline: float | None = None
) -> list[str]:
    """Resolve once; refuse unless every answer is public. Returns the IPs.

    Resolution is bounded by the connect timeout and by ``deadline``.
    """
    left = _remaining(deadline)
    limit = CONNECT_TIMEOUT_SECONDS if left is None else min(CONNECT_TIMEOUT_SECONDS, left)
    infos = _getaddrinfo_bounded(host, port, limit)
    if infos is None:
        raise ConnectorError("provider_unavailable")
    addresses: list[str] = []
    for family, _type, _proto, _canon, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            raise ConnectorError("host_not_allowed")
        ip: _IP | None = None
        try:
            ip = ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0])
        except ValueError:
            pass
        if ip is None or not is_public_address(ip):
            raise ConnectorError("host_not_allowed")
        if str(ip) not in addresses:
            addresses.append(str(ip))
    if not addresses:
        raise ConnectorError("provider_unavailable")
    return addresses


class PinnedBackend(httpcore.SyncBackend):
    """Connects only to addresses vetted by ``resolve_public_addresses``.

    httpcore passes the URL host here and later calls ``start_tls`` with
    ``server_hostname`` set to that same host, so the socket goes to the vetted
    IP while SNI and certificate verification use the real name. At most
    ``MAX_CONNECT_ADDRESSES`` are tried, each with the timeout cut to the time
    left before ``deadline``.
    """

    def __init__(self, deadline: float | None = None) -> None:
        super().__init__()
        self._deadline = deadline

    def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.NetworkStream:
        addresses = resolve_public_addresses(host, port, deadline=self._deadline)
        for address in addresses[:MAX_CONNECT_ADDRESSES]:
            left = _remaining(self._deadline)
            attempt = timeout
            if left is not None:
                attempt = left if timeout is None else min(timeout, left)
            try:
                return super().connect_tcp(
                    address,
                    port,
                    timeout=attempt,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except httpcore.ConnectError:
                continue
        raise httpcore.ConnectError("connect failed")

    def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[Any] | None = None,
    ) -> httpcore.NetworkStream:
        raise ConnectorError("host_not_allowed")


def _ssl_context() -> ssl.SSLContext:
    """Verified TLS 1.2+ against certifi's bundle.

    Built directly rather than through ``ssl.create_default_context`` (or
    httpx's helper, which calls it), because that reads SSLKEYLOGFILE and
    would write session keys to it; SSL_CERT_FILE is ignored the same way.
    """
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.load_verify_locations(cafile=certifi.where())
    ctx.keylog_filename = None  # type: ignore[assignment]
    return ctx


class PinnedTransport(httpx.HTTPTransport):
    """httpx's transport with the pool rebuilt on ``PinnedBackend``: HTTP/1.1,
    no retries, no proxy, TLS verified against certifi's bundle."""

    def __init__(self, deadline: float | None = None) -> None:
        ctx = _ssl_context()
        super().__init__(verify=ctx, trust_env=False, http1=True, http2=False, retries=0)
        self._pool.close()
        self._pool = httpcore.ConnectionPool(
            ssl_context=ctx,
            http1=True,
            http2=False,
            retries=0,
            network_backend=PinnedBackend(deadline),
        )


# --- the client -------------------------------------------------------------------


def _reject_constant(name: str) -> Any:
    raise ValueError("non-finite number")


def _status_error(status: int, overrides: Mapping[int, str] | None) -> str | None:
    if overrides and status in overrides:
        return overrides[status]
    if status == 200:
        return None
    if status in _STATUS_ERRORS:
        return _STATUS_ERRORS[status]
    if status >= 500:
        return "provider_unavailable"
    # Any redirect (never followed), other 4xx and non-200 success.
    return "provider_bad_response"


class SafeClient:
    """Allowlisted HTTP for one provider. Use as a context manager.

    ``transport`` is for tests (``httpx.MockTransport``); production uses a
    fresh ``PinnedTransport`` and ``httpx.Client`` for every call.

    ``deadline`` (a ``time.monotonic()`` value) bounds every request this
    client makes, on top of each request's own ``CALL_WALL_CLOCK_SECONDS``:
    a request gets whichever ends first, so a provider call that makes
    several requests (Akahu pages) has one overall limit.
    """

    def __init__(
        self,
        provider_id: str,
        *,
        transport: httpx.BaseTransport | None = None,
        deadline: float | None = None,
    ) -> None:
        if provider_id not in PROVIDER_IDS:
            raise ConnectorError("bad_request")
        self.provider_id = provider_id
        self._transport = transport
        self._deadline = deadline

    def __enter__(self) -> SafeClient:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def __repr__(self) -> str:
        return f"SafeClient({self.provider_id})"

    # Public API ------------------------------------------------------------------

    def seconds_left(self) -> float | None:
        """Seconds before the overall deadline (never negative), or None when
        this client has none."""
        if self._deadline is None:
            return None
        return max(0.0, self._deadline - time.monotonic())

    def get_json(
        self,
        url: str,
        *,
        auth: tuple[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        params: Any = None,
        status_errors: Mapping[int, str] | None = None,
    ) -> Any:
        """GET and parse JSON. Non-integer numbers come back as ``Decimal``
        (callers still bound magnitudes, see ``types.bounded_amount``); NaN and
        Infinity are refused. 401/403 are ``reconnect_needed`` unless
        ``status_errors`` maps them differently."""
        body = self._request(
            "GET",
            url,
            auth=auth,
            headers=headers,
            params=params,
            max_bytes=MAX_RESPONSE_BYTES,
            status_errors=status_errors,
        )
        parsed: Any = None
        ok = False
        try:
            parsed = json.loads(
                body.decode("utf-8"),
                parse_float=Decimal,
                parse_constant=_reject_constant,
            )
            ok = True
        except (ValueError, RecursionError):
            pass
        if not ok:
            raise ConnectorError("provider_bad_response")
        return parsed

    def post_text(self, url: str) -> str:
        """POST an empty body and return the stripped text (the SimpleFIN
        claim). 401/403 are ``claim_refused``; the body is capped small."""
        body = self._request(
            "POST",
            url,
            content=b"",
            max_bytes=MAX_CLAIM_RESPONSE_BYTES,
            status_errors=_CLAIM_STATUS_ERRORS,
        )
        text: str | None = None
        try:
            text = body.decode("utf-8").strip()
        except ValueError:
            pass
        if text is None:
            raise ConnectorError("provider_bad_response")
        return text

    # Internals ------------------------------------------------------------------

    def _new_client(self, deadline: float | None = None) -> httpx.Client:
        transport = (
            self._transport if self._transport is not None else PinnedTransport(deadline)
        )
        return httpx.Client(
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            timeout=_TIMEOUT,
            headers=_DEFAULT_HEADERS,
        )

    def _check_request(self, method: str, url: str) -> str:
        """Vet one outgoing request; return the canonical URL to send."""
        parsed = _parse_or_none(url, allowed_hosts(self.provider_id))
        if parsed is None:
            raise ConnectorError("host_not_allowed")
        if parsed.has_userinfo or parsed.has_query or parsed.has_fragment:
            raise ConnectorError("host_not_allowed")
        if self.provider_id == "simplefin":
            # GET anywhere under /simplefin; POST only to a claim URL.
            if method == "GET":
                ok = _simplefin_path_ok(parsed.path)
            else:
                ok = method == "POST" and _simplefin_claim_path_ok(parsed.path)
        elif self.provider_id == "akahu":
            ok = (
                method == "GET"
                and "%" not in parsed.path
                and _AKAHU_PATHS.fullmatch(parsed.path) is not None
            )
        else:
            ok = False
        if not ok:
            raise ConnectorError("host_not_allowed")
        return parsed.base_url

    def _request(
        self,
        method: str,
        url: str,
        *,
        auth: tuple[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        params: Any = None,
        content: bytes | None = None,
        max_bytes: int,
        status_errors: Mapping[int, str] | None,
    ) -> bytes:
        start = time.monotonic()
        error_type: str | None = None
        body = b""
        deadline = start + CALL_WALL_CLOCK_SECONDS
        if self._deadline is not None:
            deadline = min(deadline, self._deadline)
        try:
            target = self._check_request(method, url)
            _check_deadline(deadline)
            body = self._send(
                method,
                target,
                auth=auth,
                headers=headers,
                params=params,
                content=content,
                max_bytes=max_bytes,
                status_errors=status_errors,
                deadline=deadline,
            )
        except ConnectorError as exc:
            error_type = exc.error_type
        _log.debug(
            "connector_http provider=%s method=%s outcome=%s ms=%d",
            self.provider_id,
            method,
            error_type or "ok",
            int((time.monotonic() - start) * 1000),
        )
        if error_type is not None:
            # A fresh error raised outside the handler: no __cause__ and no
            # __context__, so nothing chains back to a request or its headers.
            raise ConnectorError(error_type)
        return body

    def _send(
        self,
        method: str,
        url: str,
        *,
        auth: tuple[str, str] | None,
        headers: Mapping[str, str] | None,
        params: Any,
        content: bytes | None,
        max_bytes: int,
        status_errors: Mapping[int, str] | None,
        deadline: float,
    ) -> bytes:
        error_type: str | None = None
        try:
            return self._exchange(
                method,
                url,
                auth=auth,
                headers=headers,
                params=params,
                content=content,
                max_bytes=max_bytes,
                status_errors=status_errors,
                deadline=deadline,
            )
        except ConnectorError as exc:
            error_type = exc.error_type
        except httpx.TimeoutException:
            error_type = "provider_timeout"
        except httpx.TransportError:
            error_type = "provider_unavailable"
        except httpx.HTTPError:
            error_type = "provider_bad_response"
        except (httpx.InvalidURL, UnicodeError):
            error_type = "bad_request"
        raise ConnectorError(error_type or "provider_unavailable")

    def _exchange(
        self,
        method: str,
        url: str,
        *,
        auth: tuple[str, str] | None,
        headers: Mapping[str, str] | None,
        params: Any,
        content: bytes | None,
        max_bytes: int,
        status_errors: Mapping[int, str] | None,
        deadline: float,
    ) -> bytes:
        # Re-installed per call in case logging was reconfigured since import.
        _install_library_log_filter()
        token = _IN_SAFE_REQUEST.set(True)
        try:
            return self._exchange_quietly(
                method,
                url,
                auth=auth,
                headers=headers,
                params=params,
                content=content,
                max_bytes=max_bytes,
                status_errors=status_errors,
                deadline=deadline,
            )
        finally:
            _IN_SAFE_REQUEST.reset(token)

    def _exchange_quietly(
        self,
        method: str,
        url: str,
        *,
        auth: tuple[str, str] | None,
        headers: Mapping[str, str] | None,
        params: Any,
        content: bytes | None,
        max_bytes: int,
        status_errors: Mapping[int, str] | None,
        deadline: float,
    ) -> bytes:
        with self._new_client(deadline) as client:
            with client.stream(
                method,
                url,
                auth=auth,
                headers=dict(headers) if headers else None,
                params=params,
                content=content,
                timeout=_timeout_within(deadline),
            ) as resp:
                _check_deadline(deadline)
                code = _status_error(resp.status_code, status_errors)
                if code is not None:
                    raise ConnectorError(code)
                encoding = resp.headers.get("content-encoding", "").strip().lower()
                if encoding not in _IDENTITY_ENCODINGS:
                    raise ConnectorError("provider_bad_response")
                declared = resp.headers.get("content-length")
                if declared is not None:
                    if not declared.strip().isdigit():
                        raise ConnectorError("provider_bad_response")
                    if int(declared) > max_bytes:
                        raise ConnectorError("response_too_large")
                body = bytearray()
                for chunk in resp.iter_bytes():
                    body += chunk
                    if len(body) > max_bytes:
                        raise ConnectorError("response_too_large")
                    _check_deadline(deadline)
                    _shrink_read_timeout(resp.request, deadline)
                _check_deadline(deadline)
                return bytes(body)


def _timeout_within(deadline: float) -> httpx.Timeout:
    """The transport timeouts, each cut to the time left on the wall clock."""
    left = _remaining(deadline) or 0.0
    return httpx.Timeout(
        connect=min(CONNECT_TIMEOUT_SECONDS, left),
        read=min(READ_TIMEOUT_SECONDS, left),
        write=min(WRITE_TIMEOUT_SECONDS, left),
        pool=min(POOL_TIMEOUT_SECONDS, left),
    )


def _shrink_read_timeout(request: httpx.Request, deadline: float) -> None:
    """Cut the read timeout for the next body read to the time left.

    httpcore reads ``request.extensions["timeout"]["read"]`` before every
    socket read, and httpx hands it this same dict.
    """
    timeouts = request.extensions.get("timeout")
    if isinstance(timeouts, dict):
        left = _remaining(deadline) or 0.0
        current = timeouts.get("read")
        timeouts["read"] = left if current is None else min(current, left)


def _check_deadline(deadline: float) -> None:
    _remaining(deadline)
