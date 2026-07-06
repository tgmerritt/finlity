"""Tests for /api/v2/triggers/evaluate — one case per CONDITION_TYPES entry
(src/services/triggers.py), run against a client-supplied portfolio with no
DB involved.
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _portfolio():
    return {
        "accounts": [
            {
                "id": "acc-roth",
                "name": "Roth IRA",
                "account_type": "roth_ira",
                "positions": [
                    {"ticker": "VTI", "shares": 10, "current_price": 250.0, "sector": "Broad Market"},
                    {"ticker": "CASH", "shares": 1, "current_price": 500.0, "position_type": "cash"},
                ],
            },
            {
                "id": "acc-taxable",
                "name": "Taxable",
                "account_type": "taxable",
                "positions": [
                    {"ticker": "AAPL", "shares": 5, "current_price": 200.0, "sector": "Technology"},
                ],
            },
        ]
    }


def _evaluate(client, trigger: dict):
    resp = client.post(
        "/api/v2/triggers/evaluate",
        json={"triggers": [trigger], "portfolio": _portfolio()},
    )
    assert resp.status_code == 200
    results = resp.json()
    assert len(results) == 1
    return results[0]


class TestTriggerConditionTypes:
    def test_ticker_value(self, client):
        # VTI position value = 10 * 250 = 2500
        result = _evaluate(client, {
            "name": "t1", "condition_type": "ticker_value", "ticker": "VTI",
            "operator": ">", "threshold": 2000,
        })
        assert result["triggered"] is True
        assert result["current_value"] == pytest.approx(2500.0)

    def test_ticker_percent(self, client):
        # Total value = 2500 (VTI) + 500 (CASH) + 1000 (AAPL) = 4000
        # VTI % = 2500/4000 = 62.5%
        result = _evaluate(client, {
            "name": "t2", "condition_type": "ticker_percent", "ticker": "VTI",
            "operator": ">", "threshold": 50,
        })
        assert result["triggered"] is True
        assert result["current_value"] == pytest.approx(62.5)

    def test_sector_percent(self, client):
        # Technology sector = 1000 / 4000 = 25%
        result = _evaluate(client, {
            "name": "t3", "condition_type": "sector_percent", "sector": "Technology",
            "operator": "<", "threshold": 30,
        })
        assert result["triggered"] is True
        assert result["current_value"] == pytest.approx(25.0)

    def test_account_invested_percent(self, client):
        # Roth account: VTI 2500 + CASH 500 = 3000 total; invested (non-cash) = 2500
        # invested_pct = 2500/3000 = 83.33%
        result = _evaluate(client, {
            "name": "t4", "condition_type": "account_invested_percent",
            "account_type": "roth_ira", "operator": ">", "threshold": 80,
        })
        assert result["triggered"] is True
        assert result["current_value"] == pytest.approx(83.333, abs=0.01)

    def test_total_value(self, client):
        result = _evaluate(client, {
            "name": "t5", "condition_type": "total_value",
            "operator": ">=", "threshold": 4000,
        })
        assert result["triggered"] is True
        assert result["current_value"] == pytest.approx(4000.0)

    def test_account_value(self, client):
        # Taxable account value = 1000 (AAPL only)
        result = _evaluate(client, {
            "name": "t6", "condition_type": "account_value",
            "account_type": "taxable", "operator": "==", "threshold": 1000,
        })
        assert result["triggered"] is True
        assert result["current_value"] == pytest.approx(1000.0)

    def test_not_triggered_case(self, client):
        result = _evaluate(client, {
            "name": "t7", "condition_type": "total_value",
            "operator": ">", "threshold": 1_000_000,
        })
        assert result["triggered"] is False

    def test_multiple_triggers_in_one_request(self, client):
        resp = client.post(
            "/api/v2/triggers/evaluate",
            json={
                "triggers": [
                    {"name": "a", "condition_type": "total_value", "operator": ">", "threshold": 1},
                    {"name": "b", "condition_type": "total_value", "operator": "<", "threshold": 1},
                ],
                "portfolio": _portfolio(),
            },
        )
        assert resp.status_code == 200
        results = resp.json()
        assert len(results) == 2
        assert results[0]["triggered"] is True
        assert results[1]["triggered"] is False
