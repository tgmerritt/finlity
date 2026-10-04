"""Stateless v2 connector routes: status, SimpleFIN claim, accounts, sync
(design 6.1, 8.2, 8.4; plan Task A7).

Credentials arrive in the JSON body of each request, live for that request and
are dropped when it ends. Nothing here opens a database, writes a file, or logs
a credential, URL, account name, institution, description or amount; log lines
carry event names, provider ids, counts, ``error_type`` and durations only.
Error bodies are ``{error_type, detail}`` with a fixed message
(``SmartImportRoute``), so no exception text or FastAPI validation detail
reaches a client. The only response that carries a secret is ``claim``: the
Access URL, once, to the caller that sent the setup token.

Gating (``real_connectors_allowed``): real providers need E8's
``CONNECTORS_ENABLED=true`` on any shared deployment and, on Heroku, an
active rate limiter as well (``RATE_LIMIT_ENABLED`` plus a 32+ character
``RATE_LIMIT_SECRET_KEY``), the same prerequisite as smart import AI, so the
``connectors`` window caps fake-credential floods. The demo provider is
always on. A per-process HMAC quota (``connectors.quota``) backs up the data
layer's per-connection quota, per dyno on Heroku.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Annotated, Any, Literal, Optional, TypeVar, Union

import httpx
from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from src.api.v2.smart_import import MAX_LIST_ITEMS, SmartImportRoute
from src.connectors import akahu, quota, registry
from src.connectors.base import ConnectorProvider
from src.connectors.env import on_heroku
from src.connectors.errors import ConnectorError
from src.connectors.http import SafeClient, allowed_hosts
from src.connectors.limits import (
    MAX_ACCOUNTS,
    MAX_CONNECTIONS,
    MAX_WINDOW_DAYS,
    MAX_WINDOWS_PER_SYNC,
    PROVIDER_CALL_SECONDS,
)
from src.connectors.normalize import dropped_accounts, to_statements
from src.connectors.simplefin import format_access_url, parse_access_url
from src.connectors.types import (
    AccountRequest,
    AccountsResult,
    Credentials,
    DemoCredentials,
    FetchResult,
    SimpleFinCredentials,
)
from src.liabilities import clock
from src.services.rate_limiter import is_rate_limiting_active
from src.smart_import import limits as si_limits
from src.smart_import.errors import SmartImportError
from src.smart_import.types import ACCOUNT_KINDS, NormalizedStatement

logger = logging.getLogger(__name__)

T = TypeVar("T")

router = APIRouter(
    prefix="/api/v2/connectors",
    tags=["v2-connectors"],
    route_class=SmartImportRoute,
)

# Per-process backstop (design 8.4). Tests replace it with a fresh instance.
_QUOTA = quota.ProcessQuota()



def utcnow() -> datetime:
    """The route's clock for the core's future-balance check (the core never
    reads the wall clock); tests replace it."""
    return datetime.now(timezone.utc)


# A client east of the server may ask for its own today, one day ahead of the
# server's; providers simply have nothing newer (same slack as SimpleFIN).
_END_SLACK_DAYS = 1

ProviderPath = Annotated[str, Path(pattern=r"^(simplefin|akahu|demo)$")]
AccountKey = Annotated[
    str, Field(pattern=r"^(acct|label):[^\x00-\x1f\x7f]{1,190}$", max_length=196)
]


# --- transport injection ----------------------------------------------------------

TransportFactory = Callable[[str], Optional[httpx.BaseTransport]]


def _production_transport(provider_id: str) -> httpx.BaseTransport | None:
    """None: SafeClient builds its own pinned transport for every call."""
    return None


def transport_factory() -> TransportFactory:
    """FastAPI dependency; tests override it with an ``httpx.MockTransport``."""
    return _production_transport


# --- request bodies ---------------------------------------------------------------


class CredentialsBody(BaseModel):
    """``{access_url}`` for SimpleFIN, ``{user_token, app_token}`` for Akahu,
    ``{}`` for the demo. Lengths here are outer bounds; each provider's parser
    applies the exact rules."""

    model_config = ConfigDict(extra="forbid")

    access_url: Optional[str] = Field(default=None, min_length=1, max_length=4096)
    user_token: Optional[str] = Field(default=None, min_length=1, max_length=512)
    app_token: Optional[str] = Field(default=None, min_length=1, max_length=512)


class ClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    setup_token: str = Field(min_length=1, max_length=4096)


class AccountsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    credentials: CredentialsBody


class SyncAccount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider_account_id: str = Field(min_length=1, max_length=256)
    since: date
    account_key: AccountKey
    kind: Literal[ACCOUNT_KINDS]  # type: ignore[valid-type]
    flip_balance: bool = Field(default=False, strict=True)


class ContextCategory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)


class SyncContext(BaseModel):
    """The analyze context: the user's rules (a list of rows or a mapping keyed
    by merchant key, as ``seed_rules.apply_rules`` accepts) and categories.
    The whole context is capped at ``MAX_CONTEXT_BYTES`` like analyze's."""

    model_config = ConfigDict(extra="forbid")

    rules: Optional[
        Union[
            list[dict[str, Any]],
            dict[str, dict[str, Any]],
        ]
    ] = Field(default=None, max_length=MAX_LIST_ITEMS)
    categories: list[ContextCategory] = Field(default_factory=list, max_length=200)


class SyncRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    credentials: CredentialsBody
    start: date
    end: date
    accounts: list[SyncAccount] = Field(min_length=1, max_length=MAX_ACCOUNTS)
    context: SyncContext = Field(default_factory=SyncContext)


# --- helpers ----------------------------------------------------------------------


def real_connectors_allowed() -> bool:
    """Whether real providers (SimpleFIN, Akahu) may run here, read now.

    E8 (``registry.real_providers_opted_in``) and, on Heroku, an active rate
    limiter. Without the limiter the ``connectors`` window is off and nothing
    caps one client trying many credentials, one provider call each. The
    demo provider is not subject to this.
    """
    return registry.real_providers_opted_in() and (
        not on_heroku() or is_rate_limiting_active()
    )


def enabled_providers() -> list[str]:
    """Provider ids the v2 routes serve on this deployment, in display order."""
    real = real_connectors_allowed()
    return [p for p in registry.PROVIDER_IDS if p in registry.ALWAYS_ON or real]


def _require_enabled(provider_id: str) -> ConnectorProvider:
    """The provider, or ``connector_disabled`` before any credential is read."""
    if provider_id not in enabled_providers():
        raise ConnectorError("connector_disabled")
    return registry.get_provider(provider_id)


def _credentials(provider_id: str, body: CredentialsBody) -> Credentials:
    """Exactly the fields the provider takes, parsed by the provider's rules."""
    given = {
        name
        for name in ("access_url", "user_token", "app_token")
        if getattr(body, name) is not None
    }
    if provider_id == "simplefin" and given == {"access_url"} and body.access_url:
        return parse_access_url(body.access_url)
    if provider_id == "akahu" and given == {"user_token", "app_token"}:
        return akahu.parse_credentials(body.user_token, body.app_token)
    if provider_id == "demo" and not given:
        return DemoCredentials()
    raise ConnectorError("bad_request")


def _check_window(provider: ConnectorProvider, start: date, end: date) -> None:
    """At most ``max_window_days`` (both ends included), start not after end,
    end not after tomorrow (server date). Checked before any provider call."""
    latest = clock.today() + timedelta(days=_END_SLACK_DAYS)
    days = (end - start).days + 1
    if start > end or end > latest or days > provider.max_window_days:
        raise ConnectorError("window_too_long")


def _check_context_size(context: SyncContext) -> None:
    size = len(context.model_dump_json(exclude_none=True).encode("utf-8"))
    if size > si_limits.MAX_CONTEXT_BYTES:
        raise SmartImportError("bad_context")


def _provider_call(
    event: str,
    provider: ConnectorProvider,
    factory: TransportFactory,
    call: Callable[[ConnectorProvider, SafeClient], T],
) -> T:
    """Run one provider call through a fresh SafeClient (in the threadpool).

    The client carries one overall deadline, ``PROVIDER_CALL_SECONDS`` from
    now, so a call that makes several requests (Akahu pages) stays under
    Heroku's 30 s router timeout. Catalog errors pass through. Anything else is a bug or a library surprise:
    only its type name is logged (an httpx exception carries the request) and
    the client gets ``provider_bad_response``, raised outside the ``except``
    block so no exception context links back to it.
    """
    started = time.monotonic()
    failure: str | None = None
    try:
        with SafeClient(
            provider.id,
            transport=factory(provider.id),
            deadline=started + PROVIDER_CALL_SECONDS,
        ) as client:
            return call(provider, client)
    except SmartImportError as exc:
        logger.info(
            "connector_%s_failed provider=%s error_type=%s duration_ms=%d",
            event,
            provider.id,
            exc.error_type,
            _ms(started),
        )
        raise
    except Exception as exc:  # noqa: BLE001 - see docstring
        failure = type(exc).__name__
    logger.warning(
        "connector_%s_failed provider=%s error_type=provider_bad_response "
        "exception=%s duration_ms=%d",
        event,
        provider.id,
        failure,
        _ms(started),
    )
    raise ConnectorError("provider_bad_response")


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _account_body(acct: Any) -> dict[str, Any]:
    return {
        "provider_account_id": acct.provider_account_id,
        "name": acct.name,
        "institution": acct.institution,
        "currency": acct.currency,
        "balance": float(acct.balance) if acct.balance is not None else None,
        "balance_date": acct.balance_date.isoformat() if acct.balance_date else None,
        "kind_guess": acct.kind_guess,
        "account_key": acct.account_key,
        "error": acct.error,
    }


def _codes(codes: list[str]) -> list[str]:
    return list(dict.fromkeys(codes))


def _account_errors(
    result: FetchResult, requests: list[AccountRequest]
) -> list[dict[str, Any]]:
    """Dropped accounts with their code, then each result-level code not
    already listed, with ``provider_account_id: null``."""
    out: list[dict[str, Any]] = list(dropped_accounts(result, requests))
    listed = {entry["code"] for entry in out}
    for code in _codes(result.errors):
        if code not in listed:
            out.append({"provider_account_id": None, "code": code})
            listed.add(code)
    return out


