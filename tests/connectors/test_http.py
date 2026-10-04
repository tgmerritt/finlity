"""SafeClient: the only way the connector core reaches the network (design 8.1).

Requests go through ``httpx.MockTransport``. The address pinning tests use the
real transport with a fake resolver and a recording ``socket.create_connection``,
so no test opens a socket.
"""

from __future__ import annotations

import base64
import gzip
import ipaddress
import json
import threading
import time
import logging
import socket
import ssl
import types
from typing import Any

import httpcore
import httpx
import pytest

from src.connectors import http as http_mod
from src.connectors.errors import ConnectorError
from src.connectors.http import (
    SafeClient,
    SplitUrl,
    allowed_hosts,
    check_simplefin_url,
)
from src.connectors.limits import MAX_RESPONSE_BYTES

PASSWORD = "Pl4nted-Pa55word-xyz"
USER = "planteduser"
ACCESS_URL = f"https://{USER}:{PASSWORD}@beta-bridge.simplefin.org/simplefin"
AKAHU_TOKEN = "user_token_PLANTEDakahu0123456789"
BASE = "https://beta-bridge.simplefin.org/simplefin"
PUBLIC_IP = "93.184.216.34"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in (
        "DYNO",
        "MULTI_USER_MODE",
        "PROTECT_DEMO_DATA",
        "CONNECTORS_SIMPLEFIN_EXTRA_HOSTS",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
        "https_proxy",
        "http_proxy",
        "all_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _err(info: pytest.ExceptionInfo[ConnectorError]) -> str:
    return info.value.error_type


class Recorder:
    """A MockTransport handler that records requests and returns a response."""

    def __init__(self, response: httpx.Response | None = None):
        self.requests: list[httpx.Request] = []
        self.response = response or httpx.Response(200, json={"ok": True})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.response


def _client(provider: str, handler: Any) -> SafeClient:
    return SafeClient(provider, transport=httpx.MockTransport(handler))


# --- check_simplefin_url ------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://u:p@beta-bridge.simplefin.org/simplefin",
        "https://u:p@bridge.simplefin.org/simplefin",
        "https://u:p@bridge.simplefin.org:443/simplefin",
        "https://u:p@BETA-BRIDGE.SimpleFIN.org/simplefin/",
    ],
)
def test_access_url_accepted(url):
    split = check_simplefin_url(url, kind="access")
    assert split.auth == ("u", "p")
    assert "@" not in split.base_url and "u:p" not in split.base_url
    assert split.base_url.startswith("https://")
    assert split.base_url.rstrip("/").endswith("/simplefin")


def test_access_url_userinfo_is_percent_decoded():
    split = check_simplefin_url(
        "https://us%40er:p%3Ass@bridge.simplefin.org/simplefin", kind="access"
    )
    assert split.auth == ("us@er", "p:ss")


def test_claim_url_accepted_without_userinfo():
    split = check_simplefin_url(
        "https://beta-bridge.simplefin.org/simplefin/claim/DEMO-v2-ABC", kind="claim"
    )
    assert split.auth is None
    assert split.base_url == "https://beta-bridge.simplefin.org/simplefin/claim/DEMO-v2-ABC"


def test_split_url_repr_hides_the_password():
    split = check_simplefin_url(ACCESS_URL, kind="access")
    assert isinstance(split, SplitUrl)
    for text in (repr(split), str(split), f"{split}"):
        assert PASSWORD not in text and USER not in text


ACCESS_REFUSED = [
    "http://u:p@beta-bridge.simplefin.org/simplefin",
    "https://u:p@beta-bridge.simplefin.org:8443/simplefin",
    "https://u:p@beta-bridge.simplefin.org:80/simplefin",
    "https://u:p@bridge.simplefin.org.evil.com/simplefin",
    "https://u:p@evil.com/simplefin",
    "https://bridge.simplefin.org@evil.com/simplefin",
    "https://u:p@evil.com#@bridge.simplefin.org/simplefin",
    "https://u:p@evil.com\\@bridge.simplefin.org/simplefin",
    "https://u:p@bridge.simplefin.org./simplefin",
    "https://u:p@simplefin.org/simplefin",
    "https://u:p@127.0.0.1/simplefin",
    "https://u:p@[::1]/simplefin",
    "https://u:p@2130706433/simplefin",
    "https://u:p@0x7f000001/simplefin",
    "https://u:p@169.254.169.254/simplefin",
    "https://beta-bridge.simplefin.org/simplefin",  # no userinfo
    "https://u@beta-bridge.simplefin.org/simplefin",  # no password
    "https://:p@beta-bridge.simplefin.org/simplefin",  # no user
    "https://u:p@beta-bridge.simplefin.org/",
    "https://u:p@beta-bridge.simplefin.org/simplefinx",
    "https://u:p@beta-bridge.simplefin.org/other/simplefin",
    "https://u:p@beta-bridge.simplefin.org/simplefin/../admin",
    "https://u:p@beta-bridge.simplefin.org/simplefin/%2e%2e/admin",
    "https://u:p@beta-bridge.simplefin.org/simplefin?x=1",
    "https://u:p@beta-bridge.simplefin.org/simplefin#frag",
    "https://u:p@beta-bridge.simplefin.org:abc/simplefin",
    "https://u:p@beta-bridge.simplefin.org/simple fin",
    "https://u:p@beta-bridge.simplefin.org/simplefin\n",
    " https://u:p@beta-bridge.simplefin.org/simplefin",
    "ftp://u:p@beta-bridge.simplefin.org/simplefin",
    "//u:p@beta-bridge.simplefin.org/simplefin",
    "",
    "https://u:p@xn--bta-bridge-z7a.simplefin.org/simplefin",
    "https://u:p@bеta-bridge.simplefin.org/simplefin",  # Cyrillic e
    "https://u:p@beta-bridge.simplefin.org/" + "s" * 5000,
    "https://u:p@ss@beta-bridge.simplefin.org/simplefin",  # raw @ in password
    "https://u@x:p@beta-bridge.simplefin.org/simplefin",  # raw @ in user
]


