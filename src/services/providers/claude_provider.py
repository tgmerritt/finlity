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

    # Claude models with capabilities
    MODELS = [
        ModelInfo(
            id="claude-3-5-haiku-20241022",
            display_name="Claude Haiku 3.5",
            context_length=200000,
            capabilities=["streaming", "tools", "vision"],
            is_default=False,
        ),
        ModelInfo(
            id="claude-sonnet-4-20250514",
            display_name="Claude Sonnet 4",
            context_length=200000,
            capabilities=["streaming", "tools", "vision"],
            is_default=True,
        ),
        ModelInfo(
            id="claude-opus-4-5-20251101",
            display_name="Claude Opus 4.5",
            context_length=200000,
            capabilities=["streaming", "tools", "vision"],
            is_default=False,
        ),
    ]

    def __init__(self, db=None):
        """Initialize Claude provider.

        Args:
            db: Optional database connection for secrets lookup
        """
        self._db = db
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
        """Get API key from env or database.

        Environment variable keys are only used in demo mode. This prevents
        hosted deployments from paying for API usage by non-demo users.
        When not in demo mode, users must configure their own API keys.
        """
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

                self._client = anthropic.Anthropic(api_key=api_key)
            except ImportError:
                raise InferenceProviderError(
                    "anthropic package not installed. Run: pip install anthropic"
                )
        return self._client

    def complete(
        self,
        messages: list[InferenceMessage],
        model: Optional[str] = None,
        max_tokens: int = 1024,
        system: Optional[str] = None,
        temperature: float = 1.0,
        tools: Optional[list[dict]] = None,
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

        # Build request kwargs
        kwargs = {
            "model": model_info.id,
            "max_tokens": max_tokens,
            "messages": anthropic_messages,
            "temperature": temperature,
        }

        if system:
            kwargs["system"] = system

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

            return InferenceResponse(
                content=content,
                model=response.model,
                input_tokens=response.usage.input_tokens,
                output_tokens=response.usage.output_tokens,
                tool_calls=tool_calls if tool_calls else None,
                stop_reason=response.stop_reason,
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

        # Build request kwargs
        kwargs = {
            "model": model_info.id,
            "max_tokens": max_tokens,
            "messages": anthropic_messages,
            "temperature": temperature,
        }

        if system:
            kwargs["system"] = system

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
                            yield StreamEvent(
                                type="message_start",
                                input_tokens=usage.input_tokens,
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
