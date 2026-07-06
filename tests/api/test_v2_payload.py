"""Tests for the v2 payload adapters (src/api/v2/payload.py).

Covers: account-type mapping parity with v1, dropping priceless positions,
and options market-value computation.
"""

from src.api.v2.payload import (
    PortfolioPayload,
    AccountPayload,
    PositionPayload,
    payload_to_portfolio,
    payload_to_portfolio_with_warnings,
    payload_to_raw_positions,
)
from src.models import AccountType, Brokerage


class TestPayloadToPortfolio:
    def test_maps_known_account_types(self):
        """Each known account_type string maps to the matching AccountType enum,
        mirroring db_to_portfolio's account_type_map (src/api/analysis.py)."""
        cases = [
            ("roth_ira", AccountType.ROTH_IRA),
            ("traditional_ira", AccountType.TRADITIONAL_IRA),
            ("traditional_401k", AccountType.TRADITIONAL_401K),
            ("roth_401k", AccountType.ROTH_401K),
            ("taxable", AccountType.TAXABLE),
            ("hsa", AccountType.HSA),
        ]
        for raw_type, expected in cases:
            payload = PortfolioPayload(accounts=[
                AccountPayload(
                    name="Acct",
                    account_type=raw_type,
                    positions=[PositionPayload(ticker="VTI", shares=1, current_price=100.0)],
                )
            ])
            portfolio = payload_to_portfolio(payload)
            assert portfolio.accounts[0].account_type == expected

    def test_unknown_account_type_falls_back_to_taxable(self):
        """Custom/529/checking types (not in the map) default to TAXABLE,
        matching v1's fallback behavior exactly."""
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="529 Plan",
                account_type="529",
                positions=[PositionPayload(ticker="VTI", shares=1, current_price=100.0)],
            )
        ])
        portfolio = payload_to_portfolio(payload)
        assert portfolio.accounts[0].account_type == AccountType.TAXABLE

    def test_drops_positions_with_no_current_price(self):
        """Positions with current_price=None are dropped, mirroring
        db_to_portfolio's `if not db_pos.current_price: continue`."""
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Taxable",
                account_type="taxable",
                positions=[
                    PositionPayload(ticker="VTI", shares=10, current_price=250.0),
                    PositionPayload(ticker="NOPRICE", shares=5, current_price=None),
                ],
            )
        ])
        portfolio = payload_to_portfolio(payload)
        tickers = [p.ticker for p in portfolio.all_positions]
        assert tickers == ["VTI"]

    def test_account_with_only_priceless_positions_is_dropped_entirely(self):
        """If every position in an account lacks a price, the account itself
        produces no entry (matches v1: `if positions:` guard)."""
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Empty",
                account_type="taxable",
                positions=[PositionPayload(ticker="X", shares=1, current_price=None)],
            )
        ])
        portfolio = payload_to_portfolio(payload)
        assert portfolio.accounts == []

    def test_brokerage_mapping_defaults_to_other(self):
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Acct",
                account_type="taxable",
                brokerage="not_a_real_brokerage",
                positions=[PositionPayload(ticker="VTI", shares=1, current_price=100.0)],
            )
        ])
        portfolio = payload_to_portfolio(payload)
        assert portfolio.accounts[0].brokerage == Brokerage.OTHER

    def test_known_brokerage_maps_correctly(self):
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Acct",
                account_type="taxable",
                brokerage="vanguard",
                positions=[PositionPayload(ticker="VTI", shares=1, current_price=100.0)],
            )
        ])
        portfolio = payload_to_portfolio(payload)
        assert portfolio.accounts[0].brokerage == Brokerage.VANGUARD


class TestPayloadToPortfolioWithWarnings:
    """F5: payload_to_portfolio_with_warnings additively reports the
    positions payload_to_portfolio silently drops (no price)."""

    def test_reports_excluded_priceless_position(self):
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Taxable",
                account_type="taxable",
                positions=[
                    PositionPayload(ticker="VTI", shares=10, current_price=250.0),
                    PositionPayload(ticker="NOPRICE", shares=5, current_price=None),
                ],
            )
        ])
        portfolio, excluded = payload_to_portfolio_with_warnings(payload)

        assert [p.ticker for p in portfolio.all_positions] == ["VTI"]
        assert len(excluded) == 1
        assert excluded[0].ticker == "NOPRICE"
        assert excluded[0].account_name == "Taxable"
        assert excluded[0].reason == "missing_price"

    def test_no_exclusions_when_all_positions_have_prices(self):
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Taxable",
                account_type="taxable",
                positions=[PositionPayload(ticker="VTI", shares=10, current_price=250.0)],
            )
        ])
        _portfolio, excluded = payload_to_portfolio_with_warnings(payload)
        assert excluded == []

    def test_payload_to_portfolio_is_unchanged_by_the_warnings_variant(self):
        """payload_to_portfolio (used by callers that don't need warnings)
        keeps its exact prior signature/behavior — it's a thin wrapper that
        discards the excluded list."""
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Taxable",
                account_type="taxable",
                positions=[
                    PositionPayload(ticker="VTI", shares=10, current_price=250.0),
                    PositionPayload(ticker="NOPRICE", shares=5, current_price=None),
                ],
            )
        ])
        portfolio = payload_to_portfolio(payload)
        assert [p.ticker for p in portfolio.all_positions] == ["VTI"]


class TestPayloadToRawPositions:
    def test_options_market_value_applies_contract_multiplier(self):
        """Options market_value = contracts * price * multiplier (100),
        matching src/models/position_types.py:position_market_value."""
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Taxable",
                account_type="taxable",
                positions=[
                    PositionPayload(
                        ticker="GOOG 06/17/2027 305.00 C",
                        shares=2,  # 2 contracts
                        current_price=5.50,  # per-share premium
                        position_type="option",
                        contract_multiplier=100,
                    ),
                ],
            )
        ])
        raw = payload_to_raw_positions(payload)
        assert len(raw) == 1
        # 2 contracts * 100 multiplier * $5.50 premium = $1100
        assert raw[0]["market_value"] == 1100.0

    def test_equity_market_value_no_multiplier(self):
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Taxable",
                account_type="taxable",
                positions=[PositionPayload(ticker="AAPL", shares=10, current_price=200.0)],
            )
        ])
        raw = payload_to_raw_positions(payload)
        assert raw[0]["market_value"] == 2000.0

    def test_does_not_drop_priceless_positions(self):
        """Unlike payload_to_portfolio, raw positions keep priceless entries
        (market_value computed as 0.0) since expense-drag/allocation code
        filters on value itself."""
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                name="Taxable",
                account_type="taxable",
                positions=[PositionPayload(ticker="X", shares=5, current_price=None)],
            )
        ])
        raw = payload_to_raw_positions(payload)
        assert len(raw) == 1
        assert raw[0]["market_value"] == 0.0

    def test_carries_account_context(self):
        payload = PortfolioPayload(accounts=[
            AccountPayload(
                id="acc-1",
                name="My Roth",
                account_type="roth_ira",
                brokerage="fidelity",
                is_retirement_account=True,
                positions=[PositionPayload(ticker="VTI", shares=1, current_price=100.0)],
            )
        ])
        raw = payload_to_raw_positions(payload)
        assert raw[0]["account_id"] == "acc-1"
        assert raw[0]["account_name"] == "My Roth"
        assert raw[0]["account_type"] == "roth_ira"
        assert raw[0]["brokerage"] == "fidelity"
        assert raw[0]["is_retirement_account"] is True