@pytest.mark.parametrize("url", ACCESS_REFUSED)
def test_access_url_refused(url):
    with pytest.raises(ConnectorError) as info:
        check_simplefin_url(url, kind="access")
    assert _err(info) == "host_not_allowed"


@pytest.mark.parametrize(
    "url",
    [
        "https://u:p@beta-bridge.simplefin.org/simplefin/claim/X",  # userinfo
        "https://u@beta-bridge.simplefin.org/simplefin/claim/X",
        "http://beta-bridge.simplefin.org/simplefin/claim/X",
        "https://evil.com/simplefin/claim/X",
        "https://beta-bridge.simplefin.org:8443/simplefin/claim/X",
        "https://beta-bridge.simplefin.org/claim/X",
        "https://10.0.0.1/simplefin/claim/X",
        # A claim URL must sit under /simplefin/claim/ with a token after it.
        "https://beta-bridge.simplefin.org/simplefin",
        "https://beta-bridge.simplefin.org/simplefin/",
        "https://beta-bridge.simplefin.org/simplefin/claim",
        "https://beta-bridge.simplefin.org/simplefin/claim/",
        "https://beta-bridge.simplefin.org/simplefin/accounts",
        "https://beta-bridge.simplefin.org/simplefin/claimx/X",
        "https://beta-bridge.simplefin.org/simplefin/x/claim/X",
    ],
)
def test_claim_url_refused_as_bad_setup_token(url):
    with pytest.raises(ConnectorError) as info:
        check_simplefin_url(url, kind="claim")
    assert _err(info) == "bad_setup_token"


@pytest.mark.parametrize("bad", [None, 3, b"https://u:p@bridge.simplefin.org/simplefin"])
def test_non_string_url_refused(bad):
    with pytest.raises(ConnectorError):
        check_simplefin_url(bad, kind="access")  # type: ignore[arg-type]


def test_refusal_never_echoes_the_url():
    with pytest.raises(ConnectorError) as info:
        check_simplefin_url(f"https://u:{PASSWORD}@evil.com/simplefin", kind="access")
    assert PASSWORD not in str(info.value) and PASSWORD not in repr(info.value)
    assert "evil" not in str(info.value)
    assert info.value.__cause__ is None and info.value.__context__ is None


# --- allowed_hosts and extra hosts ---------------------------------------------


def test_allowed_hosts_default():
    assert allowed_hosts("simplefin") == frozenset(
        {"bridge.simplefin.org", "beta-bridge.simplefin.org"}
    )
    assert allowed_hosts("akahu") == frozenset({"api.akahu.io"})
    assert allowed_hosts("demo") == frozenset()
    assert allowed_hosts("nope") == frozenset()


def test_extra_hosts_honored_in_server_mode(clean_env):
    clean_env.setenv(
        "CONNECTORS_SIMPLEFIN_EXTRA_HOSTS",
        " sfin.example.org, SFIN2.Example.NET ,,10.0.0.5,127.0.0.1,[::1],"
        "bad host,host:8443,localhost,x.123,a..b.com",
    )
    hosts = allowed_hosts("simplefin")
    assert {"sfin.example.org", "sfin2.example.net"} <= hosts
    for bad in ("10.0.0.5", "127.0.0.1", "[::1]", "::1", "localhost", "x.123", "host"):
        assert bad not in hosts
    assert "sfin.example.org" not in allowed_hosts("akahu")
    split = check_simplefin_url("https://u:p@sfin.example.org/simplefin", kind="access")
    assert split.base_url == "https://sfin.example.org/simplefin"


@pytest.mark.parametrize(
    "env", [{"DYNO": "web.1"}, {"MULTI_USER_MODE": "true"}, {"PROTECT_DEMO_DATA": "1"}]
)
def test_extra_hosts_ignored_on_shared_deployments(clean_env, env):
    clean_env.setenv("CONNECTORS_SIMPLEFIN_EXTRA_HOSTS", "sfin.example.org")
    for k, v in env.items():
        clean_env.setenv(k, v)
    assert "sfin.example.org" not in allowed_hosts("simplefin")
    with pytest.raises(ConnectorError) as info:
        check_simplefin_url("https://u:p@sfin.example.org/simplefin", kind="access")
    assert _err(info) == "host_not_allowed"


# --- request checks -------------------------------------------------------------


def test_get_json_sends_basic_auth_and_no_userinfo():
    rec = Recorder(httpx.Response(200, json={"accounts": []}))
    split = check_simplefin_url(ACCESS_URL, kind="access")
    with _client("simplefin", rec) as client:
        data = client.get_json(
            split.base_url + "/accounts",
            auth=split.auth,
            params={"balances-only": "1", "version": "2"},
        )
    assert data == {"accounts": []}
    (req,) = rec.requests
    assert req.method == "GET"
    assert req.url.userinfo == b""
    assert PASSWORD not in str(req.url) and USER not in str(req.url)
    assert req.url.host == "beta-bridge.simplefin.org"
    assert req.url.path == "/simplefin/accounts"
    assert req.url.params["balances-only"] == "1"
    assert req.headers["authorization"].startswith("Basic ")
    assert req.headers.get("accept-encoding") == "identity"


