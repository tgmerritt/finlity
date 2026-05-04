"""
Tests for the Vanguard CSV importer plugin.

These tests use synthetic CSV bytes written to ``tmp_path`` and exercise
both detection (``can_handle``) and import (``import_file``) paths for
the brokerage and legacy mutual-fund Vanguard exports.
"""

import importlib.util
from pathlib import Path

import pytest

from src.plugins.base import (
    DatabaseAccess,
    FileFormat,
    PluginManifest,
    PluginPermissions,
    PluginType,
)


# ---- module loading ---------------------------------------------------------

# The plugin lives in a directory whose name contains a hyphen, so a
# normal `import` would not work. Mirror what the registry does and
# load the module by file path.
PLUGIN_DIR = (
    Path(__file__).parent.parent
    / "src" / "plugins" / "builtin" / "vanguard-csv"
)
_SPEC = importlib.util.spec_from_file_location(
    "vanguard_csv_importer_under_test", PLUGIN_DIR / "importer.py"
)
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
VanguardCSVImporter = _MODULE.VanguardCSVImporter
VANGUARD_MONEY_MARKET_SYMBOLS = _MODULE.VANGUARD_MONEY_MARKET_SYMBOLS


# ---- fixtures ---------------------------------------------------------------


def _make_manifest() -> PluginManifest:
    """Build a minimal manifest the importer needs to instantiate."""
    return PluginManifest(
        name="Vanguard CSV Importer",
        version="1.0.0",
        description="Test instance",
        author="Tests",
        license="MIT",
        plugin_type=PluginType.IMPORTER,
        main="importer.py",
        entry_class="VanguardCSVImporter",
        permissions=PluginPermissions(
            file_read=True,
            file_write=False,
            network=False,
            database=DatabaseAccess.READ_ONLY,
        ),
        supported_formats=[
            FileFormat(extension=".csv", mime_type="text/csv", description="Vanguard CSV"),
        ],
        plugin_id="vanguard-csv",
        plugin_path=PLUGIN_DIR,
        is_builtin=True,
    )


@pytest.fixture
def importer() -> VanguardCSVImporter:
    return VanguardCSVImporter(_make_manifest(), {})


def _write_csv(tmp_path: Path, name: str, content: str) -> Path:
    p = tmp_path / name
    p.write_text(content, encoding="utf-8")
    return p


# ---- can_handle: detection --------------------------------------------------


class TestCanHandle:
    """Detection / confidence scoring."""

    def test_brokerage_format_high_confidence(self, importer, tmp_path):
        csv_text = (
            "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,Holding Type\n"
            "12345678,Vanguard Total Stock Market ETF,VTI,100,220.55,22055.00,ETF\n"
            "12345678,Vanguard Federal Money Market,VMFXX,5000,1.00,5000.00,Mutual Fund\n"
        )
        path = _write_csv(tmp_path, "brokerage.csv", csv_text)
        score = importer.can_handle(path, csv_text.encode("utf-8"))
        assert score >= 0.85, f"expected >=0.85, got {score}"

    def test_legacy_mutual_fund_format_high_confidence(self, importer, tmp_path):
        csv_text = (
            "Fund Account Number,Fund Name,Fund Number,Symbol,Shares,Price,Total Value\n"
            "98765432,Vanguard 500 Index Admiral,0540,VFIAX,250,475.30,118825.00\n"
            "98765432,Vanguard Total Bond Market Admiral,0584,VBTLX,1000,9.80,9800.00\n"
        )
        path = _write_csv(tmp_path, "OFXDownload.csv", csv_text)
        score = importer.can_handle(path, csv_text.encode("utf-8"))
        assert score >= 0.85, f"expected >=0.85, got {score}"

    def test_filename_ofxdownload_boosts_confidence(self, importer, tmp_path):
        # Even with weaker headers, OFXDownload.csv name + a known ticker
        # should clear the generic-csv threshold of 0.4.
        csv_text = "Symbol,Shares,Price\nVFIAX,100,475.30\n"
        path = _write_csv(tmp_path, "OFXDownload.csv", csv_text)
        score = importer.can_handle(path, csv_text.encode("utf-8"))
        assert score > 0.4

    def test_non_csv_extension_returns_zero(self, importer, tmp_path):
        path = tmp_path / "vanguard.xlsx"
        path.write_bytes(b"not a csv")
        assert importer.can_handle(path, b"Investment Name,Share Price\nVTI,100\n") == 0.0

    def test_schwab_file_is_rejected(self, importer, tmp_path):
        # A Schwab file mentioning Vanguard funds should NOT be claimed.
        csv_text = (
            '"Positions for account 1234-5678 as of 12:00 PM ET, 2024/01/01"\n'
            "\n"
            "Symbol,Description,Quantity,Price\n"
            "VTI,Vanguard Total Stock Market ETF,100,220.55\n"
        )
        path = _write_csv(tmp_path, "schwab.csv", csv_text)
        score = importer.can_handle(path, csv_text.encode("utf-8"))
        assert score == 0.0

    def test_malformed_file_low_confidence(self, importer, tmp_path):
        csv_text = "foo,bar,baz\n1,2,3\n"
        path = _write_csv(tmp_path, "junk.csv", csv_text)
        score = importer.can_handle(path, csv_text.encode("utf-8"))
        # Below the generic-csv 0.4 threshold so generic wins.
        assert score < 0.5

    def test_empty_preview_returns_zero(self, importer, tmp_path):
        path = tmp_path / "empty.csv"
        path.write_bytes(b"")
        assert importer.can_handle(path, b"") == 0.0


