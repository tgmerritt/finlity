"""Gemini inference provider implementation (OpenAI-compatible API)."""

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


class GeminiProvider(InferenceProvider):
    """Gemini AI provider using OpenAI-compatible API."""

    BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

    # Gemini models
    MODELS = [
        ModelInfo(
            id="gemini-1.5-flash",
            display_name="Gemini 1.5 Flash",
            context_length=1048576,
            capabilities=["streaming", "tools"],
            is_default=True,
        ),
        ModelInfo(
            id="gemini-1.5-pro",
            display_name="Gemini 1.5 Pro",
            context_length=2097152,
            capabilities=["streaming", "tools"],
            is_default=False,
        ),
        ModelInfo(
            id="gemini-2.0-flash-exp",
            display_name="Gemini 2.0 Flash (Experimental)",
            context_length=1048576,
            capabilities=["streaming", "tools"],
            is_default=False,
        ),
    ]

    def __init__(self, db=None):
        """Initialize Gemini provider.

        Args:
            db: Optional database connection for secrets lookup
        """
        self._db = db
        self._client = None
        self._info = ProviderInfo(
            id="gemini",
            display_name="Google Gemini",
            models=self.MODELS.copy(),
            api_key_env_var="GEMINI_API_KEY",
            api_key_db_name="gemini_api_key",
            is_openai_compatible=True,
            base_url=self.BASE_URL,
        )

    @property
    def info(self) -> ProviderInfo:
        return self._info

    def get_api_key(self) -> Optional[str]:
        """Get API key from env or database."""
        # Check environment first
        api_key = os.environ.get("GEMINI_API_KEY")
        if api_key:
            return api_key

        # Check database if available
        if self._db:
            from src.services.secrets import SecretsManager

            secrets = SecretsManager(self._db)
            return secrets.get_api_key("gemini_api_key")

        return None

    def is_available(self) -> bool:
        """Check if Gemini is available (has API key)."""
        return self.get_api_key() is not None

    def _get_client(self):
        """Get or create OpenAI client configured for Gemini."""
        if self._client is None:
            api_key = self.get_api_key()
            if not api_key:
                raise ProviderNotConfiguredError(
                    "Gemini API key not configured. Set GEMINI_API_KEY environment "
                    "variable or configure in Settings."
                )
            try:
                from openai import OpenAI

                self._client = OpenAI(
                    api_key=api_key,
                    base_url=self.BASE_URL,
                )
            except ImportError:
                raise InferenceProviderError(
                    "openai package not installed. Run: pip install openai"
                )
        return self._client

    def _convert_messages(
        self, messages: list[InferenceMessage], system: Optional[str] = None
    ) -> list[dict]:
        """Convert InferenceMessages to OpenAI format."""
        openai_messages = []

        # Add system message if provided
        if system:
            openai_messages.append({"role": "system", "content": system})

        # Add conversation messages
        for msg in messages:
            if msg.role == "system":
                # System messages go first, skip if we already have one
                if not system:
                    openai_messages.insert(0, {"role": "system", "content": msg.content})
            else:
                openai_messages.append({"role": msg.role, "content": msg.content})

        return openai_messages

    def complete(
        self,
        messages: list[InferenceMessage],
        model: Optional[str] = None,
        max_tokens: int = 1024,
        system: Optional[str] = None,
        temperature: float = 1.0,
        tools: Optional[list[dict]] = None,
    ) -> InferenceResponse:
        """Generate a completion using Gemini."""
        self._validate_messages(messages)
        client = self._get_client()
        model_info = self.get_model(model)

        # Convert messages to OpenAI format
        openai_messages = self._convert_messages(messages, system)

        # Build request kwargs
        kwargs = {
            "model": model_info.id,
            "max_tokens": max_tokens,
            "messages": openai_messages,
            "temperature": temperature,
        }

        # Add tools if supported by model and provided
        if tools and self.supports_tools(model_info.id):
            # Convert to OpenAI tool format
            from .tool_adapter import claude_tools_to_openai

            kwargs["tools"] = claude_tools_to_openai(tools)

        try:
            response = client.chat.completions.create(**kwargs)

            # Extract content and tool calls
            message = response.choices[0].message
            content = message.content or ""
            tool_calls = None

            if message.tool_calls:
                import json

                tool_calls = []
                for tc in message.tool_calls:
                    tool_calls.append(
                        {
                            "id": tc.id,
                            "name": tc.function.name,
                            "input": json.loads(tc.function.arguments),
                        }
                    )

            return InferenceResponse(
                content=content,
                model=response.model,
                input_tokens=response.usage.prompt_tokens if response.usage else 0,
                output_tokens=response.usage.completion_tokens if response.usage else 0,
                tool_calls=tool_calls,
                stop_reason=response.choices[0].finish_reason,
            )

        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str and "limit" in error_str:
                raise ProviderRateLimitError(f"Gemini rate limit exceeded: {e}")
            raise InferenceProviderError(f"Gemini API error: {e}")

    def stream(
        self,
        messages: list[InferenceMessage],
        model: Optional[str] = None,
        max_tokens: int = 1024,
        system: Optional[str] = None,
        temperature: float = 1.0,
        tools: Optional[list[dict]] = None,
    ) -> Iterator[StreamEvent]:
        """Stream a completion using Gemini."""
        self._validate_messages(messages)
        client = self._get_client()
        model_info = self.get_model(model)

        # Convert messages to OpenAI format
        openai_messages = self._convert_messages(messages, system)

        # Build request kwargs
        kwargs = {
            "model": model_info.id,
            "max_tokens": max_tokens,
            "messages": openai_messages,
            "temperature": temperature,
            "stream": True,
            "stream_options": {"include_usage": True},
        }

        # Add tools if supported by model and provided
        if tools and self.supports_tools(model_info.id):
            from .tool_adapter import claude_tools_to_openai

            kwargs["tools"] = claude_tools_to_openai(tools)

        try:
            stream = client.chat.completions.create(**kwargs)

            current_tool_call = None
            tool_call_args = ""

            for chunk in stream:
                # Handle usage info (sent at the end)
                if chunk.usage:
                    yield StreamEvent(
                        type="message_stop",
                        input_tokens=chunk.usage.prompt_tokens,
                        output_tokens=chunk.usage.completion_tokens,
                    )
                    continue

                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta

                # Handle text content
                if delta.content:
                    yield StreamEvent(type="text", text=delta.content)

                # Handle tool calls
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        if tc.id:
                            # New tool call starting
                            if current_tool_call and tool_call_args:
                                # Finish previous tool call
                                import json

                                try:
                                    current_tool_call["input"] = json.loads(
                                        tool_call_args
                                    )
                                except json.JSONDecodeError:
                                    current_tool_call["input"] = tool_call_args
                                yield StreamEvent(
                                    type="tool_use", tool_call=current_tool_call
                                )

                            current_tool_call = {
                                "id": tc.id,
                                "name": tc.function.name if tc.function else "",
                                "input": {},
                            }
                            tool_call_args = ""

                        if tc.function and tc.function.arguments:
                            tool_call_args += tc.function.arguments

                # Check for finish reason
                if chunk.choices[0].finish_reason:
                    # Finish any pending tool call
                    if current_tool_call and tool_call_args:
                        import json

                        try:
                            current_tool_call["input"] = json.loads(tool_call_args)
                        except json.JSONDecodeError:
                            current_tool_call["input"] = tool_call_args
                        yield StreamEvent(type="tool_use", tool_call=current_tool_call)

        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str and "limit" in error_str:
                yield StreamEvent(type="error", error=f"Rate limit exceeded: {e}")
            else:
                yield StreamEvent(type="error", error=f"Gemini API error: {e}")
