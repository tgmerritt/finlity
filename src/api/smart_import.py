"""Server-mode smart import routes.

The data-layer routes (context, preview, imports, rules, settings) are served by
``src/smart_import/service.py``; static paths are declared before any ``{id}``
route. The three AI routes use the provider registry with the profile's keys and honor the Settings
provider choice (``provider_id``), and they require the profile's consent in
the ``smart_import`` setting. In hosted mode the dispatcher rewrites them to
their stateless ``/api/v2/smart-import/*`` twins.

Gating order: consent first (403 ``ai_not_enabled``, so the provider registry is
not touched for a profile that never opted in), then, on a shared deployment
(Heroku or multi-user mode, where a provider can fall back to the operator's
env key), the same operator gate as the hosted routes (``ai_available()`` or
``pdf_ai_available()``: the operator's flags plus an active rate limiter on
Heroku), then a provider (503 ``ai_unavailable`` for either).

Built-in providers are rebuilt per request with the profile's database and a
bounded client (``CLIENT_TIMEOUT_SECONDS``, no retries), so a slow provider
ends inside the request budget. The registry's shared instances, which other
features use, are left as they are; plugin providers are used as registered.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
from starlette.concurrency import run_in_threadpool

from src.api.dependencies import get_db
from src.api.liabilities import CalendarDay
from src.api.v2.smart_import import (
    CategorizeRequest,
    ExtractRequest,
    SmartImportRoute,
    ai_available,
    pdf_ai_available,
    run_categorize,
    run_extract,
    status_body,
)
from src.database import Database
from src.services.inference_provider import get_provider
from src.services.providers.base import InferenceProvider
from src.services.providers.cerebras_provider import CerebrasProvider
from src.services.providers.claude_provider import ClaudeProvider
from src.services.providers.gemini_provider import GeminiProvider
from src.services.providers.openai_provider import OpenAIProvider
from src.services.session import is_multi_user_mode
from src.smart_import import service
from src.smart_import.ai_common import CLIENT_TIMEOUT_SECONDS
from src.smart_import.env import on_heroku
from src.smart_import.errors import SmartImportError
from src.smart_import.fake_ai import (
    OfflineFakeProvider,
    fake_ai_blocked,
    fake_ai_enabled,
)
from src.smart_import.settings_store import SettingsUpdate, read_settings

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/smart-import",
    tags=["smart-import"],
    route_class=SmartImportRoute,
)

# One route (design D9), so src/api/budget.py stays untouched.
budget_router = APIRouter(
    prefix="/api/budget",
    tags=["smart-import"],
    route_class=SmartImportRoute,
)


ACCOUNT_KINDS = Literal["checking", "savings", "credit_card", "loan", "unknown"]
MAX_PREVIEW_STATEMENTS = 12
MAX_PREVIEW_KEYS = 10_000
_HASH = r"^[A-Za-z0-9_-]{1,100}$"


def check_demo_mode_write() -> None:
    """Refuse writes on the protected hosted demo (centralised check)."""
    from src.services.demo_mode import check_demo_data_protection

    check_demo_data_protection()


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PreviewStatement(_Strict):
    file_hash: str = Field(pattern=_HASH)
    account_key: Optional[str] = Field(default=None, max_length=200)
    account_kind: ACCOUNT_KINDS
    institution: Optional[str] = Field(default=None, max_length=120)
    dedupe_keys: list[Annotated[str, Field(max_length=400)]] = Field(max_length=MAX_PREVIEW_KEYS)
    merchant_keys: list[Annotated[str, Field(max_length=400)]] = Field(max_length=MAX_PREVIEW_KEYS)


class PreviewRequest(_Strict):
    statements: list[PreviewStatement] = Field(max_length=MAX_PREVIEW_STATEMENTS)


MAX_APPLY_STATEMENTS = 12
MAX_APPLY_TRANSACTIONS = 10_000
MAX_APPLY_RULES = 5_000
MAX_APPLY_RECURRING = 500
Money = Annotated[float, Field(strict=True, ge=-1e10, le=1e10, allow_inf_nan=False)]
Frequency = Literal["weekly", "biweekly", "monthly", "quarterly", "annual"]


class ApplyAccount(_Strict):
    kind: ACCOUNT_KINDS
    key: str = Field(min_length=1, max_length=200)
    label: Optional[str] = Field(default=None, max_length=200)
    last4: Optional[str] = Field(default=None, max_length=32)
    institution: Optional[str] = Field(default=None, max_length=120)


class ApplyPeriod(_Strict):
    start: Optional[CalendarDay] = None
    end: Optional[CalendarDay] = None


class ApplyClosingBalance(_Strict):
    amount: Money
    as_of: CalendarDay


class ApplyTransaction(_Strict):
    posted_date: CalendarDay
    amount: Money
    description: str = Field(max_length=2000)
    merchant_key: str = Field(min_length=1, max_length=400)
    kind: Literal["expense", "income", "transfer", "payment", "refund", "fee", "interest"]
    category_id: Optional[str] = Field(default=None, max_length=64)
    category_source: Literal["user", "rule", "seed", "ai", "none"]
    ai_confidence: Optional[float] = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    external_id: Optional[str] = Field(default=None, max_length=200)
    dedupe_key: str = Field(min_length=1, max_length=400)
    excluded: StrictBool = False


class ApplyStatement(_Strict):
    file_hash: str = Field(pattern=_HASH)
    file_name: str = Field(max_length=1000)
    origin: Literal["file", "sample", "connector"]
    format: Literal["csv", "ofx", "pdf", "connector"]
    parser: str = Field(min_length=1, max_length=64)
    account: ApplyAccount
    period: Optional[ApplyPeriod] = None
    closing_balance: Optional[ApplyClosingBalance] = None
    liability_id: Optional[str] = Field(default=None, max_length=64)
    ai_used: StrictBool = False
    ai_provider: Optional[str] = Field(default=None, max_length=64)
    transactions: list[ApplyTransaction] = Field(max_length=MAX_APPLY_TRANSACTIONS)


class ApplyRule(_Strict):
    merchant_key: str = Field(min_length=1, max_length=400)
    category_id: Optional[str] = Field(default=None, max_length=64)
    kind: Optional[Literal["expense", "income", "transfer", "payment", "refund", "fee", "interest"]] = None
    source: Literal["user", "import", "ai", "connector"] = "user"


class ApplyRecurring(_Strict):
    merchant_key: str = Field(min_length=1, max_length=400)
    name: str = Field(min_length=1, max_length=120)
    amount: float = Field(gt=0, le=1e10, allow_inf_nan=False)
    frequency: Frequency
    category_id: str = Field(min_length=1, max_length=64)
    occurrences: int = Field(ge=1, le=10_000)
    file_hash: str = Field(pattern=_HASH)
    decision: Literal["create", "link", "reject"]
    expense_id: Optional[str] = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def _link_needs_an_expense(self) -> "ApplyRecurring":
        if (self.decision == "link") != (self.expense_id is not None):
            raise ValueError("expense_id goes with decision 'link' and only there")
        return self


class ApplyRequest(_Strict):
    batch_id: str = Field(min_length=1, max_length=100)
    entity_id: Optional[str] = Field(default=None, min_length=1, max_length=64)
    statements: list[ApplyStatement] = Field(max_length=MAX_APPLY_STATEMENTS)
    rules: list[ApplyRule] = Field(default_factory=list, max_length=MAX_APPLY_RULES)
    recurring: list[ApplyRecurring] = Field(default_factory=list, max_length=MAX_APPLY_RECURRING)


# Built-in provider classes whose constructors take a client timeout.
_BOUNDED_PROVIDERS: tuple[type[InferenceProvider], ...] = (
    ClaudeProvider,
    OpenAIProvider,
    GeminiProvider,
    CerebrasProvider,
)


def _bounded(provider: InferenceProvider, db: Database) -> InferenceProvider:
    """A per-request copy of a built-in provider with a bounded client."""
    cls = type(provider)
    if cls not in _BOUNDED_PROVIDERS:
        return provider
    return cls(  # type: ignore[call-arg]
        db, timeout=CLIENT_TIMEOUT_SECONDS, max_retries=0
    )


def _resolve_provider(
    provider_id: Optional[str], db: Database
) -> InferenceProvider | None:
    if fake_ai_blocked():
        return None
    if fake_ai_enabled():
        return OfflineFakeProvider()
    try:
        provider = _bounded(get_provider(provider_id, db), db)
    except Exception as exc:  # ProviderNotConfiguredError or a registry failure
        logger.info(
            "smart_import_ai_provider_unavailable error_type=%s", type(exc).__name__
        )
        return None
    return provider if provider.is_available() else None


def _operator_allows(consent_key: str) -> bool:
    """On a shared deployment, the hosted operator gate for this feature.

    There a provider can fall back to the operator's env key, so profile
    consent alone is not enough. A single-user server has no operator gate.
    """
    if not (on_heroku() or is_multi_user_mode()):
        return True
    return pdf_ai_available() if consent_key == "pdf_ai_enabled" else ai_available()


async def _consented_provider(
    db: Database, provider_id: Optional[str], consent_key: str
) -> InferenceProvider:
    settings = await run_in_threadpool(read_settings, db)
    if settings.get(consent_key) is not True:
        raise SmartImportError("ai_not_enabled")
    if not _operator_allows(consent_key):
        raise SmartImportError("ai_unavailable")
    provider = await run_in_threadpool(_resolve_provider, provider_id, db)
    if provider is None:
        raise SmartImportError("ai_unavailable")
    return provider


@router.post("/categorize")
async def categorize(
    body: CategorizeRequest, db: Database = Depends(get_db)
) -> dict[str, Any]:
    """AI categories for unique merchants with the profile's provider."""
    provider = await _consented_provider(db, body.provider_id, "ai_enabled")
    return await run_categorize(provider, body)