def test_get_json_refuses_userinfo_in_the_request_url():
    rec = Recorder()
    with _client("simplefin", rec) as client, pytest.raises(ConnectorError) as info:
        client.get_json(ACCESS_URL + "/accounts")
    assert _err(info) == "host_not_allowed"
    assert rec.requests == []


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.com/simplefin/accounts",
        "http://beta-bridge.simplefin.org/simplefin/accounts",
        "https://beta-bridge.simplefin.org:8443/simplefin/accounts",
        "https://beta-bridge.simplefin.org/admin",
        "https://beta-bridge.simplefin.org/simplefin/accounts?x=1",
        "https://api.akahu.io/v1/accounts",
        "https://93.184.216.34/simplefin/accounts",
    ],
)
def test_simplefin_client_refuses_off_allowlist_requests(url):
    rec = Recorder()
    with _client("simplefin", rec) as client, pytest.raises(ConnectorError) as info:
        client.get_json(url)
    assert _err(info) == "host_not_allowed"
    assert rec.requests == []


AKAHU_OK = [
    "https://api.akahu.io/v1/accounts",
    "https://api.akahu.io/v1/transactions",
]


@pytest.mark.parametrize("url", AKAHU_OK)
def test_akahu_client_allows_only_listed_get_paths(url):
    rec = Recorder(httpx.Response(200, json={"items": []}))
    with _client("akahu", rec) as client:
        assert client.get_json(
            url, headers={"Authorization": f"Bearer {AKAHU_TOKEN}", "X-Akahu-Id": "app_token_x"}
        ) == {"items": []}
    assert rec.requests[0].headers["authorization"] == f"Bearer {AKAHU_TOKEN}"


@pytest.mark.parametrize(
    "url",
    [
        "https://api.akahu.io/v1/payments",
        "https://api.akahu.io/v1/transfers",
        "https://api.akahu.io/v1/refresh",
        "https://api.akahu.io/v1/accounts/acc_1",
        # The per-account listing is never used, so it is not allowed either.
        "https://api.akahu.io/v1/accounts/acc_123abc/transactions",
        "https://api.akahu.io/v1/transactions/pending",
        "https://api.akahu.io/v1/accounts/acc_1/transactions/pending",
        "https://api.akahu.io/v1/accounts/../payments",
        "https://api.akahu.io/v1/accounts/%2e%2e/transactions",
        "https://api.akahu.io/v2/accounts",
        "https://api.akahu.io/v1/accounts/",
        "https://evil.akahu.io/v1/accounts",
        "https://beta-bridge.simplefin.org/simplefin/accounts",
    ],
)
def test_akahu_client_refuses_other_paths(url):
    rec = Recorder()
    with _client("akahu", rec) as client, pytest.raises(ConnectorError) as info:
        client.get_json(url)
    assert _err(info) == "host_not_allowed"
    assert rec.requests == []


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/",
        "/accounts",
        "/claim",
        "/claim/",
        "/claimx/X",
        "/x/claim/X",
    ],
)
def test_simplefin_client_posts_only_to_a_claim_path(path):
    rec = Recorder(httpx.Response(200, text=ACCESS_URL))
    with _client("simplefin", rec) as client, pytest.raises(ConnectorError) as info:
        client.post_text(BASE + path)
    assert _err(info) == "host_not_allowed"
    assert rec.requests == []


def test_simplefin_client_still_gets_under_simplefin():
    rec = Recorder(httpx.Response(200, json=[]))
    with _client("simplefin", rec) as client:
        assert client.get_json(BASE + "/accounts") == []
        assert client.post_text(BASE + "/claim/X") == "[]"
    assert [r.method for r in rec.requests] == ["GET", "POST"]


def test_akahu_client_refuses_post():
    rec = Recorder(httpx.Response(200, text="x"))
    with _client("akahu", rec) as client, pytest.raises(ConnectorError) as info:
        client.post_text("https://api.akahu.io/v1/accounts")
    assert _err(info) == "host_not_allowed"
    assert rec.requests == []


def test_demo_client_refuses_every_request():
    rec = Recorder()
    with _client("demo", rec) as client, pytest.raises(ConnectorError):
        client.get_json("https://beta-bridge.simplefin.org/simplefin/accounts")
    assert rec.requests == []


def test_unknown_provider_refused():
    with pytest.raises(ConnectorError) as info:
        SafeClient("nope")
    assert _err(info) == "bad_request"


def test_extra_host_request_allowed_only_in_server_mode(clean_env):
    clean_env.setenv("CONNECTORS_SIMPLEFIN_EXTRA_HOSTS", "sfin.example.org")
    rec = Recorder()
    with _client("simplefin", rec) as client:
        client.get_json("https://sfin.example.org/simplefin/accounts")
    clean_env.setenv("DYNO", "web.1")
    with _client("simplefin", rec) as client, pytest.raises(ConnectorError):
        client.get_json("https://sfin.example.org/simplefin/accounts")
    assert len(rec.requests) == 1


# --- responses ------------------------------------------------------------------


def test_post_text_claims_with_an_empty_body():
    rec = Recorder(httpx.Response(200, text=f"  {ACCESS_URL}\n"))
    with _client("simplefin", rec) as client:
        text = client.post_text(BASE + "/claim/DEMO-v2-ABC")
    assert text == ACCESS_URL
    (req,) = rec.requests
    assert req.method == "POST" and req.content == b""
    assert "authorization" not in req.headers


@pytest.mark.parametrize("status", [401, 403])
def test_post_text_maps_refusal_to_claim_refused(status):
    with _client("simplefin", Recorder(httpx.Response(status))) as client:
        with pytest.raises(ConnectorError) as info:
            client.post_text(BASE + "/claim/X")
    assert _err(info) == "claim_refused"


def test_post_text_caps_the_body():
    with _client("simplefin", Recorder(httpx.Response(200, text="x" * 10_000))) as client:
        with pytest.raises(ConnectorError) as info:
            client.post_text(BASE + "/claim/X")
    assert _err(info) == "response_too_large"


def test_post_text_refuses_non_utf8():
    with _client("simplefin", Recorder(httpx.Response(200, content=b"\xff\xfe"))) as client:
        with pytest.raises(ConnectorError) as info:
            client.post_text(BASE + "/claim/X")
    assert _err(info) == "provider_bad_response"


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirect_is_bad_response_and_never_followed(status):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url.host))
        return httpx.Response(status, headers={"Location": "https://169.254.169.254/latest"})

    with _client("simplefin", handler) as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_bad_response"
    assert seen == ["beta-bridge.simplefin.org"]


