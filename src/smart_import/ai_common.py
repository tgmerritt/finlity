"""Shared plumbing for the smart import AI calls (design 6.2 and 6.3).

Nothing here logs. Provider errors become fixed ``SmartImportError``s with no
chained cause, because provider exception text can quote the request.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any, TypeVar

from src.services.ai_config import get_model_for_task
from src.services.providers.base import InferenceMessage, InferenceProvider

from .errors import SmartImportError

# One provider call per request. The SDK client gives up first, the request
# budget second, and both stay well under Heroku's 30 s router timeout.
CLIENT_TIMEOUT_SECONDS = 18.0
AI_CALL_TIMEOUT_SECONDS = 22.0
MAX_TOKENS = 4000
TEMPERATURE = 0.0

T = TypeVar("T")


def encode_data(value: Any) -> str:
    """JSON for a delimited prompt block.

    ASCII only, and ``<``, ``>`` and ``&`` escaped as ``\\u003c`` and friends,
    so no merchant or line string can close the block it sits in. The result is
    still valid JSON that decodes to ``value``.
    """
    text = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    return text.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def model_for(provider: InferenceProvider) -> str | None:
    """Claude gets the fast model; other providers use their own default."""
    return get_model_for_task("fast") if provider.info.id == "claude" else None


def model_label(provider: InferenceProvider, model: str | None) -> str | None:
    if model:
        return model
    default = provider.info.get_default_model()
    return default.id if default else None


def call_provider(
    provider: InferenceProvider,
    system: str,
    messages: list[InferenceMessage],
    model: str | None,
) -> str:
    """One completion with the fixed settings. Returns the response text."""
    try:
        response = provider.complete(
            messages,
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            temperature=TEMPERATURE,
        )
    except Exception:
        raise SmartImportError("ai_provider_error") from None
    if response.stop_reason == "max_tokens":
        raise SmartImportError("ai_bad_response")
    content = response.content
    if not isinstance(content, str):
        raise SmartImportError("ai_bad_response")
    return content


_FENCE_OPEN = "```"


def load_json_array(text: str) -> list[Any]:
    """Strictly decode a JSON array, allowing one surrounding code fence."""
    body = (text or "").strip()
    if body.startswith(_FENCE_OPEN):
        first_newline = body.find("\n")
        if first_newline == -1 or not body.endswith(_FENCE_OPEN):
            raise SmartImportError("ai_bad_response")
        body = body[first_newline + 1 : -len(_FENCE_OPEN)].strip()
    try:
        value = json.loads(body)
    except (ValueError, RecursionError):
        raise SmartImportError("ai_bad_response") from None
    if not isinstance(value, list):
        raise SmartImportError("ai_bad_response")
    return value


async def run_with_budget(func: Callable[..., T], *args: Any) -> T:
    """Run a blocking AI call in a worker thread under the request budget.

    On timeout the response is 504 ``ai_timeout``. The worker thread itself
    cannot be cancelled; the hosted Claude client's own timeout ends it.
    """
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(func, *args), timeout=AI_CALL_TIMEOUT_SECONDS
        )
    except (asyncio.TimeoutError, TimeoutError):
        raise SmartImportError("ai_timeout") from None
