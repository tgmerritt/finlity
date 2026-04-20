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