@pytest.mark.parametrize(
    "status, error_type",
    [
        (401, "reconnect_needed"),
        (403, "reconnect_needed"),
        (402, "payment_required"),
        (429, "provider_rate_limited"),
        (500, "provider_unavailable"),
        (502, "provider_unavailable"),
        (503, "provider_unavailable"),
        (400, "provider_bad_response"),
        (404, "provider_bad_response"),
        (204, "provider_bad_response"),
    ],
)
def test_status_mapping(status, error_type):
    with _client("simplefin", Recorder(httpx.Response(status, text="Body " + PASSWORD))) as c:
        with pytest.raises(ConnectorError) as info:
            c.get_json(BASE + "/accounts")
    assert _err(info) == error_type
    assert PASSWORD not in str(info.value)


def test_status_override():
    with _client("simplefin", Recorder(httpx.Response(404))) as client:
        with pytest.raises(ConnectorError) as info:
            client.get_json(BASE + "/accounts", status_errors={404: "reconnect_needed"})
    assert _err(info) == "reconnect_needed"


@pytest.mark.parametrize(
    "body",
    [b"<html>not json</html>", b"", b"\xff\xfe\x00", b"{\"a\": NaN}", b"[Infinity]", b"[" * 100_000],
)
def test_non_json_is_bad_response(body):
    with _client("simplefin", Recorder(httpx.Response(200, content=body))) as client:
        with pytest.raises(ConnectorError) as info:
            client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_bad_response"


def test_json_numbers_parse_as_decimal():
    from decimal import Decimal

    body = b'{"amount": -12.30, "count": 3}'
    with _client("akahu", Recorder(httpx.Response(200, content=body))) as client:
        data = client.get_json("https://api.akahu.io/v1/accounts")
    assert data == {"amount": Decimal("-12.30"), "count": 3}
    assert isinstance(data["amount"], Decimal)


def test_declared_oversize_body_refused_before_reading():
    reads: list[int] = []

    def gen():
        reads.append(1)
        yield b"{}"

    resp = httpx.Response(
        200,
        headers={"Content-Length": str(MAX_RESPONSE_BYTES + 1)},
        content=gen(),
    )
    with _client("simplefin", Recorder(resp)) as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "response_too_large"
    assert reads == []


def test_streamed_oversize_body_refused():
    chunk = b" " * (1024 * 1024)
    produced: list[int] = []

    def gen():
        for _ in range(64):  # 64 MB if read to the end
            produced.append(1)
            yield chunk

    resp = httpx.Response(200, content=gen())
    with _client("simplefin", Recorder(resp)) as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "response_too_large"
    assert len(produced) <= MAX_RESPONSE_BYTES // len(chunk) + 1


def test_body_at_the_cap_is_accepted():
    body = b"[" + b" " * (MAX_RESPONSE_BYTES - 2) + b"]"
    with _client("simplefin", Recorder(httpx.Response(200, content=body))) as client:
        assert client.get_json(BASE + "/accounts") == []


def test_slow_stream_past_wall_clock_is_timeout(monkeypatch):
    now = [1000.0]

    def gen():
        yield b"["
        now[0] += 25.0  # the provider trickles past the 20 s wall clock
        yield b"1"
        yield b"]"

    monkeypatch.setattr(http_mod, "time", types.SimpleNamespace(monotonic=lambda: now[0]))
    resp = httpx.Response(200, content=gen())
    with _client("simplefin", Recorder(resp)) as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_timeout"


def test_slow_headers_past_wall_clock_is_timeout(monkeypatch):
    now = [0.0]

    def handler(request):
        now[0] += 21.0
        return httpx.Response(200, json=[])

    monkeypatch.setattr(http_mod, "time", types.SimpleNamespace(monotonic=lambda: now[0]))
    with _client("simplefin", handler) as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_timeout"


@pytest.mark.parametrize(
    "exc, error_type",
    [
        (httpx.ConnectTimeout("t"), "provider_timeout"),
        (httpx.ReadTimeout("t"), "provider_timeout"),
        (httpx.PoolTimeout("t"), "provider_timeout"),
        (httpx.ConnectError("c " + PASSWORD), "provider_unavailable"),
        (httpx.ReadError("r"), "provider_unavailable"),
        (httpx.RemoteProtocolError("p"), "provider_unavailable"),
        (httpx.DecodingError("d"), "provider_bad_response"),
    ],
)
def test_transport_errors_map_to_fixed_codes(exc, error_type):
    def handler(request):
        raise exc

    with _client("simplefin", handler) as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == error_type
    assert info.value.__cause__ is None and info.value.__context__ is None
    assert PASSWORD not in str(info.value)


def test_client_is_built_without_env_trust_or_redirects(clean_env):
    clean_env.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    clean_env.setenv("ALL_PROXY", "http://127.0.0.1:9")
    clean_env.setenv("SSL_CERT_FILE", "/nonexistent/ca.pem")
    sc = SafeClient("simplefin")
    with sc._new_client() as client:
        assert client.trust_env is False
        assert client.follow_redirects is False
        assert client._mounts == {}
        assert client.auth is None
        assert isinstance(client._transport, http_mod.PinnedTransport)
        timeout = client.timeout
        assert (timeout.connect, timeout.read, timeout.pool) == (5.0, 15.0, 5.0)


def test_pinned_transport_verifies_tls():
    transport = http_mod.PinnedTransport()
    try:
        pool = transport._pool
        assert isinstance(pool, httpcore.ConnectionPool)
        assert isinstance(pool._network_backend, http_mod.PinnedBackend)
        ctx = pool._ssl_context
        assert ctx is not None
        assert ctx.verify_mode == ssl.CERT_REQUIRED
        assert ctx.check_hostname is True
    finally:
        transport.close()


