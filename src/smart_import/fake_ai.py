"""An offline provider for local check servers (``SMART_IMPORT_AI_FAKE=true``).

It answers from the prompt it is given, never touches the network and needs no
key, so AI paths can be exercised without a real key on a check server. It is
never served in production: with ``DYNO`` set (Heroku) the flag is ignored and
AI is treated as unavailable, so a stray flag can neither serve placeholders
nor fall back to spending the real key. It still
sits behind the same opt-in gates (env flags in hosted mode, consent in server
mode). Answers are deterministic placeholders: every merchant gets the first
category at confidence 0.5, and extraction finds no rows.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterator
from typing import Any, Optional

from src.services.providers.base import (
    InferenceMessage,
    InferenceProvider,
    InferenceResponse,
    ModelInfo,
    ProviderInfo,
    StreamEvent,
)

from .env import env_flag, on_heroku

logger = logging.getLogger(__name__)

_ignored_logged = False
_BLOCK_RE = re.compile(r"<(categories|items)>\n(.*?)\n</\1>", re.S)


def _fake_requested() -> bool:
    return env_flag("SMART_IMPORT_AI_FAKE")


def fake_ai_enabled() -> bool:
    """The offline fake is requested and this is not a production dyno."""
    return _fake_requested() and not on_heroku()


def fake_ai_blocked() -> bool:
    """The fake was requested on a production dyno: AI must be unavailable.

    Logs ``smart_import_fake_ignored`` at most once per process.
    """
    global _ignored_logged
    if not (_fake_requested() and on_heroku()):
        return False
    if not _ignored_logged:
        _ignored_logged = True
        logger.warning("smart_import_fake_ignored")
    return True


class OfflineFakeProvider(InferenceProvider):
    def __init__(self) -> None:
        self._info = ProviderInfo(
            id="offline-fake",
            display_name="Offline fake",
            models=[
                ModelInfo(
                    id="offline-fake",
                    display_name="Offline fake",
                    context_length=0,
                    is_default=True,
                )
            ],
        )

    @property
    def info(self) -> ProviderInfo:
        return self._info

    def is_available(self) -> bool:
        return True

    def get_api_key(self) -> Optional[str]:
        return None

    def complete(
        self,
        messages: list[InferenceMessage],
        model: Optional[str] = None,
        max_tokens: int = 1024,
        system: Optional[str] = None,
        temperature: float = 1.0,
        tools: Optional[list[dict]] = None,
        cache_system: bool = False,
        cache_breakpoints: Optional[list[int]] = None,
    ) -> InferenceResponse:
        text = messages[-1].content if messages else ""
        blocks: dict[str, Any] = {}
        for name, body in _BLOCK_RE.findall(text):
            try:
                blocks[name] = json.loads(body)
            except ValueError:
                blocks[name] = []
        answer: list[dict[str, Any]] = []
        categories = blocks.get("categories") or []
        for item in blocks.get("items") or []:
            if isinstance(item, dict) and "id" in item:
                answer.append(
                    {
                        "id": item["id"],
                        "category": categories[0] if categories else None,
                        "kind": "expense",
                        "confidence": 0.5,
                    }
                )
        return InferenceResponse(
            content=json.dumps(answer), model="offline-fake", stop_reason="end_turn"
        )

    def stream(
        self,
        messages: list[InferenceMessage],
        model: Optional[str] = None,
        max_tokens: int = 1024,
        system: Optional[str] = None,
        temperature: float = 1.0,
        tools: Optional[list[dict]] = None,
        cache_system: bool = False,
        cache_breakpoints: Optional[list[int]] = None,
    ) -> Iterator[StreamEvent]:
        raise NotImplementedError("smart import never streams")
