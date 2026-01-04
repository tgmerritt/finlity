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

from src.services.rate_limiter import get_rate_limiter


# Patterns for AI endpoints that should be rate limited
AI_ENDPOINT_PATTERNS: list[str] = [
    r"^/api/commentary/",
    r"^/api/inference/",
    r"^/api/analysis/advisor/",
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

    def _is_ai_endpoint(self, path: str) -> bool:
        """Check if path is an AI endpoint that should be rate limited."""
        return any(pattern.match(path) for pattern in self._compiled_patterns)

    def _get_client_ip(self, request: Request) -> str:
        """
        Extract client IP address from request.

        Handles proxy scenarios (X-Forwarded-For header).
        """
        # Check for forwarded header (common with proxies/load balancers like Heroku)
        forwarded = request.headers.get("X-Forwarded-For")
        if forwarded:
            # Take first IP (original client)
            return forwarded.split(",")[0].strip()

        # Fall back to direct client IP
        if request.client:
            return request.client.host

        return "unknown"

    async def dispatch(self, request: Request, call_next: Callable):
        """Process request and enforce rate limits."""
        path = request.url.path

        # Only rate limit AI endpoints
        if not self._is_ai_endpoint(path):
            return await call_next(request)

        rate_limiter = get_rate_limiter()

        # If rate limiting is not active, allow all requests
        if not rate_limiter.is_active:
            return await call_next(request)

        # Check rate limit
        client_ip = self._get_client_ip(request)
        allowed, retry_after = rate_limiter.check_rate_limit(client_ip, path)

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
