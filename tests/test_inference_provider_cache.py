"""Tests for Anthropic prompt caching wiring in ClaudeProvider.

The provider gained two opt-in keyword arguments — `cache_system` and
`cache_breakpoints` — that translate Anthropic's `cache_control` markers onto
the `system` and `messages` request fields. These tests pin the exact kwargs
sent to the Anthropic SDK and the response/stream metric capture.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

from src.services.providers.base import InferenceMessage
from src.services.providers.claude_provider import ClaudeProvider


def _fake_response(
    *,
    text: str = "ok",
    cache_creation_input_tokens=None,
    cache_read_input_tokens=None,
):
    """Build a minimal stand-in for an anthropic.types.Message."""
    usage_kwargs = {"input_tokens": 100, "output_tokens": 10}
    if cache_creation_input_tokens is not None:
        usage_kwargs["cache_creation_input_tokens"] = cache_creation_input_tokens
    if cache_read_input_tokens is not None:
        usage_kwargs["cache_read_input_tokens"] = cache_read_input_tokens
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        model="claude-sonnet-4-6",
        usage=SimpleNamespace(**usage_kwargs),
        stop_reason="end_turn",
    )


def _make_provider_with_mock_client(response=None) -> tuple[ClaudeProvider, MagicMock]:
    provider = ClaudeProvider()
    client = MagicMock()
    client.messages.create.return_value = response or _fake_response()
    # Bypass the SDK construction path entirely.
    provider._client = client
    return provider, client


class TestClaudeProviderCacheSystem:
    """Verify the `cache_system` flag toggles cache_control on the system block."""

    def test_cache_system_true_wraps_string_in_ephemeral_block(self):
        provider, client = _make_provider_with_mock_client()
        provider.complete(
            messages=[InferenceMessage(role="user", content="Hi")],
            system="You are helpful.",
            cache_system=True,
        )

        kwargs = client.messages.create.call_args.kwargs
        assert kwargs["system"] == [
            {
                "type": "text",
                "text": "You are helpful.",
                "cache_control": {"type": "ephemeral"},
            }
        ]

    def test_cache_system_false_keeps_plain_string(self):
        """Default off: existing callers should see no behavior change."""
        provider, client = _make_provider_with_mock_client()
        provider.complete(
            messages=[InferenceMessage(role="user", content="Hi")],
            system="You are helpful.",
        )

        kwargs = client.messages.create.call_args.kwargs
        assert kwargs["system"] == "You are helpful."
        # And nothing else carries cache_control either.
        assert all(
            "cache_control" not in m for m in kwargs["messages"]
            if isinstance(m.get("content"), dict)
        )

    def test_omitted_system_stays_omitted(self):
        provider, client = _make_provider_with_mock_client()
        provider.complete(
            messages=[InferenceMessage(role="user", content="Hi")],
        )

        kwargs = client.messages.create.call_args.kwargs
        assert "system" not in kwargs

    def test_caller_supplied_list_system_is_passed_through(self):
        provider, client = _make_provider_with_mock_client()
        custom_system = [
            {"type": "text", "text": "frozen prefix", "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": "trailer"},
        ]
        provider.complete(
            messages=[InferenceMessage(role="user", content="Hi")],
            system=custom_system,
            cache_system=True,
        )

        kwargs = client.messages.create.call_args.kwargs
        # Caller-built list takes precedence over wrapping logic.
        assert kwargs["system"] == custom_system


class TestClaudeProviderCacheBreakpoints:
    """Verify message-level cache_breakpoints attach to the right block."""

    def test_breakpoint_wraps_string_content(self):
        provider, client = _make_provider_with_mock_client()
        provider.complete(
            messages=[
                InferenceMessage(role="user", content="turn-1 user"),
                InferenceMessage(role="assistant", content="turn-1 bot"),
                InferenceMessage(role="user", content="turn-2 user"),
            ],
            cache_breakpoints=[0],
        )

        msgs = client.messages.create.call_args.kwargs["messages"]
        assert msgs[0]["content"] == [
            {
                "type": "text",
                "text": "turn-1 user",
                "cache_control": {"type": "ephemeral"},
            }
        ]
        # Other messages untouched.
        assert msgs[1]["content"] == "turn-1 bot"
        assert msgs[2]["content"] == "turn-2 user"

    def test_no_breakpoints_means_no_cache_markers_in_messages(self):
        provider, client = _make_provider_with_mock_client()
        provider.complete(
            messages=[InferenceMessage(role="user", content="Hi")],
        )

        msgs = client.messages.create.call_args.kwargs["messages"]
        assert msgs == [{"role": "user", "content": "Hi"}]


class TestClaudeProviderCacheMetrics:
    """Verify cache token metrics flow back through InferenceResponse."""

    def test_usage_with_cache_fields_propagates_to_response(self):
        provider, _ = _make_provider_with_mock_client(
            response=_fake_response(
                cache_creation_input_tokens=1234,
                cache_read_input_tokens=5678,
            ),
        )
        response = provider.complete(
            messages=[InferenceMessage(role="user", content="Hi")],
            system="big system prompt",
            cache_system=True,
        )

        assert response.cache_creation_input_tokens == 1234
        assert response.cache_read_input_tokens == 5678

    def test_usage_without_cache_fields_yields_none(self):
        """Older mock responses without cache_* fields should not crash."""
        provider, _ = _make_provider_with_mock_client(response=_fake_response())
        response = provider.complete(
            messages=[InferenceMessage(role="user", content="Hi")],
        )

        assert response.cache_creation_input_tokens is None
        assert response.cache_read_input_tokens is None


class TestClaudeProviderCacheLogging:
    """Verify the cache log line fires only when caching is in effect."""

    def test_log_emitted_when_cache_system_true(self, caplog):
        provider, _ = _make_provider_with_mock_client(
            response=_fake_response(
                cache_creation_input_tokens=1500,
                cache_read_input_tokens=0,
            ),
        )
        with caplog.at_level("INFO", logger="src.services.providers.claude_provider"):
            provider.complete(
                messages=[InferenceMessage(role="user", content="Hi")],
                system="big system prompt",
                cache_system=True,
            )

        assert any("Claude cache" in r.message for r in caplog.records)

    def test_no_log_when_caching_disabled(self, caplog):
        provider, _ = _make_provider_with_mock_client(response=_fake_response())
        with caplog.at_level("INFO", logger="src.services.providers.claude_provider"):
            provider.complete(
                messages=[InferenceMessage(role="user", content="Hi")],
                system="big system prompt",
            )

        assert not any("Claude cache" in r.message for r in caplog.records)