# --- address vetting and pinning --------------------------------------------------


def _fake_getaddrinfo(answers: dict[str, list[str]], calls: list[str] | None = None):
    def fake(host, port, family=0, type=0, proto=0, flags=0):
        if calls is not None:
            calls.append(host)
        out = []
        for ip in answers[host]:
            fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
            sockaddr = (ip, port, 0, 0) if fam == socket.AF_INET6 else (ip, port)
            out.append((fam, socket.SOCK_STREAM, 6, "", sockaddr))
        return out

    return fake


class ConnectRecorder:
    def __init__(self):
        self.addresses: list[tuple[str, int]] = []

    def __call__(self, address, timeout=None, source_address=None, **kwargs):
        self.addresses.append(address)
        raise ConnectionRefusedError("refused")


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        str(ipaddress.IPv4Address(0)),  # unspecified
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "fe80::1%en0",
        "fd00:ec2::254",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "2002:7f00:1::1",
        "::",
        "64:ff9b::7f00:1",  # NAT64 of 127.0.0.1
        "64:ff9b::a9fe:a9fe",  # NAT64 of 169.254.169.254
        "64:ff9b::a00:1",  # NAT64 of 10.0.0.1
        "::7f00:1",  # IPv4-compatible 127.0.0.1
        "::a9fe:a9fe",  # IPv4-compatible 169.254.169.254
    ],
)
def test_private_resolution_refused_before_connect(monkeypatch, clean_env, ip):
    clean_env.setenv("CONNECTORS_SIMPLEFIN_EXTRA_HOSTS", "sfin.example.org")
    connect = ConnectRecorder()
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo({"sfin.example.org": [ip]}))
    monkeypatch.setattr(socket, "create_connection", connect)
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json("https://sfin.example.org/simplefin/accounts")
    assert _err(info) == "host_not_allowed"
    assert connect.addresses == []


def test_any_private_address_in_the_answer_refuses(monkeypatch):
    connect = ConnectRecorder()
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        _fake_getaddrinfo({"beta-bridge.simplefin.org": [PUBLIC_IP, "10.0.0.1"]}),
    )
    monkeypatch.setattr(socket, "create_connection", connect)
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "host_not_allowed"
    assert connect.addresses == []


def test_allowlisted_host_resolving_private_is_refused(monkeypatch):
    # DNS for an allowlisted name is vetted too (rebinding or a poisoned answer).
    connect = ConnectRecorder()
    monkeypatch.setattr(
        socket, "getaddrinfo", _fake_getaddrinfo({"beta-bridge.simplefin.org": ["127.0.0.1"]})
    )
    monkeypatch.setattr(socket, "create_connection", connect)
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "host_not_allowed"
    assert connect.addresses == []


def test_connection_is_pinned_to_the_vetted_address(monkeypatch, clean_env):
    clean_env.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    calls: list[str] = []
    connect = ConnectRecorder()
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        _fake_getaddrinfo({"beta-bridge.simplefin.org": [PUBLIC_IP]}, calls),
    )
    monkeypatch.setattr(socket, "create_connection", connect)
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts", auth=(USER, PASSWORD))
    assert _err(info) == "provider_unavailable"
    # Resolved once, then the socket went to the vetted IP: no second lookup by
    # the socket layer, and never to the proxy from the environment.
    assert calls == ["beta-bridge.simplefin.org"]
    assert connect.addresses == [(PUBLIC_IP, 443)]


def test_pinned_backend_tries_each_vetted_address(monkeypatch):
    connect = ConnectRecorder()
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        _fake_getaddrinfo({"api.akahu.io": [PUBLIC_IP, "2606:2800:220:1::1"]}),
    )
    monkeypatch.setattr(socket, "create_connection", connect)
    with pytest.raises(httpcore.ConnectError):
        http_mod.PinnedBackend().connect_tcp("api.akahu.io", 443, timeout=1.0)
    assert connect.addresses == [(PUBLIC_IP, 443), ("2606:2800:220:1::1", 443)]


def test_pinned_backend_passes_the_ip_and_keeps_hostname_for_tls(monkeypatch):
    seen: dict[str, Any] = {}

    def fake_super_connect(self, host, port, timeout=None, local_address=None, socket_options=None):
        seen["host"] = host
        seen["port"] = port
        return "stream"

    monkeypatch.setattr(httpcore.SyncBackend, "connect_tcp", fake_super_connect)
    monkeypatch.setattr(
        socket, "getaddrinfo", _fake_getaddrinfo({"api.akahu.io": [PUBLIC_IP]})
    )
    assert http_mod.PinnedBackend().connect_tcp("api.akahu.io", 443, timeout=1.0) == "stream"
    assert seen == {"host": PUBLIC_IP, "port": 443}


def test_resolution_failure_is_unavailable(monkeypatch):
    def fail(*args, **kwargs):
        raise socket.gaierror(8, "nodename nor servname provided")

    monkeypatch.setattr(socket, "getaddrinfo", fail)
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_unavailable"


def test_empty_resolution_is_unavailable(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [])
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_unavailable"


def test_unix_socket_connect_refused():
    with pytest.raises(ConnectorError):
        http_mod.PinnedBackend().connect_unix_socket("/var/run/docker.sock")


# --- privacy ----------------------------------------------------------------------