@router.post("/extract")
async def extract(
    body: ExtractRequest, db: Database = Depends(get_db)
) -> dict[str, Any]:
    """AI reading of an unknown PDF layout with the profile's provider."""
    provider = await _consented_provider(db, body.provider_id, "pdf_ai_enabled")
    return await run_extract(provider, body)


@router.get("/ai-status")
async def ai_status(
    provider_id: Optional[str] = Query(
        default=None, max_length=64, pattern=r"^[A-Za-z0-9_.-]{1,64}$"
    ),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    """Provider availability plus the profile's consent flags.

    ``ai_available`` and ``pdf_ai_available`` apply the same gates as the
    categorize and extract routes (minus consent, reported separately), so on
    a shared deployment they match v2 /status.
    """
    settings = await run_in_threadpool(read_settings, db)
    ai_gate = _operator_allows("ai_enabled")
    pdf_gate = _operator_allows("pdf_ai_enabled")
    provider = None
    if ai_gate or pdf_gate:
        provider = await run_in_threadpool(_resolve_provider, provider_id, db)
    available = provider is not None
    return status_body(
        ai_ok=available and ai_gate,
        pdf_ok=available and pdf_gate,
        ai_enabled=settings["ai_enabled"],
        pdf_ai_enabled=settings["pdf_ai_enabled"],
        provider=provider,
    )


# ---------------------------------------------------------------------------
# Data layer: read side and settings. Plain ``def`` handlers run in the
# threadpool; the service turns unexpected failures into fixed errors.
# ---------------------------------------------------------------------------


@router.get("/context")
def get_context(db: Database = Depends(get_db)) -> dict[str, Any]:
    """Rules, categories, known accounts, remembered CSV layouts and settings."""
    return service.get_context(db)


@router.post("/preview")
def preview(body: PreviewRequest, db: Database = Depends(get_db)) -> dict[str, Any]:
    """Duplicate keys, prior files, liability suggestions and recurring history. Writes nothing."""
    return service.preview(db, [s.model_dump() for s in body.statements])


@router.post("/apply")
def apply_import(body: ApplyRequest, db: Database = Depends(get_db)) -> dict[str, Any]:
    """Apply a reviewed batch in one transaction, ledgering everything it changes."""
    check_demo_mode_write()
    return service.apply_import(db, body.model_dump())


@router.get("/imports")
def list_imports(db: Database = Depends(get_db)) -> list[dict[str, Any]]:
    return service.list_imports(db)


@router.delete("/imports/{import_id}")
def undo_import(import_id: str, db: Database = Depends(get_db)) -> dict[str, Any]:
    check_demo_mode_write()
    return service.undo_import(db, import_id)


@router.delete("/transactions")
def delete_transactions(db: Database = Depends(get_db)) -> dict[str, Any]:
    """Delete every stored transaction detail (imports, expenses, rules, snapshots stay)."""
    check_demo_mode_write()
    return service.delete_transactions(db)


@router.get("/rules")
def list_rules(db: Database = Depends(get_db)) -> list[dict[str, Any]]:
    return service.list_rules(db)


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: str, db: Database = Depends(get_db)) -> dict[str, Any]:
    # CSRF posture: DELETE is a non-simple method, so browsers preflight it against the CORS allowlist.
    check_demo_mode_write()
    return service.delete_rule(db, rule_id)


@router.get("/settings")
def get_settings(db: Database = Depends(get_db)) -> dict[str, Any]:
    return service.get_settings(db)


@router.put("/settings")
def put_settings(body: SettingsUpdate, db: Database = Depends(get_db)) -> dict[str, Any]:
    # CSRF posture: PUT is a non-simple method, so browsers preflight it against the CORS allowlist.
    check_demo_mode_write()
    return service.put_settings(db, body)


@budget_router.get("/spending-summary")
def spending_summary(
    months: int = Query(default=3, ge=1, le=24),
    entity_id: Optional[str] = Query(default=None, max_length=64),
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    """Planned versus actual monthly spending by category."""
    return service.spending_summary(db, months, entity_id or None)
