"""Stateless v2 smart import routes: analyze, recurring, status, categorize, extract.

Nothing here opens a database or writes a file. Uploads are held in memory for
the request, closed in ``finally``, and never logged. Error bodies are always
``{error_type, detail}`` with a fixed message: neither SmartImportError text nor
FastAPI's validation detail (which echoes the offending input) reaches a client.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from collections.abc import AsyncGenerator, Callable, Coroutine
from datetime import date
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from starlette.types import Message

from src.liabilities import clock
from src.services.providers.base import InferenceProvider
from src.services.providers.claude_provider import ClaudeProvider
from src.services.rate_limiter import is_rate_limiting_active
from src.smart_import import ai_categorize, ai_common, ai_extract, limits
from src.smart_import.analyze import analyze_file
from src.smart_import.env import env_flag, on_heroku
from src.smart_import.errors import SmartImportError
from src.smart_import.fake_ai import (
    OfflineFakeProvider,
    fake_ai_blocked,
    fake_ai_enabled,
)
from src.smart_import.recurring import detect
from src.smart_import.types import ACCOUNT_KINDS, Kind

logger = logging.getLogger(__name__)

# Multipart framing and the two form parts add a little to the file itself.
_MULTIPART_OVERHEAD = 64 * 1024
MAX_ANALYZE_BODY_BYTES = (
    limits.MAX_FILE_BYTES + limits.MAX_CONTEXT_BYTES + _MULTIPART_OVERHEAD
)
# Generous bound for JSON bodies (four lists of up to 20,000 rows).
MAX_JSON_BODY_BYTES = 32 * 1024 * 1024
MAX_LIST_ITEMS = 20_000
# The budget expenses and categories a recurring request is matched against.
# Far above any real budget, and small enough that matching stays cheap.
MAX_RECURRING_REFERENCE_ITEMS = 2_000

def _error(exc: SmartImportError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.body())


def _needs_counted_body(request: Request) -> bool:
    """A POST or PUT with no usable Content-Length (chunked) whose body FastAPI reads.

    Multipart uploads (analyze) stream through their own, smaller cap.
    """
    if request.method not in ("POST", "PUT"):
        return False
    content_type = request.headers.get("content-type", "").lower()
    return not content_type.startswith("multipart/form-data")


async def _counted_request(request: Request) -> Request:
    """Read the body through a byte counter, then replay it to FastAPI.

    Raising from inside FastAPI's own body read would surface as its generic
    400, so the body is read here, where ``request_too_large`` keeps the
    catalog shape, and handed on as a single message.
    """
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_JSON_BODY_BYTES:
            raise SmartImportError("request_too_large")
        chunks.append(chunk)
    body = b"".join(chunks)
    sent = False

    async def receive() -> Message:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await request.receive()

    return Request(request.scope, receive)


class SmartImportRoute(APIRoute):
    """Route class that keeps every error body to the fixed catalog shape."""

    def get_route_handler(
        self,
    ) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            declared = request.headers.get("content-length", "")
            try:
                if declared.isdigit():
                    if int(declared) > MAX_JSON_BODY_BYTES:
                        raise SmartImportError("request_too_large")
                elif _needs_counted_body(request):
                    request = await _counted_request(request)
                return await original(request)
            except SmartImportError as exc:
                return _error(exc)
            except RequestValidationError:
                return _error(SmartImportError("bad_request"))

        return handler


router = APIRouter(
    prefix="/api/v2/smart-import",
    tags=["v2-smart-import"],
    route_class=SmartImportRoute,
)


def ai_available() -> bool:
    """Whether AI calls may spend the operator's env key.

    Needs the env key (or the offline fake off Heroku) and the operator's
    opt-in flag ``SMART_IMPORT_AI_ENABLED``. Deploy prerequisite: on Heroku
    (``DYNO`` set) the rate limiter must also be active
    (``RATE_LIMIT_ENABLED=true`` plus a ``RATE_LIMIT_SECRET_KEY`` of at least
    32 characters); without it AI stays unavailable, so a public deployment
    can never spend the key without a per-client limit in front of it.
    """
    if fake_ai_blocked():
        return False
    has_key = bool(os.environ.get("ANTHROPIC_API_KEY")) or fake_ai_enabled()
    if not (has_key and env_flag("SMART_IMPORT_AI_ENABLED")):
        return False
    return not on_heroku() or is_rate_limiting_active()


def pdf_ai_available() -> bool:
    """``ai_available()`` plus the operator's ``SMART_IMPORT_PDF_AI_ENABLED`` flag."""
    return ai_available() and env_flag("SMART_IMPORT_PDF_AI_ENABLED")