def test_no_secret_reaches_logs_at_debug(caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    caplog.set_level(logging.DEBUG, logger="src.connectors")
    caplog.set_level(logging.DEBUG, logger="httpx")
    caplog.set_level(logging.DEBUG, logger="httpcore")

    planted_account = "Planted Everyday Account"
    planted_merchant = "PLANTED MERCHANT 42"
    planted_amount = "-98765.43"
    body = json.dumps(
        {
            "accounts": [
                {
                    "name": planted_account,
                    "transactions": [
                        {"description": planted_merchant, "amount": planted_amount}
                    ],
                }
            ]
        }
    )
    split = check_simplefin_url(ACCESS_URL, kind="access")

    with _client("simplefin", Recorder(httpx.Response(200, text=body))) as client:
        client.get_json(split.base_url + "/accounts", auth=split.auth)
    with _client("akahu", Recorder(httpx.Response(401))) as client:
        with pytest.raises(ConnectorError):
            client.get_json(
                "https://api.akahu.io/v1/accounts",
                headers={"Authorization": f"Bearer {AKAHU_TOKEN}"},
            )
    with _client("simplefin", Recorder(httpx.Response(500, text=body))) as client:
        with pytest.raises(ConnectorError):
            client.get_json(split.base_url + "/accounts", auth=split.auth)

    def boom(request):
        raise httpx.ConnectError(f"failed {ACCESS_URL}")

    with _client("simplefin", boom) as client, pytest.raises(ConnectorError):
        client.get_json(split.base_url + "/accounts", auth=split.auth)
    with pytest.raises(ConnectorError):
        check_simplefin_url(ACCESS_URL.replace("beta-bridge", "evil"), kind="access")

    # Through the real transport, so httpcore's own debug lines are produced too.
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        _fake_getaddrinfo({"beta-bridge.simplefin.org": [PUBLIC_IP]}),
    )
    monkeypatch.setattr(socket, "create_connection", ConnectRecorder())
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError):
        client.get_json(split.base_url + "/accounts", auth=split.auth)

    text = caplog.text + "".join(str(r.args) for r in caplog.records)
    # Library records from SafeClient requests are dropped by the log filter;
    # only the module's own event line remains.
    assert not [r for r in caplog.records if r.name.split(".")[0] in ("httpx", "httpcore")]
    assert any(r.name == "src.connectors.http" for r in caplog.records)
    for planted in (
        PASSWORD,
        USER,
        base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode(),
        AKAHU_TOKEN,
        planted_account,
        planted_merchant,
        planted_amount,
    ):
        assert planted not in text, planted


# --- review hardening -------------------------------------------------------------


@pytest.mark.parametrize("encoding", ["gzip", "deflate", "br", "zstd", "gzip, identity"])
def test_compressed_body_refused(encoding):
    body = gzip.compress(b"[" + b" " * 1_000_000 + b"]")
    resp = httpx.Response(200, headers={"Content-Encoding": encoding}, content=iter([body]))
    with _client("simplefin", Recorder(resp)) as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_bad_response"


def test_identity_encoding_accepted():
    resp = httpx.Response(200, headers={"Content-Encoding": "Identity"}, content=b"[]")
    with _client("simplefin", Recorder(resp)) as client:
        assert client.get_json(BASE + "/accounts") == []


def _chain(exc: BaseException) -> list[BaseException]:
    out: list[BaseException] = []
    todo: list[BaseException | None] = [exc]
    while todo:
        cur = todo.pop()
        if cur is None or any(cur is seen for seen in out):
            continue
        out.append(cur)
        todo.extend([cur.__cause__, cur.__context__])
    return out


def _assert_clean_chain(exc: BaseException) -> None:
    basic = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
    chain = _chain(exc)
    assert chain == [exc], [type(e).__name__ for e in chain]
    for item in chain:
        assert getattr(item, "request", None) is None or isinstance(item, ConnectorError)
        text = repr(item) + str(item) + repr(item.args) + repr(vars(item))
        for planted in (PASSWORD, USER, basic, AKAHU_TOKEN, "Authorization", "Bearer"):
            assert planted not in text, planted


@pytest.mark.parametrize(
    "exc_type",
    [httpx.ConnectError, httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.DecodingError],
)
def test_error_chain_carries_no_request_or_credentials(exc_type):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"].startswith("Basic ")
        raise exc_type(f"failed {request.headers['authorization']}", request=request)

    with _client("simplefin", handler) as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts", auth=(USER, PASSWORD))
    _assert_clean_chain(info.value)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(401),
        httpx.Response(200, content=b"not json"),
        httpx.Response(302, headers={"Location": "https://evil.com/"}),
    ],
)
def test_status_and_parse_errors_have_no_chain(response):
    with _client("akahu", Recorder(response)) as client, pytest.raises(ConnectorError) as info:
        client.get_json(
            "https://api.akahu.io/v1/accounts",
            headers={"Authorization": f"Bearer {AKAHU_TOKEN}"},
        )
    _assert_clean_chain(info.value)


@pytest.mark.parametrize(
    "url",
    [
        f"https://{USER}:{PASSWORD}@beta-bridge.simplefin.org:99999/simplefin",
        f"https://{USER}:{PASSWORD}@beta-bridge.simplefin.org:x/simplefin",
        f"https://{USER}:{PASSWORD}@evil.com/simplefin",
    ],
)
def test_url_refusals_have_no_chain(url):
    with pytest.raises(ConnectorError) as info:
        check_simplefin_url(url, kind="access")
    _assert_clean_chain(info.value)
    with _client("simplefin", Recorder()) as client, pytest.raises(ConnectorError) as info:
        client.get_json(url)
    _assert_clean_chain(info.value)


def test_backend_refusal_has_no_chain(monkeypatch):
    monkeypatch.setattr(
        socket, "getaddrinfo", _fake_getaddrinfo({"beta-bridge.simplefin.org": ["10.0.0.1"]})
    )
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts", auth=(USER, PASSWORD))
    assert _err(info) == "host_not_allowed"
    _assert_clean_chain(info.value)


def test_parsed_url_repr_hides_userinfo():
    parsed = http_mod._parse(ACCESS_URL, http_mod.SIMPLEFIN_HOSTS)
    assert PASSWORD not in repr(parsed) and USER not in repr(parsed)


