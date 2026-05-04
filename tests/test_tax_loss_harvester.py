"""Tests for the lot-aware tax-loss harvester analyzer.

Covers:
  - Lot-level enumeration with mixed ST/LT/winning/loss lots.
  - Wash-sale risk detection (replacement buy in another taxable account =
    blocked; IRA holding = potential per Rev. Rul. 2008-5).
  - Retirement-account harvest target is excluded.
  - Backward-compat: a position with no ``lots`` falls back to a synthetic
    single-lot view using legacy Position-level fields.
  - Edge case: lot with no purchase_date is skipped with a logged note.
  - Ranking: clean wash-sale > risky wash-sale, ties broken by dollar loss
    then by ST-first.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from src.plugins.base import PluginManifest, PluginType
from src.plugins.builtin import __file__ as _builtin_pkg  # noqa: F401  (ensure package importable)


def _make_analyzer(settings: dict | None = None):
    """Instantiate the TaxLossHarvester directly with a stub manifest."""
    # Direct module-path import (the plugin folder is hyphenated, so we go
    # through importlib to avoid relying on plugin auto-discovery).
    import importlib.util
    from pathlib import Path

    here = Path(__file__).resolve().parents[1]
    src = here / "src" / "plugins" / "builtin" / "tax-loss-harvester" / "analyzer.py"
    spec = importlib.util.spec_from_file_location("tax_loss_harvester_under_test", src)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    manifest = PluginManifest(
        name="Tax-Loss Harvester",
        version="2.0.0",
        description="test",
        author="test",
        license="MIT",
        plugin_type=PluginType.ANALYSIS,
        main="analyzer.py",
        entry_class="TaxLossHarvester",
    )
    return mod.TaxLossHarvester(manifest, settings or {})


# ---------------------------------------------------------------------------
# Fixtures: a small synthetic portfolio
# ---------------------------------------------------------------------------

NOW = datetime.utcnow()


def _accounts(realized_sales: list[dict] | None = None) -> list[dict]:
    return [
        {
            "id": "acct-tax",
            "name": "Taxable Brokerage",
            "account_type": "taxable",
            "is_retirement": False,
            "realized_sales": realized_sales or [],
        },
        {
            "id": "acct-tax-2",
            "name": "Taxable #2",
            "account_type": "taxable",
            "is_retirement": False,
        },
        {
            "id": "acct-roth",
            "name": "Roth IRA",
            "account_type": "roth_ira",
            "is_retirement": True,
        },
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_lot_level_st_lt_winning_and_retirement_excluded():
    analyzer = _make_analyzer({"min_loss_threshold": 50, "tax_rate": 24})

    positions = [
        # AAPL: two lots in same taxable account.
        # - ST losing lot (30d old, big loss)
        # - LT losing lot (500d old, smaller loss)
        # - LT winning lot (excluded)
        {
            "ticker": "AAPL",
            "name": "Apple",
            "account_id": "acct-tax",
            "current_price": 100.0,
            "shares": 30,           # ignored when lots present
            "cost_basis": 0,
            "lots": [
                {
                    "id": "lot-aapl-st",
                    "purchase_date": NOW - timedelta(days=30),
                    "shares": 10,
                    "cost_basis": 1500.0,   # current=1000 -> -500 ST
                },
                {
                    "id": "lot-aapl-lt",
                    "purchase_date": NOW - timedelta(days=500),
                    "shares": 10,
                    "cost_basis": 1300.0,   # current=1000 -> -300 LT
                },
                {
                    "id": "lot-aapl-win",
                    "purchase_date": NOW - timedelta(days=400),
                    "shares": 10,
                    "cost_basis": 800.0,    # current=1000 -> +200 (excluded)
                },
            ],
        },
        # AAPL also held in Roth — would be a harvest target except the
        # account is retirement (no taxable benefit).
        {
            "ticker": "AAPL",
            "name": "Apple",
            "account_id": "acct-roth",
            "current_price": 100.0,
            "shares": 5,
            "cost_basis": 1000.0,
            "lots": [
                {
                    "id": "lot-aapl-roth",
                    "purchase_date": NOW - timedelta(days=200),
                    "shares": 5,
                    "cost_basis": 1000.0,   # current=500 -> would be -500 LT
                },
            ],
        },
    ]

    result = analyzer.analyze(positions, _accounts())
    assert result.success
    recs = result.metrics["recommendations"]

    # Two losing taxable lots; the winner and the Roth lot are excluded.
    assert len(recs) == 2
    tickers_lots = {(r["ticker"], r["lot_id"]) for r in recs}
    assert tickers_lots == {("AAPL", "lot-aapl-st"), ("AAPL", "lot-aapl-lt")}

    by_lot = {r["lot_id"]: r for r in recs}
    assert by_lot["lot-aapl-st"]["is_short_term"] is True
    assert by_lot["lot-aapl-lt"]["is_short_term"] is False
    # Signed gain/loss is negative; legacy positive magnitude preserved.
    assert by_lot["lot-aapl-st"]["unrealized_gain_loss"] == pytest.approx(-500.0)
    assert by_lot["lot-aapl-st"]["unrealized_loss"] == pytest.approx(500.0)
    # ST tax savings = 500 * 0.24 = 120 (tax_rate setting in %)
    assert by_lot["lot-aapl-st"]["estimated_tax_savings"] == pytest.approx(120.0)
    # LT savings = 300 * 0.15 = 45
    assert by_lot["lot-aapl-lt"]["estimated_tax_savings"] == pytest.approx(45.0)


def test_wash_sale_blocked_by_other_taxable_account_purchase():
    analyzer = _make_analyzer({"min_loss_threshold": 50})

    positions = [
        # MSFT loss in account #1 (50 days old → LT? no, that's < 365)
        {
            "ticker": "MSFT",
            "account_id": "acct-tax",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-msft-loss",
                "purchase_date": NOW - timedelta(days=200),
                "shares": 10,
                "cost_basis": 1500.0,   # current=1000 -> -500
            }],
        },
        # MSFT recently bought in another taxable account (within 30 days).
        {
            "ticker": "MSFT",
            "account_id": "acct-tax-2",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-msft-replace",
                "purchase_date": NOW - timedelta(days=10),
                "shares": 5,
                "cost_basis": 510.0,
            }],
        },
    ]

    result = analyzer.analyze(positions, _accounts())
    assert result.success

    # The replacement lot itself isn't a loss (it's at-cost), so the only
    # recommendation is the loss lot, flagged blocked.
    recs = [r for r in result.metrics["recommendations"] if r["lot_id"] == "lot-msft-loss"]
    assert len(recs) == 1
    assert recs[0]["wash_sale_risk"] == "blocked"
    assert "another taxable account" in (recs[0]["wash_sale_reason"] or "")


def test_wash_sale_potential_via_ira_holding():
    """Per IRS Rev. Rul. 2008-5, a replacement buy in an IRA still triggers
    the wash-sale rule — surfaced as 'potential' (not 'blocked')."""
    analyzer = _make_analyzer({"min_loss_threshold": 50})

    positions = [
        {
            "ticker": "TSLA",
            "account_id": "acct-tax",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-tsla-loss",
                "purchase_date": NOW - timedelta(days=400),
                "shares": 10,
                "cost_basis": 1500.0,  # -500 LT
            }],
        },
        # Recently bought TSLA in Roth IRA.
        {
            "ticker": "TSLA",
            "account_id": "acct-roth",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-tsla-roth-recent",
                "purchase_date": NOW - timedelta(days=15),
                "shares": 2,
                "cost_basis": 200.0,
            }],
        },
    ]

    result = analyzer.analyze(positions, _accounts())
    recs = [r for r in result.metrics["recommendations"] if r["ticker"] == "TSLA"]
    assert len(recs) == 1
    assert recs[0]["wash_sale_risk"] == "potential"
    assert "Rev. Rul. 2008-5" in (recs[0]["wash_sale_reason"] or "")


def test_wash_sale_potential_via_recent_realized_sale():
    analyzer = _make_analyzer({"min_loss_threshold": 50})

    positions = [
        {
            "ticker": "GOOG",
            "account_id": "acct-tax",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-goog-loss",
                "purchase_date": NOW - timedelta(days=400),
                "shares": 10,
                "cost_basis": 1500.0,
            }],
        },
    ]
    sales = [{
        "ticker": "GOOG",
        "sale_date": NOW - timedelta(days=20),
    }]
    result = analyzer.analyze(positions, _accounts(realized_sales=sales))
    recs = result.metrics["recommendations"]
    assert recs[0]["wash_sale_risk"] == "potential"
    assert "wash-sale" in (recs[0]["wash_sale_reason"] or "").lower()


def test_ranking_clean_before_risky_then_dollar_then_st():
    analyzer = _make_analyzer({"min_loss_threshold": 50})

    # Three loss lots:
    #   A: clean, $200 loss, LT
    #   B: clean, $1000 loss, LT
    #   C: blocked, $5000 loss, LT (largest dollar but blocked)
    #   D: clean, $1000 loss, ST  (same dollar as B but ST should rank higher)
    positions = [
        {
            "ticker": "AAA",
            "account_id": "acct-tax",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-A",
                "purchase_date": NOW - timedelta(days=400),
                "shares": 10,
                "cost_basis": 1200.0,   # -200 LT
            }],
        },
        {
            "ticker": "BBB",
            "account_id": "acct-tax",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-B",
                "purchase_date": NOW - timedelta(days=400),
                "shares": 10,
                "cost_basis": 2000.0,   # -1000 LT
            }],
        },
        {
            "ticker": "CCC",
            "account_id": "acct-tax",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-C",
                "purchase_date": NOW - timedelta(days=400),
                "shares": 10,
                "cost_basis": 6000.0,   # -5000 LT
            }],
        },
        # Replacement buy in another taxable account → blocks lot-C
        {
            "ticker": "CCC",
            "account_id": "acct-tax-2",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-C-replace",
                "purchase_date": NOW - timedelta(days=5),
                "shares": 1,
                "cost_basis": 100.0,
            }],
        },
        {
            "ticker": "DDD",
            "account_id": "acct-tax",
            "current_price": 100.0,
            "lots": [{
                "id": "lot-D",
                "purchase_date": NOW - timedelta(days=30),
                "shares": 10,
                "cost_basis": 2000.0,   # -1000 ST
            }],
        },
    ]
    result = analyzer.analyze(positions, _accounts())
    order = [r["lot_id"] for r in result.metrics["recommendations"]]
    # Expected:
    #   1. Clean lots first (A, B, D) before the blocked C.
    #   2. Within clean: largest dollar loss first => B and D are tied at $1k;
    #      ST tie-break puts D before B. Then A ($200).
    assert order[0] == "lot-D"          # ST $1000 wins over LT $1000
    assert order[1] == "lot-B"          # LT $1000
    assert order[2] == "lot-A"          # $200
    assert order[-1] == "lot-C"         # blocked, ranked last


def test_synthetic_single_lot_fallback_when_no_lots():
    """A position with no `lots` list should still produce a recommendation
    using the legacy Position-level cost_basis/purchase_date/shares."""
    analyzer = _make_analyzer({"min_loss_threshold": 50})
    positions = [{
        "ticker": "OLD",
        "name": "Legacy Position",
        "account_id": "acct-tax",
        "current_price": 80.0,
        "shares": 10,
        "cost_basis": 1000.0,                   # market value 800 -> -200
        "purchase_date": NOW - timedelta(days=100),
        # No "lots" key on purpose.
    }]
    result = analyzer.analyze(positions, _accounts())
    recs = result.metrics["recommendations"]
    assert len(recs) == 1
    assert recs[0]["lot_id"] == "synthetic"
    assert recs[0]["unrealized_loss"] == pytest.approx(200.0)
    assert recs[0]["unrealized_gain_loss"] == pytest.approx(-200.0)
    # Backward-compat keys still present
    assert recs[0]["account_name"] == "Taxable Brokerage"
    assert recs[0]["loss_percent"] == pytest.approx(-20.0)


def test_lot_with_no_purchase_date_is_skipped():
    """A lot with no purchase_date can't be classified ST/LT — skip it
    cleanly (with a note logged) rather than miscategorising."""
    analyzer = _make_analyzer({"min_loss_threshold": 50})
    positions = [{
        "ticker": "MYSTERY",
        "account_id": "acct-tax",
        "current_price": 50.0,
        "shares": 10,
        "cost_basis": 1000.0,    # market value 500 -> -500 if it counted
        "purchase_date": None,
    }]
    result = analyzer.analyze(positions, _accounts())
    assert result.success
    assert result.metrics["recommendations"] == []
    assert result.metrics["skipped_no_purchase_date"] == 1


def test_legacy_metric_keys_preserved_for_backward_compat():
    analyzer = _make_analyzer({"min_loss_threshold": 50, "tax_rate": 24})
    positions = [{
        "ticker": "LEG",
        "account_id": "acct-tax",
        "current_price": 80.0,
        "shares": 10,
        "cost_basis": 1000.0,
        "purchase_date": NOW - timedelta(days=100),
    }]
    result = analyzer.analyze(positions, _accounts())
    m = result.metrics
    # All old keys still exist
    for key in (
        "total_unrealized_losses", "estimated_tax_savings",
        "harvesting_opportunities", "largest_loss_position",
        "candidates", "largest_loss_amount", "tax_rate_used",
    ):
        assert key in m, f"Missing legacy metric key {key!r}"
    assert m["largest_loss_position"] == "LEG"
    assert m["harvesting_opportunities"] == 1