class _UploadTooLarge(MultiPartException):
    """Raised by the capped stream inside the multipart parser.

    A MultiPartException subclass so the parser closes any partly written
    upload before it propagates; ``analyze`` maps it to ``file_too_large``.
    """

    def __init__(self) -> None:
        super().__init__("file_too_large")


async def _capped_stream(request: Request) -> AsyncGenerator[bytes, None]:
    """Yield the request body, failing as soon as it passes the analyze cap."""
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_ANALYZE_BODY_BYTES:
            raise _UploadTooLarge()
        yield chunk


def _parse_context(raw: Any) -> dict[str, Any]:
    if raw is None or raw == "":
        return {}
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > limits.MAX_CONTEXT_BYTES:
        raise SmartImportError("bad_context")
    try:
        value = json.loads(raw)
    except ValueError:
        raise SmartImportError("bad_context") from None
    if not isinstance(value, dict):
        raise SmartImportError("bad_context")
    return value


@router.post("/analyze")
async def analyze(request: Request) -> dict[str, Any]:
    """Parse one statement (multipart ``file`` plus a JSON ``context`` string)."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_ANALYZE_BODY_BYTES:
        raise SmartImportError("file_too_large")
    if (
        not request.headers.get("content-type", "")
        .lower()
        .startswith("multipart/form-data")
    ):
        raise SmartImportError("bad_request")

    parser = MultiPartParser(
        request.headers, _capped_stream(request), max_files=1, max_fields=2
    )
    # Keep the whole upload in memory (it is already capped): Starlette's
    # default spools anything over 1 MB to a temporary file on disk.
    parser.spool_max_size = MAX_ANALYZE_BODY_BYTES
    try:
        form = await parser.parse()
    except _UploadTooLarge:
        raise SmartImportError("file_too_large") from None
    except MultiPartException:
        raise SmartImportError("bad_request") from None
    try:
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise SmartImportError("bad_request")
        context = _parse_context(form.get("context"))
        content = await limits.read_limited(upload)
        file_name = upload.filename or ""
        try:
            result = await run_in_threadpool(analyze_file, content, file_name, context)
        except SmartImportError:
            raise
        except Exception as exc:  # defensive; analyze_file already wraps parser errors
            logger.warning(
                "smart_import_analyze_failed error_type=%s hash=%s",
                type(exc).__name__,
                hashlib.sha256(content).hexdigest()[:8],
            )
            raise SmartImportError("unreadable") from None
        statements = result.get("statements") or []
        logger.info(
            "smart_import_analyze status=%s statements=%d transactions=%d hash=%s",
            result["status"],
            len(statements),
            sum(len(s["transactions"]) for s in statements),
            hashlib.sha256(content).hexdigest()[:8],
        )
        return result
    finally:
        await form.close()


class RecurringRequest(BaseModel):
    rows: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_LIST_ITEMS)
    history: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MAX_LIST_ITEMS
    )
    expenses: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MAX_RECURRING_REFERENCE_ITEMS
    )
    categories: list[dict[str, Any]] = Field(
        default_factory=list, max_length=MAX_RECURRING_REFERENCE_ITEMS
    )


@router.post("/recurring")
async def recurring(body: RecurringRequest) -> dict[str, Any]:
    """Detect recurring bills in the reviewed rows plus the client's history."""
    candidates = await run_in_threadpool(
        detect, body.rows, body.history, body.expenses, body.categories
    )
    logger.info("smart_import_recurring candidates=%d", len(candidates))
    return {"candidates": candidates}


