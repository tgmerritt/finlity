"""Security headers middleware.

Adds defensive HTTP response headers recommended by OWASP. A proper
Content-Security-Policy is deliberately NOT included here: the current
dashboard serves inline scripts and loads Plotly/Antd reset from CDNs, so a
meaningful CSP requires a separate follow-up to add nonces and inline-free
templates.

HSTS is only emitted for requests that reached us over HTTPS. Heroku
terminates TLS in front of the dyno and forwards the original scheme via the
``X-Forwarded-Proto`` header, which this middleware inspects in addition to
``request.url.scheme``.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach conservative security headers to every response."""

    _STATIC_HEADERS = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
        "Cross-Origin-Opener-Policy": "same-origin",
    }
    _HSTS_HEADER = "max-age=31536000; includeSubDomains; preload"

    def __init__(self, app: ASGIApp, *, force_https: bool = False) -> None:
        super().__init__(app)
        self._force_https = force_https

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        response: Response = await call_next(request)
        for name, value in self._STATIC_HEADERS.items():
            response.headers.setdefault(name, value)

        if self._is_https(request):
            response.headers.setdefault(
                "Strict-Transport-Security", self._HSTS_HEADER
            )
        return response

    def _is_https(self, request: Request) -> bool:
        if self._force_https:
            return True
        if request.url.scheme == "https":
            return True
        forwarded_proto = request.headers.get("x-forwarded-proto", "")
        return forwarded_proto.split(",")[0].strip().lower() == "https"
