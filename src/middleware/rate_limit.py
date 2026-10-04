"""
Rate limiting middleware for AI API endpoints.

This middleware:
- Only processes requests to AI endpoints
- Returns 429 when rate limit is exceeded
- Provides no information about rate limit state to clients
- Cannot be bypassed via headers, params, or injection
"""

import re
from typing import Callable

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from src.services.rate_limiter import RateLimitConfig, get_rate_limiter
from src.utils.client_ip import get_client_ip


# Patterns for AI endpoints that should be rate limited
AI_ENDPOINT_PATTERNS: list[str] = [
    r"^/api/commentary/",
    r"^/api/inference/",
    r"^/api/analysis/advisor/",
    # Smart import AI calls. analyze and recurring use BULK_LIMITS instead: this
    # window is shared per client IP, so a 12-file batch would exhaust it.
    r"^/api/smart-import/(categorize|extract)",
    r"^/api/v2/smart-import/(categorize|extract)",
]

# Generous per-client limits for the stateless smart import work routes, each
# in a window of its own so they never eat into the AI window above. Status
# stays unlimited.
BULK_LIMITS: list[RateLimitConfig] = [
    RateLimitConfig(
        max_requests=30,
        window_seconds=60,
        path_pattern=r"^/api/v2/smart-import/analyze$",
        name="smart-import-analyze",
    ),
    RateLimitConfig(
        max_requests=30,
        window_seconds=60,
        path_pattern=r"^/api/v2/smart-import/recurring$",
        name="smart-import-recurring",
    ),
    # Connector calls that reach a bank data provider (design 8.4): one shared
    # window of 10 per 60 s per client for the stateless v2 routes and the
    # server-mode connection routes (PR B). Both rules use the bucket name
    # "connectors", so they count together. Only POST counts: every route
    # that takes a credential or calls a provider is a POST (create, replace
    # credentials, refresh accounts, sync), while the list and detail GETs,
    # the mapping PUT and the disconnect DELETE never reach a provider, so a
    # page that refetches the list cannot use up the window. Status stays
    # unlimited.
    RateLimitConfig(
        max_requests=10,
        window_seconds=60,
        path_pattern=r"^/api/v2/connectors/[a-z]+/(claim|accounts|sync)$",
        name="connectors",
        methods=frozenset({"POST"}),
    ),
    RateLimitConfig(
        max_requests=10,
        window_seconds=60,
        path_pattern=r"^/api/connections(/[^/]+/(sync|accounts|credentials))?$",
        name="connectors",
        methods=frozenset({"POST"}),
    ),
]


class RateLimitMiddleware(BaseHTTPMiddleware):
    """
    Middleware that enforces rate limits on AI API endpoints.

    Security features:
    - Only activates when properly configured (env vars + secret key)
    - Does not expose rate limit state to clients
    - Cannot be bypassed via headers, params, or injection
    """

    def __init__(self, app: ASGIApp):
        super().__init__(app)
        self._compiled_patterns = [
            re.compile(pattern) for pattern in AI_ENDPOINT_PATTERNS
        ]
        self._bulk_rules = [
            (re.compile(rule.path_pattern), rule) for rule in BULK_LIMITS
        ]

    def _is_ai_endpoint(self, path: str) -> bool:
        """Check if path is an AI endpoint that should be rate limited."""
        return any(pattern.match(path) for pattern in self._compiled_patterns)

    def _bulk_rule(self, method: str, path: str) -> RateLimitConfig | None:
        """The BULK_LIMITS rule for this method and path, if any."""
        for pattern, rule in self._bulk_rules:
            if rule.methods is not None and method.upper() not in rule.methods:
                continue
            if pattern.match(path):
                return rule
        return None

    def _get_client_ip(self, request: Request) -> str:
        """Client IP via the shared trusted-proxy helper.

        The limiter store is in memory, so limits are per process (per dyno on
        Heroku), not global across dynos.
        """
        return get_client_ip(request)

    async def dispatch(self, request: Request, call_next: Callable):
        """Process request and enforce rate limits."""
        path = request.url.path

        # Only rate limit AI endpoints and the BULK_LIMITS routes
        is_ai = self._is_ai_endpoint(path)
        bulk = None if is_ai else self._bulk_rule(request.method, path)
        if not is_ai and bulk is None:
            return await call_next(request)

        rate_limiter = get_rate_limiter()

        # If rate limiting is not active, allow all requests
        if not rate_limiter.is_active:
            return await call_next(request)

        # Check rate limit
        client_ip = self._get_client_ip(request)
        if bulk is None:
            allowed, retry_after = rate_limiter.check_rate_limit(client_ip, path)
        else:
            allowed, retry_after = rate_limiter.check_rate_limit(
                client_ip,
                path,
                bucket=bulk.name,
                max_requests=bulk.max_requests,
                window_seconds=bulk.window_seconds,
            )

        if not allowed:
            # Return 429 with minimal information (no rate limit state exposed)
            return JSONResponse(
                status_code=429,
                content={
                    "detail": "Rate limit exceeded. Please try again later.",
                    "error_type": "rate_limit_exceeded",
                },
                headers={"Retry-After": str(retry_after or 60)},
            )

        return await call_next(request)