def _limits() -> dict[str, int]:
    return {
        "max_file_bytes": limits.MAX_FILE_BYTES,
        "max_context_bytes": limits.MAX_CONTEXT_BYTES,
        "max_files_per_batch": limits.MAX_FILES_PER_BATCH,
        "max_csv_rows": limits.MAX_CSV_ROWS,
        "max_pdf_pages": limits.MAX_PDF_PAGES,
        "max_transactions_per_statement": limits.MAX_TRANSACTIONS_PER_STATEMENT,
        "max_recurring_items": MAX_LIST_ITEMS,
        "max_recurring_reference_items": MAX_RECURRING_REFERENCE_ITEMS,
        "max_ai_items": ai_categorize.MAX_ITEMS,
        "max_ai_lines": limits.MAX_AI_LINES,
    }


def status_body(
    *,
    ai_ok: bool,
    pdf_ok: bool,
    ai_enabled: bool,
    pdf_ai_enabled: bool,
    provider: InferenceProvider | None,
) -> dict[str, Any]:
    """The shared SmartImportAiStatus shape for v2 /status and /ai-status."""
    model = None
    if provider is not None:
        model = ai_common.model_label(provider, ai_common.model_for(provider))
    return {
        "ai_available": ai_ok,
        "pdf_ai_available": pdf_ok,
        "ai_enabled": ai_enabled,
        "pdf_ai_enabled": pdf_ai_enabled,
        "provider": provider.info.display_name if provider is not None else None,
        "model": model,
        "limits": _limits(),
    }


@router.get("/status")
async def status() -> dict[str, Any]:
    """Hosted AI availability and the size limits the client should respect.

    Hosted mode has no per-user consent: the operator's flags are the consent,
    so ``ai_enabled`` mirrors ``ai_available``.
    """
    available = ai_available()
    pdf = pdf_ai_available()
    return status_body(
        ai_ok=available,
        pdf_ok=pdf,
        ai_enabled=available,
        pdf_ai_enabled=pdf,
        provider=_hosted_provider() if available else None,
    )


# ---------------------------------------------------------------------------
# AI categorize and PDF extract (design 6.2, 6.3). Requests are held in memory
# for the call; nothing about their content is logged or stored.

ItemId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,32}$")]
CategoryName = Annotated[
    str, Field(min_length=1, max_length=ai_categorize.MAX_CATEGORY_CHARS)
]
ProviderId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_.-]{1,64}$")]


class CategorizeItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: ItemId
    merchant: str = Field(min_length=1, max_length=ai_categorize.MAX_MERCHANT_CHARS)
    typical_amount: int = Field(strict=True, ge=0, le=10_000_000)
    direction: Literal["in", "out"]
    count: int = Field(strict=True, ge=1, le=1_000_000)


class CategorizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    categories: list[CategoryName] = Field(
        min_length=1, max_length=ai_categorize.MAX_CATEGORIES
    )
    items: list[CategorizeItem] = Field(
        min_length=1, max_length=ai_categorize.MAX_ITEMS
    )
    provider_id: Optional[ProviderId] = None

    @model_validator(mode="after")
    def _unique_ids(self) -> "CategorizeRequest":
        ids = [item.id for item in self.items]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate item id")
        return self


class PeriodHint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start: Optional[date] = None
    end: Optional[date] = None


class CategoryRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=ai_categorize.MAX_CATEGORY_CHARS)


class RuleRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    merchant_key: str = Field(min_length=1, max_length=120)
    category_id: Optional[str] = Field(default=None, max_length=64)
    kind: Optional[Kind] = None


