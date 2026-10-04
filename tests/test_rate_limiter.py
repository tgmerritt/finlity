"""Tests for rate limiting functionality."""

import os
import pytest
from unittest.mock import patch


class TestRateLimiterConfiguration:
    """Test rate limiter configuration and activation."""

    def test_rate_limiting_disabled_by_default(self):
        """Rate limiting should be disabled when env vars are not set."""
        from src.services.rate_limiter import RateLimiter

        with patch.dict(os.environ, {}, clear=True):
            limiter = RateLimiter()
            assert not limiter.is_active

    def test_rate_limiting_requires_enabled_flag(self):
        """Rate limiting requires RATE_LIMIT_ENABLED=true."""
        from src.services.rate_limiter import RateLimiter

        # Has secret key but not enabled
        with patch.dict(
            os.environ,
            {"RATE_LIMIT_SECRET_KEY": "a" * 32},
            clear=True,
        ):
            limiter = RateLimiter()
            assert not limiter.is_active

    def test_rate_limiting_requires_secret_key(self):
        """Rate limiting requires valid secret key."""
        from src.services.rate_limiter import RateLimiter

        # Enabled but no secret key
        with patch.dict(os.environ, {"RATE_LIMIT_ENABLED": "true"}, clear=True):
            limiter = RateLimiter()
            assert not limiter.is_active

    def test_rate_limiting_requires_min_key_length(self):
        """Secret key must be at least 32 characters."""
        from src.services.rate_limiter import RateLimiter

        # Key too short
        with patch.dict(
            os.environ,
            {
                "RATE_LIMIT_ENABLED": "true",
                "RATE_LIMIT_SECRET_KEY": "too_short",
            },
            clear=True,
        ):
            limiter = RateLimiter()
            assert not limiter.is_active

    def test_rate_limiting_activates_with_proper_config(self):
        """Rate limiting activates with proper configuration."""
        from src.services.rate_limiter import RateLimiter

        with patch.dict(
            os.environ,
            {
                "RATE_LIMIT_ENABLED": "true",
                "RATE_LIMIT_SECRET_KEY": "a" * 32,
            },
            clear=True,
        ):
            limiter = RateLimiter()
            assert limiter.is_active

    def test_custom_window_and_max_requests(self):
        """Custom window and max requests can be configured."""
        from src.services.rate_limiter import RateLimiter

        with patch.dict(
            os.environ,
            {
                "RATE_LIMIT_ENABLED": "true",
                "RATE_LIMIT_SECRET_KEY": "a" * 32,
                "RATE_LIMIT_WINDOW_SECONDS": "120",
                "RATE_LIMIT_MAX_REQUESTS": "30",
            },
            clear=True,
        ):
            limiter = RateLimiter()
            assert limiter.is_active
            stats = limiter.get_stats()
            assert stats["window_seconds"] == 120
            assert stats["max_requests"] == 30


class TestRateLimiterBehavior:
    """Test rate limiting behavior."""

    @pytest.fixture
    def active_limiter(self):
        """Create an active rate limiter for testing."""
        from src.services.rate_limiter import RateLimiter

        with patch.dict(
            os.environ,
            {
                "RATE_LIMIT_ENABLED": "true",
                "RATE_LIMIT_SECRET_KEY": "test_secret_key_at_least_32_chars_long",
                "RATE_LIMIT_MAX_REQUESTS": "5",  # Low limit for testing
                "RATE_LIMIT_WINDOW_SECONDS": "60",
            },
            clear=True,
        ):
            yield RateLimiter()

    def test_allows_requests_under_limit(self, active_limiter):
        """Requests under limit should be allowed."""
        for i in range(5):
            allowed, _ = active_limiter.check_rate_limit(
                "192.168.1.1", "/api/commentary/test"
            )
            assert allowed, f"Request {i + 1} should be allowed"

    def test_blocks_requests_over_limit(self, active_limiter):
        """Requests over limit should be blocked."""
        # Make 5 requests (the limit)
        for _ in range(5):
            allowed, _ = active_limiter.check_rate_limit(
                "192.168.1.1", "/api/commentary/test"
            )
            assert allowed

        # 6th request should be blocked
        allowed, retry_after = active_limiter.check_rate_limit(
            "192.168.1.1", "/api/commentary/test"
        )
        assert not allowed
        assert retry_after is not None
        assert retry_after > 0

    def test_different_ips_have_separate_limits(self, active_limiter):
        """Different IPs should have separate rate limits."""
        # Max out IP 1
        for _ in range(5):
            active_limiter.check_rate_limit("192.168.1.1", "/api/commentary/test")

        # Verify IP 1 is blocked
        allowed, _ = active_limiter.check_rate_limit(
            "192.168.1.1", "/api/commentary/test"
        )
        assert not allowed

        # IP 2 should still be allowed
        allowed, _ = active_limiter.check_rate_limit(
            "192.168.1.2", "/api/commentary/test"
        )
        assert allowed

    def test_inactive_limiter_allows_all(self):
        """Inactive limiter should allow all requests."""
        from src.services.rate_limiter import RateLimiter

        with patch.dict(os.environ, {}, clear=True):
            limiter = RateLimiter()
            assert not limiter.is_active

            # Should allow unlimited requests
            for _ in range(100):
                allowed, _ = limiter.check_rate_limit(
                    "192.168.1.1", "/api/commentary/test"
                )
                assert allowed

    def test_stats_tracking(self, active_limiter):
        """Stats should track active IPs."""
        # Make requests from multiple IPs
        active_limiter.check_rate_limit("192.168.1.1", "/api/commentary/test")
        active_limiter.check_rate_limit("192.168.1.2", "/api/commentary/test")
        active_limiter.check_rate_limit("192.168.1.3", "/api/commentary/test")

        stats = active_limiter.get_stats()
        assert stats["active"] is True
        assert stats["tracked_ips"] == 3