# ---- import_file: brokerage format ------------------------------------------


class TestImportBrokerageFormat:
    def test_imports_positions_and_skips_money_market(self, importer, tmp_path):
        csv_text = (
            "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,Holding Type\n"
            "12345678,Vanguard Total Stock Market ETF,VTI,100,220.55,22055.00,ETF\n"
            "12345678,Vanguard Total Stock Market Index Admiral,VTSAX,50,125.40,6270.00,Mutual Fund\n"
            "12345678,Vanguard Federal Money Market,VMFXX,5000,1.00,5000.00,Mutual Fund\n"
            "12345678,Total,,,,33325.00,\n"
        )
        path = _write_csv(tmp_path, "brokerage.csv", csv_text)
        result = importer.import_file(path, "taxable")

        assert result.success
        # VMFXX skipped, Total summary row dropped.
        tickers = sorted(p["ticker"] for p in result.positions)
        assert tickers == ["VTI", "VTSAX"]

        vti = next(p for p in result.positions if p["ticker"] == "VTI")
        assert vti["shares"] == 100.0
        assert vti["price"] == 220.55
        assert vti["name"] == "Vanguard Total Stock Market ETF"
        assert vti["is_fund"] is True
        assert vti["cost_basis"] is None  # not in standard Vanguard export

        # Account name derived from Account Number column.
        assert result.account_name == "Vanguard 12345678"

        # Money-market skip is reported as a warning.
        assert any("money-market" in w for w in result.warnings)

    def test_holding_type_drives_is_fund(self, importer, tmp_path):
        csv_text = (
            "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,Holding Type\n"
            "11111111,Apple Inc,AAPL,10,180.00,1800.00,Stock\n"
            "11111111,Vanguard S&P 500 ETF,VOO,5,440.00,2200.00,ETF\n"
        )
        path = _write_csv(tmp_path, "broker_mixed.csv", csv_text)
        result = importer.import_file(path, "taxable")

        aapl = next(p for p in result.positions if p["ticker"] == "AAPL")
        voo = next(p for p in result.positions if p["ticker"] == "VOO")
        assert aapl["is_fund"] is False
        assert voo["is_fund"] is True


# ---- import_file: legacy mutual-fund format ---------------------------------


class TestImportMutualFundFormat:
    def test_imports_legacy_format(self, importer, tmp_path):
        csv_text = (
            "Fund Account Number,Fund Name,Fund Number,Symbol,Shares,Price,Total Value\n"
            "98765432,Vanguard 500 Index Admiral,0540,VFIAX,250,475.30,118825.00\n"
            "98765432,Vanguard Total Bond Market Admiral,0584,VBTLX,1000,9.80,9800.00\n"
        )
        path = _write_csv(tmp_path, "OFXDownload.csv", csv_text)
        result = importer.import_file(path, "roth_ira")

        assert result.success
        tickers = sorted(p["ticker"] for p in result.positions)
        assert tickers == ["VBTLX", "VFIAX"]  # alphabetical
        vfiax = next(p for p in result.positions if p["ticker"] == "VFIAX")
        assert vfiax["shares"] == 250.0
        assert vfiax["price"] == 475.30
        assert vfiax["is_fund"] is True
        assert result.account_name == "Vanguard 98765432"


