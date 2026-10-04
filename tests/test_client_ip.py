"""Client IP resolution behind trusted proxies."""

from types import SimpleNamespace

import pytest
from starlette.datastructures import Headers

from src.utils.client_ip import get_client_ip, trusted_proxy_count


def _req(xff=None, host="10.1.1.1"):
    """A request stand-in; ``xff`` may be a list for repeated header lines."""
    values = [] if xff is None else ([xff] if isinstance(xff, str) else xff)
    headers = Headers(raw=[(b"x-forwarded-for", v.encode()) for v in values])
    return SimpleNamespace(headers=headers, client=SimpleNamespace(host=host))


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("DYNO", raising=False)
    monkeypatch.delenv("TRUSTED_PROXY_COUNT", raising=False)


def test_local_ignores_header():
    assert trusted_proxy_count() == 0
    assert get_client_ip(_req("203.0.113.9")) == "10.1.1.1"


def test_heroku_takes_rightmost_and_spoofed_first_entry_is_ignored(monkeypatch):
    monkeypatch.setenv("DYNO", "web.1")
    assert trusted_proxy_count() == 1
    honest = get_client_ip(_req("198.51.100.4"))
    spoofed = get_client_ip(_req("1.2.3.4, 5.6.7.8, 198.51.100.4"))
    assert honest == spoofed == "198.51.100.4"


def test_two_trusted_hops(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXY_COUNT", "2")
    assert get_client_ip(_req("9.9.9.9, 198.51.100.4, 10.0.0.2")) == "198.51.100.4"


def test_explicit_zero_on_heroku_ignores_header(monkeypatch):
    monkeypatch.setenv("DYNO", "web.1")
    monkeypatch.setenv("TRUSTED_PROXY_COUNT", "0")
    assert get_client_ip(_req("203.0.113.9")) == "10.1.1.1"


@pytest.mark.parametrize(
    "xff", [None, "", " , ", "not-an-ip", "1.2.3.4, garbage", "<script>"]
)
def test_empty_or_malformed_header_falls_back(monkeypatch, xff):
    monkeypatch.setenv("DYNO", "web.1")
    assert get_client_ip(_req(xff)) == "10.1.1.1"


def test_fewer_entries_than_hops_falls_back(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXY_COUNT", "3")
    assert get_client_ip(_req("1.2.3.4")) == "10.1.1.1"


def test_no_client_is_unknown():
    req = SimpleNamespace(headers={}, client=None)
    assert get_client_ip(req) == "unknown"


def test_bad_env_value_uses_default(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXY_COUNT", "lots")
    monkeypatch.setenv("DYNO", "web.1")
    assert trusted_proxy_count() == 1


def test_repeated_header_lines_are_joined_in_order(monkeypatch):
    """A client-sent line cannot hide the address the proxy appended in its own line."""
    monkeypatch.setenv("DYNO", "web.1")
    assert get_client_ip(_req(["8.8.8.8", "198.51.100.4"])) == "198.51.100.4"
    monkeypatch.setenv("TRUSTED_PROXY_COUNT", "2")
    assert (
        get_client_ip(_req(["9.9.9.9, 198.51.100.4", "10.0.0.2"])) == "198.51.100.4"
    )