class TestRateLimitMiddleware:
    """Test rate limit middleware pattern matching."""

    def test_ai_endpoint_detection(self):
        """Test that AI endpoints are correctly identified."""
        from src.middleware.rate_limit import RateLimitMiddleware

        # Create middleware instance (without app for pattern testing)
        middleware = RateLimitMiddleware.__new__(RateLimitMiddleware)
        middleware._compiled_patterns = []

        import re

        from src.middleware.rate_limit import AI_ENDPOINT_PATTERNS

        middleware._compiled_patterns = [
            re.compile(pattern) for pattern in AI_ENDPOINT_PATTERNS
        ]

        # AI endpoints should match
        assert middleware._is_ai_endpoint("/api/commentary/test")
        assert middleware._is_ai_endpoint("/api/commentary/test/stream")
        assert middleware._is_ai_endpoint("/api/inference/providers")
        assert middleware._is_ai_endpoint("/api/analysis/advisor/chat")

        # Non-AI endpoints should not match
        assert not middleware._is_ai_endpoint("/api/portfolio/accounts")
        assert not middleware._is_ai_endpoint("/api/settings/config")
        assert not middleware._is_ai_endpoint("/api/budget/expenses")
        assert not middleware._is_ai_endpoint("/health")
        assert not middleware._is_ai_endpoint("/")


class TestRateLimiterSingleton:
    """Test rate limiter singleton behavior."""

    def test_reset_creates_new_instance(self):
        """Reset should create a new rate limiter instance."""
        from src.services.rate_limiter import (
            get_rate_limiter,
            reset_rate_limiter,
        )

        limiter1 = get_rate_limiter()
        reset_rate_limiter()
        limiter2 = get_rate_limiter()

        # Should be different instances
        assert limiter1 is not limiter2

    def test_singleton_returns_same_instance(self):
        """Multiple calls should return the same instance."""
        from src.services.rate_limiter import (
            get_rate_limiter,
            reset_rate_limiter,
        )

        reset_rate_limiter()
        limiter1 = get_rate_limiter()
        limiter2 = get_rate_limiter()

        # Should be same instance
        assert limiter1 is limiter2


