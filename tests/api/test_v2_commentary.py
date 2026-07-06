"""Tests for POST /api/v2/commentary/{element_id}/stream — no-network checks
only (mirrors tests/api/test_v2_advisor.py's approach). ANTHROPIC_API_KEY is
explicitly deleted from the environment for the no-key tests so a key
present on the developer's machine can't make them flaky or accidentally
spend money on a real API call.
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


class TestCommentaryStreamNoKey:
    def test_returns_error_event_without_env_key(self, client, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        response = client.post(
            "/api/v2/commentary/dashboard.total_value/stream",
            json={"data": {"total_value": 100000}},
        )
        assert response.status_code == 200
        assert "ANTHROPIC_API_KEY" in response.text
        assert '"error"' in response.text


class TestCommentaryStreamUnknownElement:
    def test_unknown_element_returns_404(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-not-used")

        response = client.post(
            "/api/v2/commentary/not.a.real.element/stream",
            json={"data": {}},
        )
        assert response.status_code == 404


class TestCommentaryStreamNeverTouchesServerDB:
    """F2 regression: v1's GET /api/commentary/{id}/stream reads user
    age/retirement age and the AI provider config from the server DB even
    when no_store=true is passed (get_user_age/get_retirement_age go
    through src.api.settings -> get_database() unconditionally, and
    CommentaryService._get_provider() always calls get_provider(db) when a
    db is present). The v2 endpoint must construct CommentaryService with
    db=None and never call src.api.settings.get_database at all."""

    def test_stream_never_touches_server_db(self, client, monkeypatch):
        def _boom() -> None:
            raise AssertionError("v2 commentary stream must not call src.api.settings.get_database")

        monkeypatch.setattr("src.api.settings.get_database", _boom)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-not-used")

        # Also stub the provider so we never make a real network call —
        # ClaudeProvider.stream()/.complete() would otherwise hit the real
        # Anthropic API with a fake key.
        from src.services.providers.claude_provider import ClaudeProvider
        from src.services.providers.base import InferenceResponse, StreamEvent

        def _fake_stream(self, *args, **kwargs):
            yield StreamEvent(type="text", text="Stubbed commentary.")

        def _fake_complete(self, *args, **kwargs):
            return InferenceResponse(content="stubbed web search result", model="stub")

        monkeypatch.setattr(ClaudeProvider, "stream", _fake_stream)
        monkeypatch.setattr(ClaudeProvider, "complete", _fake_complete)

        # dashboard.total_value is the realistic frontend path: it DOES have
        # web_search_queries configured, so this exercises
        # _perform_web_searches (-> _get_provider() -> provider.complete())
        # in addition to the main streaming call — not just the DB-touch-free
        # elements, per the more representative code path a real caller hits.
        response = client.post(
            "/api/v2/commentary/dashboard.total_value/stream",
            json={
                "data": {"total_value": 100000},
                "user_context": {"age": 40, "retirement_age": 60},
            },
        )
        assert response.status_code == 200
        # If get_database() had been called, the monkeypatched _boom would
        # have raised inside the generator and the SSE body would carry an
        # "error" event instead of a "chunk"/"complete" one.
        assert '"error"' not in response.text
        assert "Stubbed commentary" in response.text

    def test_no_user_context_omits_age_from_prompt_inputs(self, client, monkeypatch):
        """When user_context is absent, no age/retirement_age default is
        substituted (unlike v1's DB-backed 35/65 defaults) — verified at the
        CommentaryService unit level via _get_user_context()."""
        from src.services.commentary_service import CommentaryService

        service = CommentaryService(db=None, claude_api_key="fake-key")
        context = service._get_user_context()
        assert "user_age" not in context
        assert "retirement_age" not in context

    def test_user_context_with_age_is_reflected(self):
        from src.services.commentary_service import CommentaryService

        service = CommentaryService(
            db=None, claude_api_key="fake-key", user_context={"age": 42, "retirement_age": 62}
        )
        context = service._get_user_context()
        assert context["user_age"] == 42
        assert context["retirement_age"] == 62
