"""Tests for /api/v2/bank-statements/parse — CSV fixture, no DB writes,
no dedup-by-hash (client's responsibility in v2).
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


# Recurring detection only counts positive amounts (matches v1's
# _detect_recurring filter), so this fixture uses credit-style positive
# amounts for the recurring merchant.
_CSV_FIXTURE = b"""Date,Description,Amount
01/01/2026,ACME SUBSCRIPTION 111111,9.99
02/01/2026,ACME SUBSCRIPTION 222222,9.99
03/01/2026,ACME SUBSCRIPTION 333333,9.99
01/05/2026,ONE OFF PURCHASE,45.00
"""


class TestBankStatementsParse:
    def test_parse_returns_imports_and_candidates(self, client):
        response = client.post(
            "/api/v2/bank-statements/parse",
            files={"files": ("statement.csv", _CSV_FIXTURE, "text/csv")},
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["imports"]) == 1
        assert data["imports"][0]["file_name"] == "statement.csv"
        assert data["imports"][0]["row_count"] == 4
        assert "content_hash" in data["imports"][0]

        assert len(data["candidates"]) == 1
        candidate = data["candidates"][0]
        assert candidate["name"] == "Acme Subscription"
        assert candidate["amount"] == pytest.approx(9.99)
        assert candidate["occurrences"] == 3

    def test_parse_no_files_returns_400(self, client):
        response = client.post("/api/v2/bank-statements/parse", files={})
        assert response.status_code in (400, 422)

    def test_parse_multiple_files_combines_detection(self, client):
        """Recurring detection runs across all uploaded files combined."""
        file_a = b"Date,Description,Amount\n01/01/2026,GYM MEMBERSHIP,29.99\n"
        file_b = b"Date,Description,Amount\n02/01/2026,GYM MEMBERSHIP,29.99\n"
        file_c = b"Date,Description,Amount\n03/01/2026,GYM MEMBERSHIP,29.99\n"
        response = client.post(
            "/api/v2/bank-statements/parse",
            files=[
                ("files", ("a.csv", file_a, "text/csv")),
                ("files", ("b.csv", file_b, "text/csv")),
                ("files", ("c.csv", file_c, "text/csv")),
            ],
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data["imports"]) == 3
        assert any(c["name"] == "Gym Membership" for c in data["candidates"])
