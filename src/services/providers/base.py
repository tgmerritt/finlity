"""Base classes and interfaces for inference providers."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional


class InferenceProviderError(Exception):
    """Base exception for inference provider errors."""

    pass


class ProviderNotConfiguredError(InferenceProviderError):
    """Raised when a provider is not configured (missing API key)."""

    pass


class ProviderRateLimitError(InferenceProviderError):
    """Raised when a provider rate limit is hit."""

    pass


@dataclass
class ModelInfo:
    """Information about a specific AI model."""

    id: str  # e.g., "claude-sonnet-4-20250514"
    display_name: str  # e.g., "Claude Sonnet 4"
    context_length: int
    capabilities: list[str] = field(default_factory=list)  # streaming, tools, vision
    is_default: bool = False


@dataclass
class ProviderInfo:
    """Information about an AI provider."""

    id: str  # "claude", "cerebras", "openai"
    display_name: str  # "Anthropic Claude"
    models: list[ModelInfo] = field(default_factory=list)
    api_key_env_var: str = ""  # "ANTHROPIC_API_KEY"
    api_key_db_name: str = ""  # "anthropic_api_key"
    is_openai_compatible: bool = False
    base_url: Optional[str] = None

    def get_default_model(self) -> Optional[ModelInfo]:
        """Get the default model for this provider."""
        for model in self.models:
            if model.is_default:
                return model
        return self.models[0] if self.models else None


@dataclass
class InferenceMessage:
    """A message in a conversation."""

    role: str  # "user", "assistant", "system"
    content: str


@dataclass
class InferenceResponse:
    """Response from an inference provider."""

    content: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: Optional[list[dict]] = None
    stop_reason: Optional[str] = None


@dataclass
class StreamEvent:
    """An event from a streaming response."""

    type: str  # "text", "tool_use", "message_start", "message_stop", "error"
    text: Optional[str] = None
    tool_call: Optional[dict] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    error: Optional[str] = None


class InferenceProvider(ABC):
    """Abstract base class for AI inference providers."""

    @property
    @abstractmethod
    def info(self) -> ProviderInfo:
        """Return information about this provider."""
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """Check if this provider is available (has API key configured)."""
        pass

    @abstractmethod
    def get_api_key(self) -> Optional[str]:
        """Get the API key for this provider."""
        pass

    @abstractmethod
    def complete(
        self,
        messages: list[InferenceMessage],
        model: Optional[str] = None,
        max_tokens: int = 1024,
        system: Optional[str] = None,
        temperature: float = 1.0,
        tools: Optional[list[dict]] = None,
    ) -> InferenceResponse:
        """
        Generate a completion for the given messages.

        Args:
            messages: List of conversation messages
            model: Model ID to use (defaults to provider's default)
            max_tokens: Maximum tokens to generate
            system: System prompt
            temperature: Sampling temperature
            tools: List of tool definitions (in provider-native format)

        Returns:
            InferenceResponse with the generated content
        """
        pass

    @abstractmethod
    def stream(
        self,
        messages: list[InferenceMessage],
        model: Optional[str] = None,
        max_tokens: int = 1024,
        system: Optional[str] = None,
        temperature: float = 1.0,
        tools: Optional[list[dict]] = None,
    ) -> Iterator[StreamEvent]:
        """
        Stream a completion for the given messages.

        Args:
            messages: List of conversation messages
            model: Model ID to use (defaults to provider's default)
            max_tokens: Maximum tokens to generate
            system: System prompt
            temperature: Sampling temperature
            tools: List of tool definitions (in provider-native format)

        Yields:
            StreamEvent objects as they are generated
        """
        pass

    def get_model(self, model_id: Optional[str] = None) -> ModelInfo:
        """Get model info, falling back to default if not specified."""
        if model_id is None:
            default = self.info.get_default_model()
            if default is None:
                raise InferenceProviderError(
                    f"No default model for provider {self.info.id}"
                )
            return default

        for model in self.info.models:
            if model.id == model_id:
                return model

        raise InferenceProviderError(
            f"Model {model_id} not found for provider {self.info.id}"
        )

    def supports_tools(self, model_id: Optional[str] = None) -> bool:
        """Check if the provider/model supports tool use."""
        model = self.get_model(model_id)
        return "tools" in model.capabilities

    def supports_streaming(self, model_id: Optional[str] = None) -> bool:
        """Check if the provider/model supports streaming."""
        model = self.get_model(model_id)
        return "streaming" in model.capabilities

    def _validate_messages(self, messages: list[InferenceMessage]) -> None:
        """Validate message format."""
        if not messages:
            raise InferenceProviderError("Messages list cannot be empty")

        valid_roles = {"user", "assistant", "system"}
        for msg in messages:
            if msg.role not in valid_roles:
                raise InferenceProviderError(f"Invalid message role: {msg.role}")

    def to_dict(self) -> dict[str, Any]:
        """Convert provider to dictionary for API responses."""
        return {
            "id": self.info.id,
            "display_name": self.info.display_name,
            "is_available": self.is_available(),
            "models": [
                {
                    "id": m.id,
                    "display_name": m.display_name,
                    "context_length": m.context_length,
                    "capabilities": m.capabilities,
                    "is_default": m.is_default,
                }
                for m in self.info.models
            ],
        }