def test_ssl_key_log_file_is_ignored(clean_env, tmp_path):
    keylog = tmp_path / "keys.log"
    clean_env.setenv("SSLKEYLOGFILE", str(keylog))
    transport = http_mod.PinnedTransport()
    try:
        ctx = transport._pool._ssl_context
        assert ctx is not None
        assert ctx.keylog_filename is None
    finally:
        transport.close()
    assert not keylog.exists()


class FakeTlsStream:
    def __init__(self, record: dict[str, Any]):
        self.record = record

    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        self.record["server_hostname"] = server_hostname
        self.record["ssl_context"] = ssl_context
        raise httpcore.ConnectError("tls stopped by test")

    def close(self):
        self.record["closed"] = True

    def get_extra_info(self, info):
        return None


def test_tls_uses_the_hostname_while_the_socket_uses_the_ip(monkeypatch):
    record: dict[str, Any] = {}

    def fake_connect(self, host, port, timeout=None, local_address=None, socket_options=None):
        record["connect_host"] = host
        record["connect_port"] = port
        return FakeTlsStream(record)

    monkeypatch.setattr(httpcore.SyncBackend, "connect_tcp", fake_connect)
    monkeypatch.setattr(
        socket, "getaddrinfo", _fake_getaddrinfo({"beta-bridge.simplefin.org": [PUBLIC_IP]})
    )
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts", auth=(USER, PASSWORD))
    assert _err(info) == "provider_unavailable"
    assert record["connect_host"] == PUBLIC_IP
    assert record["connect_port"] == 443
    assert record["server_hostname"] == "beta-bridge.simplefin.org"
    assert record["ssl_context"].check_hostname is True
    assert record["ssl_context"].keylog_filename is None


@pytest.mark.parametrize("ip", ["64:ff9b::5db8:d822", "2606:2800:220:1::1", PUBLIC_IP])
def test_public_addresses_pass(ip):
    assert http_mod.is_public_address(ipaddress.ip_address(ip))


def test_connect_tries_at_most_two_addresses(monkeypatch):
    connect = ConnectRecorder()
    ips = ["93.184.216.34", "93.184.216.35", "93.184.216.36"]
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo({"api.akahu.io": ips}))
    monkeypatch.setattr(socket, "create_connection", connect)
    with pytest.raises(httpcore.ConnectError):
        http_mod.PinnedBackend().connect_tcp("api.akahu.io", 443, timeout=1.0)
    assert connect.addresses == [(ips[0], 443), (ips[1], 443)]


def test_stalled_dns_is_bounded_by_the_wall_clock(monkeypatch):
    release = threading.Event()

    def stalled(*args, **kwargs):
        release.wait(10)
        raise socket.gaierror(8, "late")

    monkeypatch.setattr(http_mod, "CALL_WALL_CLOCK_SECONDS", 0.3)
    monkeypatch.setattr(socket, "getaddrinfo", stalled)
    started = time.monotonic()
    try:
        with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
            client.get_json(BASE + "/accounts")
    finally:
        release.set()
    assert _err(info) == "provider_timeout"
    assert time.monotonic() - started < 1.5


def test_slow_connects_stay_within_the_wall_clock(monkeypatch):
    budget = 0.4
    timeouts: list[float] = []

    def slow_connect(address, timeout=None, source_address=None, **kwargs):
        timeouts.append(timeout)
        time.sleep(min(timeout, 2.0))
        raise ConnectionRefusedError("refused")

    monkeypatch.setattr(http_mod, "CALL_WALL_CLOCK_SECONDS", budget)
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        _fake_getaddrinfo({"beta-bridge.simplefin.org": [PUBLIC_IP, "93.184.216.35"]}),
    )
    monkeypatch.setattr(socket, "create_connection", slow_connect)
    started = time.monotonic()
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError) as info:
        client.get_json(BASE + "/accounts")
    elapsed = time.monotonic() - started
    assert _err(info) in ("provider_timeout", "provider_unavailable")
    assert timeouts and all(t <= budget for t in timeouts)
    assert elapsed < budget + 0.5


def test_request_timeouts_are_cut_to_the_time_left(monkeypatch):
    now = [100.0]
    seen: dict[str, Any] = {}

    def gen():
        yield b"["
        now[0] += 12.0  # 8 s left of the 20 s wall clock
        yield b"]"

    def handler(request: httpx.Request) -> httpx.Response:
        seen["request"] = request
        seen["initial"] = dict(request.extensions["timeout"])
        now[0] += 1.0
        return httpx.Response(200, content=gen())

    monkeypatch.setattr(http_mod, "time", types.SimpleNamespace(monotonic=lambda: now[0]))
    with _client("simplefin", handler) as client:
        assert client.get_json(BASE + "/accounts") == []
    assert seen["initial"]["read"] == 15.0
    assert seen["initial"]["connect"] == 5.0
    assert seen["request"].extensions["timeout"]["read"] <= 7.0


def test_initial_timeouts_never_exceed_the_wall_clock(monkeypatch):
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.extensions["timeout"])
        return httpx.Response(200, json=[])

    monkeypatch.setattr(http_mod, "CALL_WALL_CLOCK_SECONDS", 3.0)
    with _client("simplefin", handler) as client:
        client.get_json(BASE + "/accounts")
    assert all(v is not None and v <= 3.0 for v in seen.values()), seen



# --- overall deadline across several requests --------------------------------------


def _fake_clock(monkeypatch, start: float) -> list[float]:
    now = [start]
    monkeypatch.setattr(http_mod, "time", types.SimpleNamespace(monotonic=lambda: now[0]))
    return now


