"""Client IP resolution behind trusted proxies.

X-Forwarded-For is a list the client can pre-fill; each trusted proxy appends the
address it saw to the right end. Only the entries added by our own proxies can
be believed, so the client address is the entry ``TRUSTED_PROXY_COUNT`` hops
from the right. With no trusted proxy the header is ignored entirely.
"""

from __future__ import annotations

import ipaddress
import os

from starlette.requests import Request

_MAX_TRUSTED = 10


def trusted_proxy_count() -> int:
    """Hops to trust: ``TRUSTED_PROXY_COUNT`` if valid, else 1 on Heroku (DYNO), else 0."""
    raw = os.environ.get("TRUSTED_PROXY_COUNT", "").strip()
    if raw:
        try:
            return max(0, min(int(raw), _MAX_TRUSTED))
        except ValueError:
            pass
    return 1 if os.environ.get("DYNO") else 0


def get_client_ip(request: Request) -> str:
    """Return the client address for rate limiting and similar per-client keys."""
    direct = request.client.host if request.client else "unknown"
    hops = trusted_proxy_count()
    if hops == 0:
        return direct
    # Repeated header lines are one list in order (RFC 9110 5.3); reading only
    # the first line would let a client-sent line hide the proxy's entry.
    header = ",".join(request.headers.getlist("x-forwarded-for"))
    entries = [part.strip() for part in header.split(",") if part.strip()]
    if len(entries) < hops:
        return direct
    candidate = entries[-hops]
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return direct