class ExtractRequest(BaseModel):
    """Lines go to the provider; categories and rules are applied locally only."""

    model_config = ConfigDict(extra="forbid")

    lines: list[Annotated[str, Field(max_length=ai_extract.MAX_LINE_CHARS)]] = Field(
        min_length=1, max_length=limits.MAX_AI_LINES
    )
    period_hint: Optional[PeriodHint] = None
    account_kind: Optional[Literal[ACCOUNT_KINDS]] = None  # type: ignore[valid-type]
    provider_id: Optional[ProviderId] = None
    categories: list[CategoryRef] = Field(default_factory=list, max_length=200)
    rules: list[RuleRef] = Field(default_factory=list, max_length=MAX_LIST_ITEMS)


def _hosted_provider() -> InferenceProvider:
    """The env-key Claude provider, like the v2 advisor, with a bounded client."""
    if fake_ai_enabled():
        return OfflineFakeProvider()
    return ClaudeProvider(
        api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        timeout=ai_common.CLIENT_TIMEOUT_SECONDS,
        max_retries=0,
    )


async def run_categorize(
    provider: InferenceProvider, body: CategorizeRequest
) -> dict[str, Any]:
    """Shared by the hosted and server-mode routes."""
    model = ai_common.model_for(provider)
    items = [item.model_dump() for item in body.items]
    try:
        suggestions = await ai_common.run_with_budget(
            ai_categorize.categorize, provider, items, list(body.categories), model
        )
    except SmartImportError as exc:
        logger.warning("smart_import_categorize_failed error_type=%s", exc.error_type)
        raise
    logger.info(
        "smart_import_categorize items=%d suggestions=%d",
        len(items),
        len(suggestions),
    )
    return {
        "suggestions": suggestions,
        "provider": provider.info.display_name,
        "model": ai_common.model_label(provider, model),
    }


async def run_extract(
    provider: InferenceProvider, body: ExtractRequest
) -> dict[str, Any]:
    """Shared by the hosted and server-mode routes. Returns an analyze response."""
    model = ai_common.model_for(provider)
    period = body.period_hint.model_dump() if body.period_hint else None
    progress = ai_extract.ExtractProgress()
    try:
        try:
            rows, partial = await ai_common.run_with_budget(
                _extract_rows,
                provider,
                list(body.lines),
                period,
                body.account_kind,
                model,
                progress,
            )
        except SmartImportError as exc:
            # A batch overran the request budget: keep the finished batches.
            progress.cancel()
            if exc.error_type != "ai_timeout" or progress.batches_done == 0:
                raise
            rows, partial = progress.rows(), True
        statement = ai_extract.build_extract_statement(
            rows,
            account_kind=body.account_kind,
            period_hint=period,
            rules=[r.model_dump() for r in body.rules],
            categories=[c.model_dump() for c in body.categories],
            partial=partial,
        )
    except SmartImportError as exc:
        logger.warning("smart_import_extract_failed error_type=%s", exc.error_type)
        raise
    logger.info(
        "smart_import_extract lines=%d transactions=%d partial=%s",
        len(body.lines),
        len(statement["transactions"]),
        partial,
    )
    return {"status": "ok", "statements": [statement]}


def _extract_rows(
    provider: InferenceProvider,
    lines: list[str],
    period: dict[str, Any] | None,
    account_kind: str | None,
    model: str | None,
    progress: ai_extract.ExtractProgress,
) -> tuple[list[dict[str, Any]], bool]:
    return ai_extract.extract(
        provider,
        lines,
        period,
        account_kind,
        model,
        today=clock.today(),
        progress=progress,
    )


@router.post("/categorize")
async def categorize(body: CategorizeRequest) -> dict[str, Any]:
    """AI categories for unique merchants, with the operator's env key only."""
    if not ai_available():
        raise SmartImportError("ai_unavailable")
    return await run_categorize(_hosted_provider(), body)


@router.post("/extract")
async def extract(body: ExtractRequest) -> dict[str, Any]:
    """AI reading of an unknown PDF layout, with the operator's env key only."""
    if not pdf_ai_available():
        raise SmartImportError("ai_unavailable")
    return await run_extract(_hosted_provider(), body)
