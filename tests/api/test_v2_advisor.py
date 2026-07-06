"""Tests for /api/v2/analysis/advisor/* — no-network checks only.

Exercises the request model, payload_to_advisor_portfolio_context adapter,
and the "no env key" gating end-to-end without ever calling a real AI
provider. ANTHROPIC_API_KEY is explicitly deleted from the environment for
these tests so a key present on the developer's machine can't make them
flaky (and can't accidentally spend money on a real API call).
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _portfolio_payload():
    return {
        "accounts": [
            {
                "name": "Taxable",
                "account_type": "taxable",
                "positions": [{"ticker": "VTI", "shares": 10, "current_price": 250.0}],
            }
        ]
    }


class TestAdvisorAnalyzeNoKey:
    def test_analyze_returns_400_without_env_key(self, client, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        response = client.post(
            "/api/v2/analysis/advisor/analyze",
            json={
                "portfolio": _portfolio_payload(),
                "ticker": "VTI",
            },
        )
        assert response.status_code == 400
        assert "ANTHROPIC_API_KEY" in response.json()["detail"]


class TestAdvisorChatNoKey:
    def test_chat_returns_200_with_message_without_env_key(self, client, monkeypatch):
        """Unlike /advisor/analyze, /advisor/chat mirrors v1's chat endpoint
        behavior: it returns 200 with an explanatory message rather than a
        400, so the frontend's chat UI (which expects a ChatResponse shape,
        not an error page) keeps working unchanged. This is an intentional
        deviation from the plan's literal "if no env key, return 400" for
        the chat endpoints specifically — see workstream report."""
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        response = client.post(
            "/api/v2/analysis/advisor/chat",
            json={
                "portfolio": _portfolio_payload(),
                "message": "Should I buy more VTI?",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert "ANTHROPIC_API_KEY" in data["response"]
        assert data["history"] == []

    def test_chat_stream_v2_returns_sse_message_without_env_key(self, client, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        response = client.post(
            "/api/v2/analysis/advisor/chat/stream/v2",
            json={
                "portfolio": _portfolio_payload(),
                "message": "Should I buy more VTI?",
            },
        )
        assert response.status_code == 200
        assert "ANTHROPIC_API_KEY" in response.text
        assert "data: [DONE]" in response.text
