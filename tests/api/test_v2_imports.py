"""Tests for /api/v2/import/parse — file upload + optional accounts form
field for suggestion, no DB access, nothing persisted.
"""

import json

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


_POSITIONS_CSV = b"""Symbol,Description,Quantity,Price,Cost Basis
VTI,Vanguard Total Market,10,250.00,2000
AAPL,Apple Inc,5,200.00,500
"""


class TestImportParse:
    def test_parse_returns_positions(self, client):
        response = client.post(
            "/api/v2/import/parse",
            files={"file": ("schwab_export.csv", _POSITIONS_CSV, "text/csv")},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["row_count"] == 2
        tickers = {p["ticker"] for p in data["positions"]}
        assert tickers == {"VTI", "AAPL"}
        assert data["detected_brokerage"] == "schwab"

    def test_parse_with_accounts_suggests_by_name_match(self, client):
        accounts = json.dumps([
            {"id": "acc-1", "name": "schwab_export", "account_type": "taxable", "brokerage": "schwab"}
        ])
        response = client.post(
            "/api/v2/import/parse",
            files={"file": ("schwab_export.csv", _POSITIONS_CSV, "text/csv")},
            data={"accounts": accounts},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["suggested_account"] is not None
        assert data["suggested_account"]["id"] == "acc-1"

    def test_parse_invalid_extension_rejected(self, client):
        response = client.post(
            "/api/v2/import/parse",
            files={"file": ("notes.txt", b"hello", "text/plain")},
        )
        assert response.status_code == 400

    def test_parse_invalid_accounts_json_returns_400(self, client):
        response = client.post(
            "/api/v2/import/parse",
            files={"file": ("schwab_export.csv", _POSITIONS_CSV, "text/csv")},
            data={"accounts": "not valid json"},
        )
        assert response.status_code == 400


class TestImportParseSkippedRowWarnings:
    """F6 regression: rows where _extract_position returns None (e.g. a
    "--" placeholder quantity, matching a real Schwab/Fidelity export
    convention) used to vanish with no warning at all — only rows that
    RAISE produced a warning. The v2 parse endpoint must now surface a
    "N row(s) could not be parsed and were skipped" warning."""

    _CSV_WITH_UNPARSEABLE_ROW = b"""Symbol,Description,Quantity,Price,Cost Basis
VTI,Vanguard Total Market,10,250.00,2000
CASH,Cash Sweep,--,1.00,--
"""

    def test_none_returning_row_produces_a_warning(self, client):
        response = client.post(
            "/api/v2/import/parse",
            files={"file": ("schwab_export.csv", self._CSV_WITH_UNPARSEABLE_ROW, "text/csv")},
        )
        assert response.status_code == 200
        data = response.json()

        # The good row still parses...
        assert data["row_count"] == 1
        assert data["positions"][0]["ticker"] == "VTI"

        # ...and the silently-skipped row is now surfaced as a warning.
        assert any("could not be parsed and were skipped" in w for w in data["warnings"])

    def test_warnings_truncated_with_count_message_beyond_five(self, client, monkeypatch):
        """More than 5 total warnings: first 5 kept, plus a summary entry —
        not the old blunt warnings[:5] that silently drops the rest.

        Forces 7 rows to raise (rather than relying on real parsing
        quirks to distinguish "raises" from "returns None") by
        monkeypatching FolderScanner._extract_position deterministically:
        the first row parses fine, the next 7 raise ValueError each
        producing their own per-row warning (>5 total), and the endpoint's
        truncation logic must append a "...and N more warnings" entry
        instead of silently dropping them.
        """
        from src.importers.folder_scanner import FolderScanner

        call_count = {"n": 0}
        real_extract = FolderScanner._extract_position

        def _fake_extract(self, row, column_map):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return real_extract(self, row, column_map)
            raise ValueError(f"synthetic parse failure #{call_count['n']}")

        monkeypatch.setattr(FolderScanner, "_extract_position", _fake_extract)

        header = "Symbol,Description,Quantity,Price,Cost Basis\n"
        rows = "".join(f"TICK{i},Name {i},10,100.00,900\n" for i in range(8))
        csv_bytes = (header + rows).encode()

        response = client.post(
            "/api/v2/import/parse",
            files={"file": ("export.csv", csv_bytes, "text/csv")},
        )
        assert response.status_code == 200
        data = response.json()

        # Only the first row (unpatched call) parses successfully.
        assert data["row_count"] == 1

        # 7 raising rows -> 7 per-row warnings, truncated to 5 + a summary
        # entry (not silently dropped).
        assert len(data["warnings"]) == 6
        assert "...and 2 more warnings" == data["warnings"][-1]
