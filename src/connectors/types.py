"""Typed shapes passed between providers, the HTTP client and the mapping
(design 5.1).

Credentials and every field that carries provider content (names,
institutions, descriptions, amounts, balances) are kept out of ``repr`` so an
accidental ``%s`` in a log line or an exception cannot leak them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, DecimalException

from .limits import MAX_ABS_AMOUNT, MAX_AMOUNT_CHARS

_MASK = "<credentials>"


def bounded_amount(value: object) -> Decimal | None:
    """A provider amount or balance as a finite ``Decimal`` within
    ``MAX_ABS_AMOUNT``, or None when it is unusable.

    Accepts ``Decimal`` (``SafeClient.get_json`` parses JSON numbers that
    way), ``int`` and numeric strings up to ``MAX_AMOUNT_CHARS``. Refuses
    bool, float, NaN, infinities and anything out of range, so providers
    decide whether to skip the row or reject the response.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text or len(text) > MAX_AMOUNT_CHARS:
            return None
        try:
            value = Decimal(text)
        except DecimalException:
            return None
    elif isinstance(value, int):
        if abs(value) > MAX_ABS_AMOUNT:
            return None
        value = Decimal(value)
    if not isinstance(value, Decimal) or not value.is_finite():
        return None
    # copy_abs ignores the decimal context, so a huge exponent cannot overflow.
    if value.copy_abs() > MAX_ABS_AMOUNT:
        return None
    return value


@dataclass(frozen=True, repr=False)
class Credentials:
    """Opaque provider credentials. ``repr``, ``str`` and f-strings give
    ``<credentials>``. Subclasses must also pass ``repr=False``."""

    def __repr__(self) -> str:
        return _MASK

    def __str__(self) -> str:
        return _MASK


@dataclass(frozen=True, repr=False)
class SimpleFinCredentials(Credentials):
    """An Access URL split into its parts; ``base_url`` carries no userinfo."""

    base_url: str
    username: str
    password: str


@dataclass(frozen=True, repr=False)
class AkahuCredentials(Credentials):
    user_token: str
    app_token: str


@dataclass(frozen=True, repr=False)
class DemoCredentials(Credentials):
    """The demo provider needs no secret."""


@dataclass(frozen=True)
class ProviderAccount:
    provider_account_id: str
    name: str = field(repr=False)
    institution: str | None = field(repr=False)
    currency: str
    balance: Decimal | None = field(repr=False)
    balance_date: date | None
    kind_guess: str
    account_key: str
    # A warning code (``connector_account_error``) when the provider flagged
    # this account (an Akahu account that is not ACTIVE, a SimpleFIN errlist
    # entry naming it or its connection); None when it is fine.
    error: str | None = None


@dataclass(frozen=True)
class ProviderTxn:
    id: str
    posted: date
    amount: Decimal = field(repr=False)
    description: str = field(repr=False)
    payee: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class AccountRequest:
    """One account to fetch, with the user's mapping (design 10)."""

    provider_account_id: str
    since: date
    account_key: str
    kind: str
    flip_balance: bool = False


@dataclass(frozen=True)
class AccountsResult:
    accounts: list[ProviderAccount] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)  # codes only


@dataclass(frozen=True)
class FetchedAccount:
    """One account's rows and balance from a fetch. ``error`` is a warning code
    (for example ``connector_account_error``) when the provider reported a
    problem with this account; its rows are then empty. ``warnings`` are
    warning codes for rows the provider left out (for example
    ``rows_skipped``) while the account still synced; the mapping copies them
    into the statement's warnings."""

    provider_account_id: str
    currency: str
    transactions: list[ProviderTxn] = field(default_factory=list)
    balance: Decimal | None = field(default=None, repr=False)
    balance_date: date | None = None
    error: str | None = None
    warnings: list[str] = field(default_factory=list)
    # The provider's institution name (SimpleFIN connection name, Akahu
    # connection.name); kept out of repr like every provider text.
    institution: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class FetchResult:
    accounts: list[FetchedAccount] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)  # codes only
    pages: int = 1
    # Set when pagination stopped early: the last complete day fetched.
    end: date | None = None
