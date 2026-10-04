"""Per-process daily quota backstop for the stateless v2 connector routes
(design 8.4, decision E7).

The data layer (PR B) is the primary guard: it counts provider calls per
connection. A modified hosted client could skip that guard, so the v2 routes
also count calls here, per credential, over a rolling 24 hours, with the same
budget (``limits.DAILY_BUDGET``: SimpleFIN 20, Akahu 48; demo unlimited).

The counter never holds a credential. It is keyed by an HMAC-SHA256 of the
parsed credential under a random key drawn once at import (process start) and
never stored, logged or returned, so a fingerprint cannot be reversed or
recomputed outside this process.

Scope: per process. On Heroku that means per dyno, and a restart forgets every
count; the data-layer count is what survives. Memory is bounded: expired
entries are pruned, and past ``max_keys`` the least recently added credential
is evicted (fail open for the backstop only; the per-IP ``connectors`` rate
limit bounds how fast fake credentials can be minted).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable

from .errors import ConnectorError
from .limits import DAILY_BUDGET
from .types import AkahuCredentials, Credentials, SimpleFinCredentials

WINDOW_SECONDS = 24 * 60 * 60
MAX_TRACKED_KEYS = 20_000

# Drawn once per process; never stored or sent anywhere.
_KEY = secrets.token_bytes(32)


def fingerprint(creds: Credentials) -> str | None:
    """A keyed hash of a credential, or None for a provider with no secret.

    SimpleFIN is keyed by user and password only: ``bridge`` and
    ``beta-bridge`` are one service, so switching host must not reset the
    count. Akahu is keyed by both tokens.
    """
    material: list[str]
    if isinstance(creds, SimpleFinCredentials):
        material = ["simplefin", creds.username, creds.password]
    elif isinstance(creds, AkahuCredentials):
        material = ["akahu", creds.user_token, creds.app_token]
    else:
        return None
    # JSON keeps the parts unambiguous whatever characters they contain.
    data = json.dumps(material, ensure_ascii=True).encode("ascii")
    return hmac.new(_KEY, data, hashlib.sha256).hexdigest()


class ProcessQuota:
    """Rolling 24-hour call counter per (provider, credential fingerprint)."""

    def __init__(
        self,
        *,
        now: Callable[[], float] = time.time,
        max_keys: int = MAX_TRACKED_KEYS,
    ) -> None:
        self._now = now
        self._max_keys = max_keys
        self._lock = threading.Lock()
        self._calls: OrderedDict[tuple[str, str], deque[float]] = OrderedDict()

    def tracked(self) -> int:
        with self._lock:
            return len(self._calls)

    def check_and_record(
        self, provider_id: str, credential_fingerprint: str | None
    ) -> None:
        """Count one provider call, or raise ``quota_reached`` when the budget
        for this credential is used up. Unbudgeted providers (demo) pass."""
        self._count(provider_id, credential_fingerprint, enforce=True)

    def record(self, provider_id: str, credential_fingerprint: str | None) -> None:
        """Count one call that already happened (a claim). Never raises
        ``quota_reached``, so a claimed credential is never lost."""
        self._count(provider_id, credential_fingerprint, enforce=False)

    def _count(self, provider_id: str, fp: str | None, *, enforce: bool) -> None:
        budget = DAILY_BUDGET.get(provider_id)
        if budget is None:
            return
        if not fp:
            raise ConnectorError("bad_request")
        key = (provider_id, fp)
        now = self._now()
        cutoff = now - WINDOW_SECONDS
        with self._lock:
            calls = self._calls.get(key)
            if calls is None:
                self._make_room(cutoff)
                calls = deque()
                self._calls[key] = calls
            while calls and calls[0] <= cutoff:
                calls.popleft()
            if enforce and len(calls) >= budget:
                raise ConnectorError("quota_reached")
            calls.append(now)

    def _make_room(self, cutoff: float) -> None:
        if len(self._calls) < self._max_keys:
            return
        for key in [k for k, v in self._calls.items() if not v or v[-1] <= cutoff]:
            del self._calls[key]
        while len(self._calls) >= self._max_keys:
            self._calls.popitem(last=False)
