"""Synthetic demo provider (design 11).

No credentials, no network and no quota. Everything is generated from the
calendar: each day's rows are a pure function of the date and the account, so
two syncs over overlapping windows return the same rows with the same ids and
dedupe works. Merchants are generic chain names that the seed rules cover, so a
hosted visitor needs no AI. The generator never reads the clock; the caller's
window decides which days exist (the sync route keeps it to 90 days ending
today, so dates track today).
"""

from __future__ import annotations

import hashlib
from datetime import date, timedelta
from decimal import Decimal

from .base import ProviderClient
from .errors import ConnectorError
from .limits import MAX_WINDOW_DAYS
from .normalize import account_key_for
from .types import (
    AccountRequest,
    AccountsResult,
    Credentials,
    DemoCredentials,
    FetchedAccount,
    FetchResult,
    ProviderAccount,
    ProviderTxn,
)

PROVIDER_ID = "demo"
INSTITUTION = "Demo Bank"
CURRENCY = "USD"
CHECKING_ID = "demo-chk"
CARD_ID = "demo-card"

_ACCOUNTS: tuple[tuple[str, str, str], ...] = (
    (CHECKING_ID, "Demo Everyday", "checking"),
    (CARD_ID, "Demo Rewards Card", "credit_card"),
)

# Fortnightly pay, anchored on the proleptic ordinal so it never depends on
# the window. Monthly bills sit on days every month has.
_PAY_ANCHOR = 0
_PAY_AMOUNT = Decimal("2400.00")
_MONTHLY_CHECKING: tuple[tuple[int, str, Decimal], ...] = (
    (3, "NETFLIX.COM", Decimal("15.49")),
    (8, "VERIZON WIRELESS PAYMENT", Decimal("65.00")),
    (12, "PG&E ELECTRIC BILL", Decimal("78.40")),
)
_MONTHLY_CARD: tuple[tuple[int, str, Decimal], ...] = (
    (20, "SPOTIFY USA", Decimal("11.99")),
)

# (description, low cents, high cents) per account.
_SPENDING: dict[str, tuple[tuple[str, int, int], ...]] = {
    CHECKING_ID: (
        ("SAFEWAY #0123", 3200, 9500),
        ("WHOLE FOODS MARKET", 2800, 10500),
        ("TRADER JOES", 2200, 7000),
        ("SHELL OIL 57444", 2800, 6200),
        ("STARBUCKS STORE 4411", 450, 1100),
        ("CHIPOTLE 1234", 900, 1900),
    ),
    CARD_ID: (
        ("AMAZON MKTPLACE", 1200, 12000),
        ("TARGET STORE T-0457", 1800, 14000),
        ("DOORDASH ORDER", 1800, 4800),
        ("UBER TRIP", 800, 3200),
        ("SUBWAY 22910", 700, 1600),
        ("CVS PHARMACY 0912", 600, 4200),
    ),
}

_CHECKING_BASE = 3200  # dollars
_CARD_BASE = 1200  # dollars owed


def _digest(*parts: object) -> int:
    raw = "|".join(str(p) for p in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(b"finlity-demo-v1|" + raw).digest()[:8], "big")


def _cents(value: int) -> Decimal:
    return Decimal(value) / 100


def _day_rows(account_id: str, day: date) -> list[tuple[str, Decimal]]:
    """The (description, signed amount) rows of one day, in a fixed order."""
    rows: list[tuple[str, Decimal]] = []
    if account_id == CHECKING_ID:
        if (day.toordinal() - _PAY_ANCHOR) % 14 == 0:
            rows.append(("SAMPLE EMPLOYER PAYROLL", _PAY_AMOUNT))
        monthly = _MONTHLY_CHECKING
    else:
        monthly = _MONTHLY_CARD
    rows.extend((d, -amount) for dom, d, amount in monthly if day.day == dom)
    pool = _SPENDING[account_id]
    count = 1 + _digest(account_id, day, "count") % 2
    for i in range(count):
        h = _digest(account_id, day, "spend", i)
        desc, low, high = pool[h % len(pool)]
        cents = low + (h >> 8) % (high - low + 1)
        rows.append((desc, -_cents(cents)))
    return rows


def _balance(account_id: str, day: date) -> Decimal:
    """A deterministic closing balance for a date.

    Provider convention (``PROVIDER_BALANCE_IS_HOLDER_SIDE``): the card
    balance is negative when money is owed, so it is minus the owed amount.
    """
    h = _digest(account_id, day, "balance")
    if account_id == CHECKING_ID:
        return _cents((_CHECKING_BASE * 100) + h % 250_000)
    return -_cents((_CARD_BASE * 100) + h % 280_000)


def _check_window(start: date, end: date) -> None:
    if start > end or (end - start).days + 1 > MAX_WINDOW_DAYS:
        raise ConnectorError("window_too_long")


class DemoProvider:
    id = PROVIDER_ID
    display_name = "Demo"
    max_window_days = MAX_WINDOW_DAYS
    daily_request_budget: int | None = None

    def claim(self, client: ProviderClient, setup: str) -> Credentials:
        """Nothing to claim; the demo has no credentials."""
        return DemoCredentials()

    def list_accounts(
        self, client: ProviderClient, creds: Credentials
    ) -> AccountsResult:
        # The balance date is left unset so the listing needs no clock.
        accounts = [
            ProviderAccount(
                provider_account_id=account_id,
                name=name,
                institution=INSTITUTION,
                currency=CURRENCY,
                balance=None,
                balance_date=None,
                kind_guess=kind,
                account_key=account_key_for(PROVIDER_ID, account_id),
            )
            for account_id, name, kind in _ACCOUNTS
        ]
        return AccountsResult(accounts=accounts)

    def fetch(
        self,
        client: ProviderClient,
        creds: Credentials,
        accounts: list[AccountRequest],
        start: date,
        end: date,
    ) -> FetchResult:
        """Rows for each requested account from the later of ``start`` and the
        account's ``since`` through ``end``, plus the balance on ``end``."""
        _check_window(start, end)
        known = {account_id for account_id, _, _ in _ACCOUNTS}
        fetched: list[FetchedAccount] = []
        seen: set[str] = set()
        for req in accounts:
            account_id = req.provider_account_id
            if account_id in seen:
                continue
            seen.add(account_id)
            if account_id not in known:
                fetched.append(
                    FetchedAccount(
                        provider_account_id=account_id,
                        currency=CURRENCY,
                        error="connector_account_error",
                    )
                )
                continue
            first = max(start, req.since)
            txns: list[ProviderTxn] = []
            day = first
            while day <= end:
                for n, (desc, amount) in enumerate(_day_rows(account_id, day)):
                    txns.append(
                        ProviderTxn(
                            id=f"{account_id}:{day.isoformat()}:{n}",
                            posted=day,
                            amount=amount,
                            description=desc,
                        )
                    )
                day += timedelta(days=1)
            fetched.append(
                FetchedAccount(
                    provider_account_id=account_id,
                    currency=CURRENCY,
                    transactions=txns,
                    balance=_balance(account_id, end),
                    balance_date=end,
                    institution=INSTITUTION,
                )
            )
        return FetchResult(accounts=fetched)