# ---- edge cases -------------------------------------------------------------


class TestEdgeCases:
    def test_empty_file_returns_no_positions(self, importer, tmp_path):
        path = _write_csv(tmp_path, "empty.csv", "")
        result = importer.import_file(path, "taxable")
        assert result.success
        assert result.positions == []

    def test_malformed_missing_required_columns(self, importer, tmp_path):
        # No Symbol/Fund Number column at all.
        csv_text = "Investment Name,Notes\nVanguard Fund,foo\n"
        path = _write_csv(tmp_path, "broken.csv", csv_text)
        result = importer.import_file(path, "taxable")
        assert result.success is False
        assert "Symbol" in result.message or "Fund Number" in result.message

    def test_skips_blank_and_summary_rows(self, importer, tmp_path):
        csv_text = (
            "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value\n"
            "12345678,Vanguard Total Stock Market ETF,VTI,100,220.55,22055.00\n"
            ",,,,,\n"
            ",Total,,,,22055.00\n"
        )
        path = _write_csv(tmp_path, "with_summary.csv", csv_text)
        result = importer.import_file(path, "taxable")
        assert result.success
        assert len(result.positions) == 1
        assert result.positions[0]["ticker"] == "VTI"

    def test_currency_formatting_is_parsed(self, importer, tmp_path):
        csv_text = (
            "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value\n"
            "12345678,Vanguard ETF,VTI,\"1,250.50\",\"$220.55\",\"$275,838.78\"\n"
        )
        path = _write_csv(tmp_path, "currency.csv", csv_text)
        result = importer.import_file(path, "taxable")
        assert result.success
        assert result.positions[0]["shares"] == 1250.50
        assert result.positions[0]["price"] == 220.55

    def test_account_type_used_when_no_account_number(self, importer, tmp_path):
        csv_text = (
            "Account Type,Investment Name,Symbol,Shares,Share Price,Total Value\n"
            "Roth IRA,Vanguard ETF,VTI,100,220.55,22055.00\n"
        )
        path = _write_csv(tmp_path, "no_acct_num.csv", csv_text)
        result = importer.import_file(path, "roth_ira")
        assert result.success
        assert result.account_name == "Vanguard Roth IRA"

    def test_cost_basis_absent_does_not_error(self, importer, tmp_path):
        csv_text = (
            "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value\n"
            "12345678,Vanguard ETF,VTI,100,220.55,22055.00\n"
        )
        path = _write_csv(tmp_path, "no_cost.csv", csv_text)
        result = importer.import_file(path, "taxable")
        assert result.success
        assert result.positions[0]["cost_basis"] is None


# ---- date parsing -----------------------------------------------------------


class TestDateParsing:
    @pytest.mark.parametrize(
        "raw,year",
        [
            ("01/15/2024", 2024),
            ("12/31/24", 2024),
            ("2024-01-15", 2024),
            ("01-15-2024", 2024),
        ],
    )
    def test_parses_common_formats(self, raw, year):
        parsed = VanguardCSVImporter._parse_date(raw)
        assert parsed is not None
        assert parsed.year == year

    def test_invalid_returns_none(self):
        assert VanguardCSVImporter._parse_date("not a date") is None
        assert VanguardCSVImporter._parse_date("") is None
        assert VanguardCSVImporter._parse_date(None) is None


# ---- skip-list integration --------------------------------------------------


class TestSkipListIntegration:
    """Verify the price-service skip list contains all Vanguard MM tickers."""

    def test_money_market_in_price_skip_list(self):
        from src.data.prices import PriceService

        for ticker in VANGUARD_MONEY_MARKET_SYMBOLS:
            assert ticker in PriceService.SKIP_PRICE_LOOKUP, (
                f"{ticker} should be in SKIP_PRICE_LOOKUP"
            )