class TestSmartImportRateLimitPatterns:
    """Smart import AI paths share the AI window; analyze and recurring have their own."""

    @staticmethod
    def _matcher():
        import re

        from src.middleware.rate_limit import AI_ENDPOINT_PATTERNS

        compiled = [re.compile(p) for p in AI_ENDPOINT_PATTERNS]
        return lambda path: any(p.match(path) for p in compiled)

    @pytest.mark.parametrize(
        "path",
        [
            "/api/v2/smart-import/categorize",
            "/api/v2/smart-import/extract",
            "/api/smart-import/categorize",
            "/api/smart-import/extract",
        ],
    )
    def test_ai_paths_are_limited(self, path):
        assert self._matcher()(path)

    @pytest.mark.parametrize(
        "path",
        [
            "/api/v2/smart-import/analyze",
            "/api/v2/smart-import/status",
            "/api/v2/smart-import/recurring",
            "/api/smart-import/ai-status",
            "/api/smart-import/context",
            "/api/smart-import/apply",
        ],
    )
    def test_other_paths_are_not_limited(self, path):
        assert not self._matcher()(path)

    def test_middleware_limits_per_forwarded_client_ip(self, monkeypatch):
        """Behind Heroku's router the client IP arrives in X-Forwarded-For."""
        from fastapi.testclient import TestClient

        from src.main import app
        from src.services.rate_limiter import reset_rate_limiter

        monkeypatch.setenv("DYNO", "web.1")
        monkeypatch.delenv("TRUSTED_PROXY_COUNT", raising=False)
        monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
        monkeypatch.setenv("RATE_LIMIT_SECRET_KEY", "k" * 40)
        monkeypatch.setenv("RATE_LIMIT_MAX_REQUESTS", "3")
        monkeypatch.setenv("RATE_LIMIT_WINDOW_SECONDS", "60")
        reset_rate_limiter()
        try:
            client = TestClient(app)
            path = "/api/v2/smart-import/categorize"
            first = {"X-Forwarded-For": "198.51.100.1, 203.0.113.7"}
            codes = [client.post(path, headers=first).status_code for _ in range(4)]
            assert codes[:3] != [429, 429, 429]
            assert 429 not in codes[:3]
            assert codes[3] == 429
            # a spoofed first entry cannot escape the bucket (Heroku appends the real IP)
            spoof = {"X-Forwarded-For": "8.8.8.8, 203.0.113.7"}
            assert client.post(path, headers=spoof).status_code == 429
            # another client behind the same router has its own window
            other = {"X-Forwarded-For": "198.51.100.1, 203.0.113.8"}
            assert client.post(path, headers=other).status_code != 429
            # analyze has its own window, so the exhausted AI window does not block it
            for _ in range(5):
                resp = client.post("/api/v2/smart-import/analyze", headers=first)
                assert resp.status_code != 429
        finally:
            monkeypatch.undo()
            reset_rate_limiter()


class TestSmartImportBulkLimits:
    """analyze and recurring are limited per client in windows of their own."""

    def test_rules_cover_analyze_and_recurring_only(self):
        from src.middleware.rate_limit import BULK_LIMITS

        names = {rule.name for rule in BULK_LIMITS}
        assert names == {"smart-import-analyze", "smart-import-recurring", "connectors"}
        for rule in BULK_LIMITS:
            if rule.name == "connectors":
                assert rule.max_requests == 10 and rule.window_seconds == 60
            else:
                assert rule.max_requests == 30 and rule.window_seconds == 60

        import re

        def bucket(path):
            return [r.name for r in BULK_LIMITS if re.match(r.path_pattern, path)]

        assert bucket("/api/v2/smart-import/analyze") == ["smart-import-analyze"]
        assert bucket("/api/v2/smart-import/recurring") == ["smart-import-recurring"]
        for path in (
            "/api/v2/smart-import/status",
            "/api/v2/smart-import/categorize",
            "/api/smart-import/ai-status",
            "/api/smart-import/apply",
        ):
            assert bucket(path) == []

    def test_buckets_are_counted_separately(self):
        from src.services.rate_limiter import RateLimiter

        with patch.dict(
            os.environ,
            {"RATE_LIMIT_ENABLED": "true", "RATE_LIMIT_SECRET_KEY": "k" * 40},
            clear=True,
        ):
            limiter = RateLimiter()
        ip = "192.0.2.10"
        for _ in range(10):
            assert limiter.check_rate_limit(ip, "/api/commentary/x")[0]
        assert not limiter.check_rate_limit(ip, "/api/commentary/x")[0]
        for _ in range(30):
            assert limiter.check_rate_limit(
                ip, "/a", bucket="b1", max_requests=30, window_seconds=60
            )[0]
        allowed, retry = limiter.check_rate_limit(
            ip, "/a", bucket="b1", max_requests=30, window_seconds=60
        )
        assert not allowed and retry and retry <= 61
        assert limiter.check_rate_limit(
            ip, "/b", bucket="b2", max_requests=30, window_seconds=60
        )[0]

    def test_middleware_limits_recurring_at_30_per_minute(self, monkeypatch):
        from fastapi.testclient import TestClient

        from src.main import app
        from src.services.rate_limiter import reset_rate_limiter

        monkeypatch.setenv("DYNO", "web.1")
        monkeypatch.delenv("TRUSTED_PROXY_COUNT", raising=False)
        monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
        monkeypatch.setenv("RATE_LIMIT_SECRET_KEY", "k" * 40)
        monkeypatch.setenv("RATE_LIMIT_MAX_REQUESTS", "3")
        reset_rate_limiter()
        try:
            client = TestClient(app)
            path = "/api/v2/smart-import/recurring"
            who = {"X-Forwarded-For": "198.51.100.1, 203.0.113.9"}
            codes = [client.post(path, json={}, headers=who).status_code for _ in range(31)]
            assert codes[:30] == [200] * 30
            assert codes[30] == 429
            # status stays unlimited and the AI window is untouched
            assert client.get("/api/v2/smart-import/status", headers=who).status_code == 200
            assert (
                client.post("/api/v2/smart-import/categorize", json={}, headers=who).status_code
                != 429
            )
        finally:
            monkeypatch.undo()
            reset_rate_limiter()


