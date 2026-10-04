"""Claude/Anthropic inference provider implementation."""

import logging
import os
from typing import Iterator, Optional

from .base import (
    InferenceMessage,
    InferenceProvider,
    InferenceProviderError,
    InferenceResponse,
    ModelInfo,
    ProviderInfo,
    ProviderNotConfiguredError,
    ProviderRateLimitError,
    StreamEvent,
)

logger = logging.getLogger(__name__)


class ClaudeProvider(InferenceProvider):
    """Anthropic Claude AI provider."""

    # Current Claude 4.X family. Display order matches expected UI: cheapest first
    # (Haiku) → balanced default (Sonnet) → most capable (Opus).
    MODELS = [
        ModelInfo(
            id="claude-haiku-4-5-20251001",
            display_name="Claude Haiku 4.5",
            context_length=200000,
            capabilities=["streaming", "tools", "vision"],
            is_default=False,
        ),
        ModelInfo(
            id="claude-sonnet-4-6",
            display_name="Claude Sonnet 4.6",
            context_length=200000,
            capabilities=["streaming", "tools", "vision"],
            is_default=True,
        ),
        ModelInfo(
            id="claude-opus-4-7",
            display_name="Claude Opus 4.7",
            context_length=200000,
            capabilities=["streaming", "tools", "vision"],
            is_default=False,
        ),
    ]

    def __init__(
        self,
        db=None,
        api_key: Optional[str] = None,
        timeout: Optional[float] = None,
        max_retries: Optional[int] = None,
    ):
        """Initialize Claude provider.

        Args:
            db: Optional database connection for secrets lookup
            api_key: Optional explicit API key. Used as-is (no demo-mode gate,
                no DB lookup) — this is the injection point for the stateless
                v2 API, which resolves its key from the environment directly
                (see src/api/v2/analysis.py) and must never touch app_settings.
            timeout: Optional per-request timeout in seconds for the SDK client.
                Unset keeps the SDK default.
            max_retries: Optional SDK retry count. Unset keeps the SDK default.
        """
        self._db = db
        self._explicit_api_key = api_key
        self._timeout = timeout
        self._max_retries = max_retries
        self._client = None
        self._info = ProviderInfo(
            id="claude",
            display_name="Anthropic Claude",
            models=self.MODELS.copy(),
            api_key_env_var="ANTHROPIC_API_KEY",
            api_key_db_name="anthropic_api_key",
            is_openai_compatible=False,
        )

    @property
    def info(self) -> ProviderInfo:
        return self._info

    def get_api_key(self) -> Optional[str]:
        """Get API key from an explicit override, env, or database.

        Environment variable keys are only used in demo mode. This prevents
        hosted deployments from paying for API usage by non-demo users.
        When not in demo mode, users must configure their own API keys.
        """
        # Explicit key takes precedence (v2 stateless callers only).
        if self._explicit_api_key:
            return self._explicit_api_key

        from src.services.demo_mode import allow_env_api_keys

        # Check environment first, but only if demo mode is enabled
        if allow_env_api_keys():
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if api_key:
                return api_key

        # Check database if available (user's personal keys)
        if self._db:
            from src.services.secrets import SecretsManager

            secrets = SecretsManager(self._db)
            return secrets.get_api_key("anthropic_api_key")

        return None

    def is_available(self) -> bool:
        """Check if Claude is available (has API key)."""
        return self.get_api_key() is not None

    def _get_client(self):
        """Get or create Anthropic client."""
        if self._client is None:
            api_key = self.get_api_key()
            if not api_key:
                raise ProviderNotConfiguredError(
                    "Anthropic API key not configured. Set ANTHROPIC_API_KEY environment "
                    "variable or configure in Settings."
                )
            try:
                import anthropic

                client_kwargs: dict = {"api_key": api_key}
                if self._timeout is not None:
                    client_kwargs["timeout"] = self._timeout
                if self._max_retries is not None:
                    client_kwargs["max_retries"] = self._max_retries
                self._client = anthropic.Anthropic(**client_kwargs)
            except ImportError:
                raise InferenceProviderError(
                    "anthropic package not installed. Run: pip install anthropic"
                )
        return self._client

    @staticmethod
    def _build_system_param(system, cache_system: bool):
        """Build the `system` kwarg for the Anthropic SDK.

        - If `system` is already a list (caller-supplied content blocks), pass
          through unchanged. The caller is responsible for any cache_control.
        - If `system` is a string and `cache_system=True`, wrap it in a single
          ephemeral content block so the system prompt (and tools, which render
          before it) are cacheable.
        - If `system` is a string and `cache_system=False`, return it as-is —
          preserves existing behavior.
        """
        if isinstance(system, list):
            return system
        if cache_system:
            return [
                {
                    "type": "text",
                    "text": system,
                    "cache_control": {"type": "ephemeral"},
                }
            ]
        return system

    @staticmethod
    def _apply_message_cache_breakpoints(
        anthropic_messages: list[dict],
        cache_breakpoints: Optional[list[int]],
    ) -> None:
        """Mutate `anthropic_messages` in place, marking the last content block
        of each indexed message with cache_control: ephemeral.

        Anthropic's API requires content to be a list of blocks for
        cache_control to attach; if the message content is a plain string we
        wrap it in a single text block before marking it.
        """
        if not cache_breakpoints:
            return
        for idx in cache_breakpoints:
            if idx < 0 or idx >= len(anthropic_messages):
                continue
            msg = anthropic_messages[idx]
            content = msg.get("content")
            if isinstance(content, str):
                msg["content"] = [
                    {
                        "type": "text",
                        "text": content,
                        "cache_control": {"type": "ephemeral"},
                    }
                ]
            elif isinstance(content, list) and content:
                # Mark the last block. Copy to avoid mutating shared block dicts.
                last = dict(content[-1])
                last["cache_control"] = {"type": "ephemeral"}
                content[-1] = last

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
        """Generate a completion using Claude."""
        self._validate_messages(messages)
        client = self._get_client()
        model_info = self.get_model(model)

        # Convert messages to Anthropic format
        anthropic_messages = [
            {"role": msg.role, "content": msg.content}
            for msg in messages
            if msg.role != "system"
        ]
        self._apply_message_cache_breakpoints(anthropic_messages, cache_breakpoints)

        # Build request kwargs
        kwargs = {
            "model": model_info.id,
            "max_tokens": max_tokens,
            "messages": anthropic_messages,
            "temperature": temperature,
        }

        if system:
            kwargs["system"] = self._build_system_param(system, cache_system)

        if tools:
            kwargs["tools"] = tools

        try:
            response = client.messages.create(**kwargs)

            # Extract content
            content = ""
            tool_calls = []

            for block in response.content:
                if block.type == "text":
                    content = block.text
                elif block.type == "tool_use":
                    tool_calls.append(
                        {
                            "id": block.id,
                            "name": block.name,
                            "input": block.input,
                        }
                    )

            cache_creation = getattr(
                response.usage, "cache_creation_input_tokens", None
            )
            cache_read = getattr(response.usage, "cache_read_input_tokens", None)
            if cache_system or cache_breakpoints:
                logger.info(
                    "Claude cache: created %s tokens, read %s tokens, model %s",
                    cache_creation or 0,
                    cache_read or 0,
                    response.model,
                )

            return InferenceResponse(
                content=content,
                model=response.model,
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                tool_calls=tool_calls if tool_calls else None,
                stop_reason=response.stop_reason,
                cache_creation_input_tokens=cache_creation,
                cache_read_input_tokens=cache_read,
            )

        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str and "limit" in error_str:
                raise ProviderRateLimitError(f"Claude rate limit exceeded: {e}")
            raise InferenceProviderError(f"Claude API error: {e}")

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
        """Stream a completion using Claude."""
        self._validate_messages(messages)
        client = self._get_client()
        model_info = self.get_model(model)

        # Convert messages to Anthropic format
        anthropic_messages = [
            {"role": msg.role, "content": msg.content}
            for msg in messages
            if msg.role != "system"
        ]
        self._apply_message_cache_breakpoints(anthropic_messages, cache_breakpoints)

        # Build request kwargs
        kwargs = {
            "model": model_info.id,
            "max_tokens": max_tokens,
            "messages": anthropic_messages,
            "temperature": temperature,
        }

        if system:
            kwargs["system"] = self._build_system_param(system, cache_system)

        if tools:
            kwargs["tools"] = tools

        try:
            with client.messages.stream(**kwargs) as stream:
                current_tool_call = None

                for event in stream:
                    event_type = getattr(event, "type", None)

                    if event_type == "message_start":
                        usage = getattr(event.message, "usage", None)
                        if usage:
                            cache_creation = getattr(
                                usage, "cache_creation_input_tokens", None
                            )
                            cache_read = getattr(
                                usage, "cache_read_input_tokens", None
                            )
                            if cache_system or cache_breakpoints:
                                logger.info(
                                    "Claude cache (stream): created %s tokens, "
                                    "read %s tokens, model %s",
                                    cache_creation or 0,
                                    cache_read or 0,
                                    model_info.id,
                                )
                            yield StreamEvent(
                                type="message_start",
                                input_tokens=usage.input_tokens,
                                cache_creation_input_tokens=cache_creation,
                                cache_read_input_tokens=cache_read,
                            )

                    elif event_type == "content_block_start":
                        block = event.content_block
                        if block.type == "tool_use":
                            current_tool_call = {
                                "id": block.id,
                                "name": block.name,
                                "input": "",
                            }

                    elif event_type == "content_block_delta":
                        delta = event.delta
                        if hasattr(delta, "text"):
                            yield StreamEvent(type="text", text=delta.text)
                        elif hasattr(delta, "partial_json"):
                            if current_tool_call:
                                current_tool_call["input"] += delta.partial_json

                    elif event_type == "content_block_stop":
                        if current_tool_call:
                            # Parse the accumulated JSON input
                            import json

                            try:
                                current_tool_call["input"] = json.loads(
                                    current_tool_call["input"]
                                )
                            except json.JSONDecodeError:
                                pass  # Keep as string if not valid JSON
                            yield StreamEvent(
                                type="tool_use", tool_call=current_tool_call
                            )
                            current_tool_call = None

                    elif event_type == "message_delta":
                        usage = getattr(event, "usage", None)
                        if usage:
                            yield StreamEvent(
                                type="message_stop",
                                output_tokens=usage.output_tokens,
                            )

        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str and "limit" in error_str:
                yield StreamEvent(type="error", error=f"Rate limit exceeded: {e}")
            else:
                yield StreamEvent(type="error", error=f"Claude API error: {e}")
