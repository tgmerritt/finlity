"""Tests for the InferenceProvider abstraction layer."""

import pytest
from unittest.mock import MagicMock, patch

from src.services.providers.base import (
    InferenceMessage,
    InferenceProvider,
    InferenceResponse,
    ModelInfo,
    ProviderInfo,
    InferenceProviderError,
    ProviderNotConfiguredError,
    StreamEvent,
)
from src.services.providers.registry import ProviderRegistry, reset_registry
from src.services.providers.tool_adapter import (
    claude_tools_to_openai,
    openai_tools_to_claude,
    normalize_tool_call,
)


class MockProvider(InferenceProvider):
    """Mock provider for testing."""

    def __init__(self, provider_id="mock", available=True):
        self._available = available
        self._info = ProviderInfo(
            id=provider_id,
            display_name=f"Mock {provider_id}",
            models=[
                ModelInfo(
                    id="mock-model",
                    display_name="Mock Model",
                    context_length=4096,
                    capabilities=["streaming", "tools"],
                    is_default=True,
                ),
            ],
            api_key_env_var="MOCK_API_KEY",
        )

    @property
    def info(self) -> ProviderInfo:
        return self._info

    def is_available(self) -> bool:
        return self._available

    def get_api_key(self):
        return "mock-key" if self._available else None

    def complete(self, messages, model=None, max_tokens=1024, system=None, temperature=1.0, tools=None):
        return InferenceResponse(
            content="Mock response",
            model="mock-model",
            input_tokens=10,
            output_tokens=5,
        )

    def stream(self, messages, model=None, max_tokens=1024, system=None, temperature=1.0, tools=None):
        yield StreamEvent(type="text", text="Mock ")
        yield StreamEvent(type="text", text="response")
        yield StreamEvent(type="message_stop", output_tokens=5)


class TestProviderRegistry:
    """Tests for ProviderRegistry."""

    def setup_method(self):
        """Reset registry before each test."""
        reset_registry()

    def test_register_provider(self):
        """Test registering a provider."""
        registry = ProviderRegistry()
        provider = MockProvider("test")
        registry.register(provider)

        assert "test" in registry.get_provider_ids()
        assert registry.get("test") is provider

    def test_unregister_provider(self):
        """Test unregistering a provider."""
        registry = ProviderRegistry()
        provider = MockProvider("test")
        registry.register(provider)
        registry.unregister("test")

        assert "test" not in registry.get_provider_ids()
        assert registry.get("test") is None

    def test_get_available_providers(self):
        """Test getting available providers."""
        registry = ProviderRegistry()
        registry.register(MockProvider("available", available=True))
        registry.register(MockProvider("unavailable", available=False))

        available = registry.get_available()
        assert len(available) == 1
        assert available[0].info.id == "available"

    def test_get_provider_with_fallback_preferred(self):
        """Test fallback uses preferred provider when available."""
        registry = ProviderRegistry()
        registry.register(MockProvider("claude", available=True))
        registry.register(MockProvider("openai", available=True))
        registry.set_default("claude")

        provider = registry.get_provider_with_fallback("openai")
        assert provider.info.id == "openai"

    def test_get_provider_with_fallback_default(self):
        """Test fallback uses default when preferred not available."""
        registry = ProviderRegistry()
        registry.register(MockProvider("claude", available=True))
        registry.register(MockProvider("openai", available=False))
        registry.set_default("claude")

        provider = registry.get_provider_with_fallback("openai")
        assert provider.info.id == "claude"

    def test_get_provider_with_fallback_any(self):
        """Test fallback uses any available when default not available."""
        registry = ProviderRegistry()
        registry.register(MockProvider("claude", available=False))
        registry.register(MockProvider("openai", available=True))
        registry.set_default("claude")

        provider = registry.get_provider_with_fallback()
        assert provider.info.id == "openai"

    def test_get_provider_with_fallback_none_available(self):
        """Test fallback raises error when no providers available."""
        registry = ProviderRegistry()
        registry.register(MockProvider("claude", available=False))
        registry.set_default("claude")

        with pytest.raises(ProviderNotConfiguredError):
            registry.get_provider_with_fallback()


class TestInferenceMessage:
    """Tests for InferenceMessage."""

    def test_message_creation(self):
        """Test creating a message."""
        msg = InferenceMessage(role="user", content="Hello")
        assert msg.role == "user"
        assert msg.content == "Hello"


class TestInferenceResponse:
    """Tests for InferenceResponse."""

    def test_response_creation(self):
        """Test creating a response."""
        resp = InferenceResponse(
            content="Hello",
            model="test-model",
            input_tokens=10,
            output_tokens=5,
        )
        assert resp.content == "Hello"
        assert resp.model == "test-model"
        assert resp.input_tokens == 10
        assert resp.output_tokens == 5


class TestModelInfo:
    """Tests for ModelInfo."""

    def test_model_capabilities(self):
        """Test model capabilities."""
        model = ModelInfo(
            id="test",
            display_name="Test",
            context_length=4096,
            capabilities=["streaming", "tools"],
        )
        assert "streaming" in model.capabilities
        assert "tools" in model.capabilities