class TestConnectorsBucket:
    """Design 8.4: one ``connectors`` window of 10 per 60 s per client."""

    @staticmethod
    def _bucket(path, method="POST"):
        from src.middleware.rate_limit import RateLimitMiddleware

        rule = RateLimitMiddleware(app=None)._bulk_rule(method, path)
        return [] if rule is None else [rule.name]

    def test_bucket_matches_the_provider_calls_and_not_status(self):
        for path in (
            "/api/v2/connectors/simplefin/claim",
            "/api/v2/connectors/simplefin/accounts",
            "/api/v2/connectors/akahu/accounts",
            "/api/v2/connectors/demo/sync",
            "/api/v2/connectors/simplefin/sync",
            "/api/connections",
            "/api/connections/abc-123/sync",
            "/api/connections/abc-123/accounts",
            "/api/connections/abc-123/credentials",
        ):
            assert self._bucket(path) == ["connectors"], path
        for path in (
            "/api/v2/connectors/status",
            "/api/v2/connectors/simplefin/sync/extra",
            "/api/v2/connectors/simplefin/claimx",
            "/api/connections/abc-123",
            "/api/connections/abc-123/other",
            "/api/v2/smart-import/status",
        ):
            assert self._bucket(path) == [], path

    def test_only_writes_and_syncs_count_reads_are_unlimited(self):
        # Credentials and provider calls are POSTs (plan, PR B route table).
        # The list and detail reads, the mapping PUT and the disconnect
        # DELETE never reach a provider, so they stay out of the window.
        for method, path in (
            ("GET", "/api/connections"),
            ("GET", "/api/connections/abc-123"),
            ("PUT", "/api/connections/abc-123"),
            ("DELETE", "/api/connections/abc-123"),
            ("GET", "/api/connections/abc-123/sync"),
            ("HEAD", "/api/connections"),
            ("GET", "/api/v2/connectors/demo/sync"),
            ("GET", "/api/v2/connectors/status"),
        ):
            assert self._bucket(path, method) == [], (method, path)
        for path in (
            "/api/connections",
            "/api/connections/abc-123/sync",
            "/api/connections/abc-123/credentials",
            "/api/connections/abc-123/accounts",
            "/api/v2/connectors/demo/sync",
        ):
            assert self._bucket(path, "POST") == ["connectors"], path

    def test_a_rule_without_methods_matches_every_method(self):
        for method in ("GET", "POST", "PUT"):
            assert self._bucket("/api/v2/smart-import/analyze", method) == [
                "smart-import-analyze"
            ]

    def test_methods_on_the_connector_rules(self):
        from src.middleware.rate_limit import BULK_LIMITS

        rules = [r for r in BULK_LIMITS if r.name == "connectors"]
        assert len(rules) == 2
        assert all(r.methods == frozenset({"POST"}) for r in rules)

    def test_middleware_limits_connector_calls_at_10_per_minute(self, monkeypatch):
        from fastapi.testclient import TestClient

        from src.main import app
        from src.services.rate_limiter import reset_rate_limiter

        monkeypatch.setenv("DYNO", "web.1")
        monkeypatch.delenv("CONNECTORS_ENABLED", raising=False)
        monkeypatch.delenv("TRUSTED_PROXY_COUNT", raising=False)
        monkeypatch.setenv("RATE_LIMIT_ENABLED", "true")
        monkeypatch.setenv("RATE_LIMIT_SECRET_KEY", "k" * 40)
        reset_rate_limiter()
        try:
            client = TestClient(app)
            who = {"X-Forwarded-For": "198.51.100.1, 203.0.113.21"}
            path = "/api/v2/connectors/demo/accounts"
            codes = [
                client.post(path, json={"credentials": {}}, headers=who).status_code
                for _ in range(11)
            ]
            assert codes[:10] == [200] * 10
            assert codes[10] == 429
            # one window across the connector routes
            sync = client.post(
                "/api/v2/connectors/demo/sync", json={}, headers=who
            )
            assert sync.status_code == 429
            # status stays unlimited; another client has its own window
            assert client.get("/api/v2/connectors/status", headers=who).status_code == 200
            # reads of the connections list are never in the window (the
            # route arrives in PR B, so 404 here proves it passed through)
            assert client.get("/api/connections", headers=who).status_code != 429
            other = {"X-Forwarded-For": "198.51.100.1, 203.0.113.22"}
            assert client.post(path, json={"credentials": {}}, headers=other).status_code == 200
        finally:
            monkeypatch.undo()
            reset_rate_limiter()
