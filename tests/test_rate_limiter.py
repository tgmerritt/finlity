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