class TestProviderInfo:
    """Tests for ProviderInfo."""

    def test_get_default_model(self):
        """Test getting default model."""
        provider_info = ProviderInfo(
            id="test",
            display_name="Test",
            models=[
                ModelInfo(id="model1", display_name="Model 1", context_length=4096, is_default=False),
                ModelInfo(id="model2", display_name="Model 2", context_length=4096, is_default=True),
            ],
        )
        default = provider_info.get_default_model()
        assert default.id == "model2"

    def test_get_default_model_first_fallback(self):
        """Test getting first model when no default set."""
        provider_info = ProviderInfo(
            id="test",
            display_name="Test",
            models=[
                ModelInfo(id="model1", display_name="Model 1", context_length=4096, is_default=False),
                ModelInfo(id="model2", display_name="Model 2", context_length=4096, is_default=False),
            ],
        )
        default = provider_info.get_default_model()
        assert default.id == "model1"


class TestToolAdapter:
    """Tests for tool format conversion."""

    def test_claude_tools_to_openai(self):
        """Test converting Claude tools to OpenAI format."""
        claude_tools = [
            {
                "name": "get_weather",
                "description": "Get weather for a location",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "City name"},
                    },
                    "required": ["location"],
                },
            }
        ]

        openai_tools = claude_tools_to_openai(claude_tools)

        assert len(openai_tools) == 1
        assert openai_tools[0]["type"] == "function"
        assert openai_tools[0]["function"]["name"] == "get_weather"
        assert openai_tools[0]["function"]["description"] == "Get weather for a location"
        assert openai_tools[0]["function"]["parameters"]["type"] == "object"

    def test_openai_tools_to_claude(self):
        """Test converting OpenAI tools to Claude format."""
        openai_tools = [
            {
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Get weather for a location",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "location": {"type": "string", "description": "City name"},
                        },
                        "required": ["location"],
                    },
                },
            }
        ]

        claude_tools = openai_tools_to_claude(openai_tools)

        assert len(claude_tools) == 1
        assert claude_tools[0]["name"] == "get_weather"
        assert claude_tools[0]["description"] == "Get weather for a location"
        assert claude_tools[0]["input_schema"]["type"] == "object"

    def test_normalize_tool_call_claude_format(self):
        """Test normalizing Claude tool call format."""
        tool_call = {
            "id": "call_123",
            "name": "get_weather",
            "input": {"location": "NYC"},
        }

        normalized = normalize_tool_call(tool_call, source_format="claude")

        assert normalized["id"] == "call_123"
        assert normalized["name"] == "get_weather"
        assert normalized["input"]["location"] == "NYC"

    def test_normalize_tool_call_openai_format(self):
        """Test normalizing OpenAI tool call format."""
        tool_call = {
            "id": "call_123",
            "function": {
                "name": "get_weather",
                "arguments": '{"location": "NYC"}',
            },
        }

        normalized = normalize_tool_call(tool_call, source_format="openai")

        assert normalized["id"] == "call_123"
        assert normalized["name"] == "get_weather"
        assert normalized["input"]["location"] == "NYC"

    def test_normalize_tool_call_auto_detect(self):
        """Test auto-detecting tool call format."""
        openai_call = {
            "id": "call_123",
            "function": {
                "name": "get_weather",
                "arguments": '{"location": "NYC"}',
            },
        }

        normalized = normalize_tool_call(openai_call)
        assert normalized["name"] == "get_weather"

        claude_call = {
            "id": "call_123",
            "name": "get_weather",
            "input": {"location": "NYC"},
        }

        normalized = normalize_tool_call(claude_call)
        assert normalized["name"] == "get_weather"


class TestMockProvider:
    """Tests for the mock provider itself."""

    def test_complete(self):
        """Test complete method."""
        provider = MockProvider()
        messages = [InferenceMessage(role="user", content="Hello")]
        response = provider.complete(messages)

        assert response.content == "Mock response"
        assert response.model == "mock-model"

    def test_stream(self):
        """Test stream method."""
        provider = MockProvider()
        messages = [InferenceMessage(role="user", content="Hello")]
        events = list(provider.stream(messages))

        assert len(events) == 3
        assert events[0].type == "text"
        assert events[0].text == "Mock "
        assert events[1].type == "text"
        assert events[1].text == "response"
        assert events[2].type == "message_stop"

    def test_supports_tools(self):
        """Test checking tool support."""
        provider = MockProvider()
        assert provider.supports_tools() is True

    def test_supports_streaming(self):
        """Test checking streaming support."""
        provider = MockProvider()
        assert provider.supports_streaming() is True

    def test_to_dict(self):
        """Test converting provider to dictionary."""
        provider = MockProvider("test")
        d = provider.to_dict()

        assert d["id"] == "test"
        assert d["display_name"] == "Mock test"
        assert d["is_available"] is True
        assert len(d["models"]) == 1
