"""Server-mode smart import routes.

For now only the three AI routes (the data-layer routes arrive with PR B). They
use the provider registry with the profile's keys and honor the Settings
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
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from starlette.concurrency import run_in_threadpool

from src.api.dependencies import get_db
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
from src.smart_import.ai_common import CLIENT_TIMEOUT_SECONDS
from src.smart_import.env import on_heroku
from src.smart_import.errors import SmartImportError
from src.smart_import.fake_ai import (
    OfflineFakeProvider,
    fake_ai_blocked,
    fake_ai_enabled,
)
from src.smart_import.settings_store import read_settings

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/smart-import",
    tags=["smart-import"],
    route_class=SmartImportRoute,
)


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