def test_an_overall_deadline_cuts_a_request_short(monkeypatch):
    now = _fake_clock(monkeypatch, 500.0)

    def handler(request: httpx.Request) -> httpx.Response:
        now[0] += 6.0  # well within the 20 s per-request clock
        return httpx.Response(200, json=[])

    transport = httpx.MockTransport(handler)
    with SafeClient("simplefin", transport=transport, deadline=505.0) as client:
        with pytest.raises(ConnectorError) as info:
            client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_timeout"


def test_the_deadline_spans_every_request_of_a_client(monkeypatch):
    now = _fake_clock(monkeypatch, 0.0)

    def handler(request: httpx.Request) -> httpx.Response:
        now[0] += 4.0
        return httpx.Response(200, json=[])

    recorder: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        recorder.append(request)
        return handler(request)

    transport = httpx.MockTransport(recording)
    with SafeClient("simplefin", transport=transport, deadline=10.0) as client:
        assert client.get_json(BASE + "/accounts") == []
        assert client.get_json(BASE + "/accounts") == []
        assert client.seconds_left() == pytest.approx(2.0)
        with pytest.raises(ConnectorError) as info:
            client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_timeout"
    assert len(recorder) == 3


def test_a_passed_deadline_sends_nothing(monkeypatch):
    _fake_clock(monkeypatch, 100.0)
    recorder = Recorder(httpx.Response(200, json=[]))
    transport = httpx.MockTransport(recorder)
    with SafeClient("simplefin", transport=transport, deadline=99.0) as client:
        assert client.seconds_left() == 0.0
        with pytest.raises(ConnectorError) as info:
            client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_timeout"
    assert recorder.requests == []


def test_the_per_request_clock_still_applies_under_a_later_deadline(monkeypatch):
    now = _fake_clock(monkeypatch, 0.0)

    def handler(request: httpx.Request) -> httpx.Response:
        now[0] += 21.0
        return httpx.Response(200, json=[])

    transport = httpx.MockTransport(handler)
    with SafeClient("simplefin", transport=transport, deadline=1000.0) as client:
        with pytest.raises(ConnectorError) as info:
            client.get_json(BASE + "/accounts")
    assert _err(info) == "provider_timeout"


def test_seconds_left_is_none_without_a_deadline():
    with _client("simplefin", Recorder()) as client:
        assert client.seconds_left() is None

# --- library logs never carry SafeClient URLs --------------------------------------

CLAIM_SECRET = "DEMO-v2-PLANTEDCLAIMSECRET"
ACCOUNT_ID = "ACT-PLANTED-0042"


def _library_logs_at_debug(caplog):
    caplog.set_level(logging.DEBUG)
    for name in http_mod._LIBRARY_LOGGERS:
        caplog.set_level(logging.DEBUG, logger=name)


def test_claim_path_not_in_library_logs(caplog):
    _library_logs_at_debug(caplog)
    with _client("simplefin", Recorder(httpx.Response(200, text=ACCESS_URL))) as client:
        client.post_text(BASE + "/claim/" + CLAIM_SECRET)
    assert CLAIM_SECRET not in caplog.text
    assert not [r for r in caplog.records if r.name.split(".")[0] in ("httpx", "httpcore")]


def test_get_query_not_in_library_logs(caplog):
    _library_logs_at_debug(caplog)
    rec = Recorder(httpx.Response(200, json={"accounts": []}))
    with _client("simplefin", rec) as client:
        client.get_json(
            BASE + "/accounts",
            auth=(USER, PASSWORD),
            params=[("account", ACCOUNT_ID), ("start-date", "1700000000")],
        )
    assert ACCOUNT_ID in str(rec.requests[0].url)  # the query was really sent
    assert ACCOUNT_ID not in caplog.text
    assert "1700000000" not in caplog.text


def test_real_transport_library_logs_are_dropped(caplog, monkeypatch):
    _library_logs_at_debug(caplog)
    monkeypatch.setattr(
        socket, "getaddrinfo", _fake_getaddrinfo({"beta-bridge.simplefin.org": [PUBLIC_IP]})
    )
    monkeypatch.setattr(socket, "create_connection", ConnectRecorder())
    with SafeClient("simplefin") as client, pytest.raises(ConnectorError):
        client.post_text(BASE + "/claim/" + CLAIM_SECRET)
    assert CLAIM_SECRET not in caplog.text
    assert not [r for r in caplog.records if r.name.split(".")[0] in ("httpx", "httpcore")]


def test_other_httpx_users_still_log(caplog):
    # The filter is scoped to SafeClient requests; the rest of the app keeps
    # its httpx logs, and logger levels are untouched.
    _library_logs_at_debug(caplog)
    level_before = logging.getLogger("httpx").level
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(204))) as plain:
        plain.get("https://example.org/elsewhere")
    assert "example.org/elsewhere" in caplog.text
    assert logging.getLogger("httpx").level == level_before


def test_filter_survives_logging_reconfiguration(caplog):
    _library_logs_at_debug(caplog)
    for name in http_mod._LIBRARY_LOGGERS:
        lib = logging.getLogger(name)
        for f in list(lib.filters):
            lib.removeFilter(f)
    with _client("simplefin", Recorder(httpx.Response(200, text=ACCESS_URL))) as client:
        client.post_text(BASE + "/claim/" + CLAIM_SECRET)
    assert CLAIM_SECRET not in caplog.text


def test_every_library_logger_is_filtered():
    import re as _re
    from pathlib import Path as _Path

    names: set[str] = set()
    for mod in (httpx, httpcore):
        root = _Path(mod.__file__).parent
        for path in root.rglob("*.py"):
            names.update(
                _re.findall(r"getLogger\(\s*[\"']([^\"']+)[\"']", path.read_text("utf-8"))
            )
    assert names and names <= set(http_mod._LIBRARY_LOGGERS), names - set(
        http_mod._LIBRARY_LOGGERS
    )
    for name in http_mod._LIBRARY_LOGGERS:
        assert any(
            isinstance(f, http_mod._DropSafeClientRecords)
            for f in logging.getLogger(name).filters
        ), name
