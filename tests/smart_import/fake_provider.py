"""A fake InferenceProvider for smart import tests and local check servers.

It never touches the network and never holds a key. ``complete`` records every
argument it was called with, so a test can prove exactly what would have been
sent to a real provider, and returns canned text (or raises a canned error).
"""

from __future__ import annotations

import time
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


class FakeProvider(InferenceProvider):
    def __init__(
        self,
        text: str = "[]",
        *,
        provider_id: str = "claude",
        display_name: str = "Anthropic Claude",
        available: bool = True,
        raises: Exception | None = None,
        delay: float = 0.0,
        stop_reason: str = "end_turn",
        texts: list[str] | None = None,
    ) -> None:
        self.text = text
        # When set, call i answers texts[i] (the last one repeats); else text.
        self.texts = texts
        self.available = available
        self.raises = raises
        self.delay = delay
        self.stop_reason = stop_reason
        self.calls: list[dict[str, Any]] = []
        self._info = ProviderInfo(
            id=provider_id,
            display_name=display_name,
            models=[
                ModelInfo(
                    id="fake-default",
                    display_name="Fake default",
                    context_length=1000,
                    is_default=True,
                ),
                ModelInfo(
                    id="claude-haiku-4-5-20251001",
                    display_name="Fake Haiku",
                    context_length=1000,
                ),
            ],
        )

    @property
    def info(self) -> ProviderInfo:
        return self._info

    def is_available(self) -> bool:
        return self.available

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
        self.calls.append(
            {
                "messages": [(m.role, m.content) for m in messages],
                "model": model,
                "max_tokens": max_tokens,
                "system": system,
                "temperature": temperature,
                "tools": tools,
            }
        )
        if self.delay:
            time.sleep(self.delay)
        if self.raises is not None:
            raise self.raises
        if self.texts:
            content = self.texts[min(len(self.calls), len(self.texts)) - 1]
        else:
            content = self.text
        return InferenceResponse(
            content=content,
            model=model or "fake-default",
            stop_reason=self.stop_reason,
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
