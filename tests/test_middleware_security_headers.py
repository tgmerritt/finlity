"""Tests for SecurityHeadersMiddleware."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.middleware.security_headers import SecurityHeadersMiddleware


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)

    @app.get("/ping")
    def ping() -> dict[str, str]:
        return {"ok": "1"}

    return TestClient(app)


def test_static_headers_on_http(client: TestClient) -> None:
    resp = client.get("/ping")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["x-frame-options"] == "DENY"
    assert resp.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "camera=()" in resp.headers["permissions-policy"]
    assert resp.headers["cross-origin-opener-policy"] == "same-origin"


def test_csp_is_strict(client: TestClient) -> None:
    """CSP must exist, allow only known CDNs, and never enable JS eval."""
    resp = client.get("/ping")
    csp = resp.headers["content-security-policy"]
    assert "script-src 'self' 'wasm-unsafe-eval' https://cdn.plot.ly https://cdn.jsdelivr.net" in csp
    # Inline onclick handlers are allowed via script-src-attr ONLY; the
    # script-src directive itself must not carry 'unsafe-inline' or
    # JS 'unsafe-eval'. ('unsafe-inline' in style-src is fine — the dashboard
    # sets element styles from JS.)
    script_src = csp.split(";")[1].strip()
    assert script_src.startswith("script-src ")
    assert "'unsafe-inline'" not in script_src
    # 'wasm-unsafe-eval' is allowed (sql.js), but the bare 'unsafe-eval'
    # token must never appear (that would enable JS eval()).
    assert "'unsafe-eval'" not in [t.strip() for t in csp.replace("'", "").split() if t.strip() in ("unsafe-eval",)]
    assert "object-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp
    assert "connect-src 'self'" in csp
    assert "https://www.youtube.com" in csp


def test_csp_allows_wasm_for_sqljs(client: TestClient) -> None:
    """The app's sql.js (WebAssembly SQLite) local-first mode requires
    CSP3 'wasm-unsafe-eval' — WASM compilation without JS eval()."""
    resp = client.get("/ping")
    csp = resp.headers["content-security-policy"]
    assert "'wasm-unsafe-eval'" in csp
    assert "'unsafe-eval'" not in [t.strip() for t in csp.replace("'", "").split() if t.strip() in ("unsafe-eval",)]


def test_csp_has_no_unsafe_eval_or_script_unsafe_inline(client: TestClient) -> None:
    resp = client.get("/ping")
    csp = resp.headers["content-security-policy"]
    assert "'unsafe-eval'" not in [t.strip() for t in csp.replace("'", "").split() if t.strip() in ("unsafe-eval",)]
    assert "script-src 'self' 'wasm-unsafe-eval' https://cdn.plot.ly https://cdn.jsdelivr.net" in csp


def test_hsts_absent_on_http(client: TestClient) -> None:
    resp = client.get("/ping")
    assert "strict-transport-security" not in {k.lower() for k in resp.headers}


def test_hsts_present_when_forwarded_proto_https(client: TestClient) -> None:
    resp = client.get("/ping", headers={"X-Forwarded-Proto": "https"})
    assert "strict-transport-security" in {k.lower() for k in resp.headers}
    assert "max-age=31536000" in resp.headers["strict-transport-security"]


def test_hsts_picks_first_forwarded_proto_value(client: TestClient) -> None:
    resp = client.get("/ping", headers={"X-Forwarded-Proto": "https, http"})
    assert "strict-transport-security" in {k.lower() for k in resp.headers}
