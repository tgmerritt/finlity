"""Hard limits for connector calls (design 8.1, 8.4 and 8.5)."""

from __future__ import annotations

from ..smart_import import limits as _si

# One provider request covers at most this many days, ending no later than today.
MAX_WINDOW_DAYS = 90
# Windows one "Sync now" walks (client side); older gaps need another sync.
MAX_WINDOWS_PER_SYNC = 4
# Response bodies are read through a byte counter and refused past this.
MAX_RESPONSE_BYTES = _si.MAX_FILE_BYTES
# A claim response is one Access URL; anything bigger is not one.
MAX_CLAIM_RESPONSE_BYTES = 4 * 1024
MAX_ACCOUNTS = 50
MAX_TXNS_PER_ACCOUNT = _si.MAX_TRANSACTIONS_PER_STATEMENT
MAX_AKAHU_PAGES = 20
# Largest absolute amount or balance accepted from a provider (design 5.2).
MAX_ABS_AMOUNT = 10_000_000_000
# Longest amount text parsed; anything longer is not a real amount.
MAX_AMOUNT_CHARS = 40

# Transport timeouts (seconds) plus a wall clock over the whole call.
CONNECT_TIMEOUT_SECONDS = 5.0
READ_TIMEOUT_SECONDS = 15.0
WRITE_TIMEOUT_SECONDS = 5.0
POOL_TIMEOUT_SECONDS = 5.0
CALL_WALL_CLOCK_SECONDS = 20.0
# Overall deadline for one provider call (every request it makes, Akahu's
# pages included), kept under Heroku's 30 s router timeout.
PROVIDER_CALL_SECONDS = 25.0
# Akahu does not start another page with less than this left; it returns the
# days it read as a partial window instead (see akahu.py).
AKAHU_PAGE_RESERVE_SECONDS = 5.0

# Connections per database (data layer, PR B).
MAX_CONNECTIONS = 10

# Provider calls per connection per rolling 24 hours. SimpleFIN asks for 24 or
# fewer; 20 leaves headroom. A provider missing here (demo) is unlimited.
DAILY_BUDGET: dict[str, int] = {"simplefin": 20, "akahu": 48}