# --- routes -----------------------------------------------------------------------


@router.get("/status")
async def status() -> dict[str, Any]:
    """Every provider with whether it is enabled here
    (``real_connectors_allowed``), its limits and its allowed hosts (names
    only). Reads the environment, never a credential."""
    enabled = enabled_providers()
    providers = []
    for provider_id in registry.PROVIDER_IDS:
        provider = registry.get_provider(provider_id)
        providers.append(
            {
                "id": provider_id,
                "display_name": provider.display_name,
                "enabled": provider_id in enabled,
                "max_window_days": provider.max_window_days,
                "daily_request_budget": provider.daily_request_budget,
                "allowed_hosts": sorted(allowed_hosts(provider_id)),
            }
        )
    return {
        "providers": providers,
        "enabled": enabled,
        "limits": {
            "max_window_days": MAX_WINDOW_DAYS,
            "max_windows_per_sync": MAX_WINDOWS_PER_SYNC,
            "max_accounts": MAX_ACCOUNTS,
            "max_connections": MAX_CONNECTIONS,
        },
    }


@router.post("/simplefin/claim")
async def claim(
    body: ClaimRequest,
    factory: TransportFactory = Depends(transport_factory),
) -> dict[str, str]:
    """Exchange a setup token for the Access URL and return it once.

    The setup token is single use, so nothing after a successful claim may
    fail: the call is counted against the new credential without a check.
    """
    provider = _require_enabled("simplefin")
    started = time.monotonic()
    creds = await run_in_threadpool(
        _provider_call,
        "claim",
        provider,
        factory,
        lambda p, c: p.claim(c, body.setup_token),
    )
    if not isinstance(creds, SimpleFinCredentials):
        raise ConnectorError("provider_bad_response")
    _QUOTA.record(provider.id, quota.fingerprint(creds))
    logger.info("connector_claim provider=%s duration_ms=%d", provider.id, _ms(started))
    return {"access_url": format_access_url(creds)}


@router.post("/{provider_id}/accounts")
async def accounts(
    provider_id: ProviderPath,
    body: AccountsRequest,
    factory: TransportFactory = Depends(transport_factory),
) -> dict[str, Any]:
    """The provider's accounts (one provider request; SimpleFIN balances only)."""
    provider = _require_enabled(provider_id)
    creds = _credentials(provider_id, body.credentials)
    _QUOTA.check_and_record(provider_id, quota.fingerprint(creds))
    started = time.monotonic()
    result: AccountsResult = await run_in_threadpool(
        _provider_call,
        "accounts",
        provider,
        factory,
        lambda p, c: p.list_accounts(c, creds),
    )
    logger.info(
        "connector_accounts provider=%s accounts=%d errors=%d duration_ms=%d",
        provider_id,
        len(result.accounts),
        len(result.errors),
        _ms(started),
    )
    return {
        "accounts": [_account_body(a) for a in result.accounts],
        "errors": _codes(result.errors),
    }


@router.post("/{provider_id}/sync")
async def sync(
    provider_id: ProviderPath,
    body: SyncRequest,
    factory: TransportFactory = Depends(transport_factory),
) -> dict[str, Any]:
    """One provider request for one window, mapped to NormalizedStatements and
    finalized with the caller's rules (design 5.2, 6.1)."""
    provider = _require_enabled(provider_id)
    creds = _credentials(provider_id, body.credentials)
    _check_window(provider, body.start, body.end)
    _check_context_size(body.context)
    requests = [
        AccountRequest(
            provider_account_id=a.provider_account_id,
            since=a.since,
            account_key=a.account_key,
            kind=a.kind,
            flip_balance=a.flip_balance,
        )
        for a in body.accounts
    ]
    context = body.context.model_dump(exclude_none=True)
    window = (body.start, body.end)

    def fetch_and_map(
        p: ConnectorProvider, c: SafeClient
    ) -> tuple[FetchResult, list[NormalizedStatement]]:
        fetched = p.fetch(c, creds, requests, body.start, body.end)
        return fetched, to_statements(provider_id, fetched, requests, window, context, now=utcnow())

    _QUOTA.check_and_record(provider_id, quota.fingerprint(creds))
    started = time.monotonic()
    result, statements = await run_in_threadpool(
        _provider_call, "sync", provider, factory, fetch_and_map
    )
    account_errors = _account_errors(result, requests)
    end = body.end
    if result.end is not None and result.end < end:
        end = result.end
    logger.info(
        "connector_sync provider=%s accounts=%d statements=%d transactions=%d "
        "account_errors=%d pages=%d duration_ms=%d",
        provider_id,
        len(requests),
        len(statements),
        sum(len(s["transactions"]) for s in statements),
        len(account_errors),
        result.pages,
        _ms(started),
    )
    return {
        "statements": statements,
        "account_errors": account_errors,
        "window": {"start": body.start.isoformat(), "end": end.isoformat()},
    }
