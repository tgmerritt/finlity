"""
Rate limiting service for AI API endpoints.

This module provides server-side rate limiting that:
- Only activates when RATE_LIMIT_ENABLED=true AND a valid secret key is set
- Uses sliding window algorithm with per-IP tracking
- Provides zero client visibility into rate limit state
- Protects AI commentary and inference endpoints from abuse
"""

import hashlib
import hmac
import os
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Optional


# Minimum secret key length for security
MIN_SECRET_KEY_LENGTH = 32


def _get_env_bool(name: str, default: bool = False) -> bool:
    """Get boolean environment variable."""
    value = os.environ.get(name, "").lower()
    if value in ("true", "1", "yes"):
        return True
    if value in ("false", "0", "no"):
        return False
    return default


@dataclass
class RateLimitConfig:
    """Configuration for a rate limit rule."""

    max_requests: int
    window_seconds: int
    path_pattern: str  # Regex pattern for matching paths


class RateLimiter:
    """
    Thread-safe sliding window rate limiter.

    Uses in-memory storage with automatic cleanup of expired entries.
    Only activates when properly configured with environment variables.
    """

    def __init__(self, max_entries: int = 10000):
        """
        Initialize rate limiter.

        Args:
            max_entries: Maximum number of IPs to track (LRU eviction)
        """
        self._store: dict[str, list[float]] = defaultdict(list)
        self._lock = threading.Lock()
        self._max_entries = max_entries

        # Load configuration from environment
        self._enabled = _get_env_bool("RATE_LIMIT_ENABLED", False)
        self._secret_key = os.environ.get("RATE_LIMIT_SECRET_KEY", "")
        self._window_seconds = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "60"))
        self._max_requests = int(os.environ.get("RATE_LIMIT_MAX_REQUESTS", "10"))

        # Compute integrity token and verify configuration
        self._integrity_token = self._compute_integrity_token()
        self._is_active = self._verify_configuration()

        if self._is_active:
            print(f"Rate limiting ACTIVE: {self._max_requests} req/{self._window_seconds}s per IP")

    def _compute_integrity_token(self) -> str:
        """
        Compute HMAC token proving rate limiting is properly configured.

        This ensures that even if someone sets RATE_LIMIT_ENABLED=true,
        rate limiting won't activate without the proper secret key.
        """
        if not self._secret_key:
            return ""
        message = b"rate_limit_system_active_v1"
        return hmac.new(
            self._secret_key.encode(),
            message,
            hashlib.sha256,
        ).hexdigest()

    def _verify_configuration(self) -> bool:
        """Verify rate limiting is properly configured."""
        if not self._enabled:
            return False
        if not self._secret_key:
            return False
        if len(self._secret_key) < MIN_SECRET_KEY_LENGTH:
            return False
        # Verify integrity token is valid (proves key exists and is usable)
        return len(self._integrity_token) == 64

    @property
    def is_active(self) -> bool:
        """Check if rate limiting is active."""
        return self._is_active

    def check_rate_limit(
        self,
        client_ip: str,
        path: str,
    ) -> tuple[bool, Optional[int]]:
        """
        Check if request is within rate limits.

        Args:
            client_ip: Client IP address
            path: Request path (unused for now, all AI endpoints use same limit)

        Returns:
            Tuple of (allowed: bool, retry_after_seconds: Optional[int])
        """
        if not self._is_active:
            return (True, None)

        now = time.time()
        window_start = now - self._window_seconds

        with self._lock:
            # Clean up old entries for this IP
            self._cleanup_expired(client_ip, window_start)

            # Get current request count
            timestamps = self._store[client_ip]
            request_count = len(timestamps)

            if request_count >= self._max_requests:
                # Rate limit exceeded
                oldest = min(timestamps) if timestamps else now
                retry_after = int(oldest + self._window_seconds - now) + 1
                return (False, max(retry_after, 1))

            # Allow request and record timestamp
            timestamps.append(now)

            # Evict oldest entries if store is too large
            self._evict_if_needed()

            return (True, None)

    def _cleanup_expired(self, client_ip: str, window_start: float) -> None:
        """Remove timestamps older than window start."""
        if client_ip in self._store:
            self._store[client_ip] = [
                ts for ts in self._store[client_ip] if ts > window_start
            ]
            if not self._store[client_ip]:
                del self._store[client_ip]

    def _evict_if_needed(self) -> None:
        """Evict oldest entries if store exceeds max size."""
        if len(self._store) > self._max_entries:
            # Remove entries with oldest last access
            oldest_ip = min(
                self._store.keys(),
                key=lambda ip: max(self._store[ip]) if self._store[ip] else 0,
            )
            del self._store[oldest_ip]

    def get_stats(self) -> dict:
        """Get rate limiter statistics (for internal use only)."""
        with self._lock:
            return {
                "active": self._is_active,
                "tracked_ips": len(self._store),
                "max_requests": self._max_requests,
                "window_seconds": self._window_seconds,
            }


# Global rate limiter instance (singleton)
_rate_limiter: Optional[RateLimiter] = None
_rate_limiter_lock = threading.Lock()


def get_rate_limiter() -> RateLimiter:
    """Get the global rate limiter instance (thread-safe singleton)."""
    global _rate_limiter
    if _rate_limiter is None:
        with _rate_limiter_lock:
            # Double-check locking pattern
            if _rate_limiter is None:
                _rate_limiter = RateLimiter()
    return _rate_limiter


def is_rate_limiting_active() -> bool:
    """Check if rate limiting is currently active."""
    return get_rate_limiter().is_active


def reset_rate_limiter() -> None:
    """Reset the rate limiter instance (for testing only)."""
    global _rate_limiter
    with _rate_limiter_lock:
        _rate_limiter = None
