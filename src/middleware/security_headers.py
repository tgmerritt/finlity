"""Security headers middleware.

Adds defensive HTTP response headers recommended by OWASP, including a
Content-Security-Policy tuned to the app's real inventory:

- Scripts: self (the built bundle) + Plotly + marked from their CDNs.
  ``script-src`` has NO 'unsafe-inline' and NO 'unsafe-eval'. The dashboard's
  legacy inline onclick attributes are covered by ``script-src-attr
  'unsafe-inline'`` (event handlers only), so injected inline ``<script>``
  blocks and eval() are still blocked. Verified: Plotly 2.27's only Function
  constructor usage is the standard global-object polyfill wrapped in
  try/catch that falls back to ``window``, so it works without unsafe-eval.
- Styles: self + AntD reset CDN + Google Fonts CSS, with 'unsafe-inline' for
  inline style attributes (the dashboard sets element styles from JS).
- Fonts: self + fonts.gstatic.com.
- Frames: self + YouTube (demo embed).
- Locked down: object-src 'none' (no plugins), base-uri 'self' (no base-tag
  injection), form-action 'self', frame-ancestors 'none' (clickjacking),
  connect-src 'self' (no data exfiltration to third-party origins).

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
        "Content-Security-Policy": (
            "default-src 'self'; "
            "script-src 'self' https://cdn.plot.ly https://cdn.jsdelivr.net; "
            "script-src-attr 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline' "
            "https://cdnjs.cloudflare.com https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "img-src 'self' data: blob: https:; "
            "frame-src 'self' https://www.youtube.com; "
            "connect-src 'self'; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "form-action 'self'; "
            "frame-ancestors 'none'"
        ),
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
