"""Property accounts (a home) never count as investable allocation (plan decision D6).

Both server paths that build the analysis Portfolio must agree: the database path
(db_to_portfolio) and the client-payload path (payload_to_portfolio).
"""

from types import SimpleNamespace

from src.api.analysis import db_to_portfolio
from src.api.v2.payload import AccountPayload, PortfolioPayload, PositionPayload, payload_to_portfolio


def _db_account(name: str, account_type: str, ticker: str, price: float):
    position = SimpleNamespace(
        ticker=ticker, name=ticker, shares=1, current_price=price, cost_basis=None, sector=None, is_fund=False
    )
    return SimpleNamespace(name=name, account_type=account_type, brokerage=None, positions=[position])


def _payload_account(name: str, account_type: str, ticker: str, price: float) -> AccountPayload:
    return AccountPayload(
        name=name,
        account_type=account_type,
        positions=[PositionPayload(ticker=ticker, shares=1, current_price=price)],
    )


def test_db_path_leaves_property_accounts_out():
    db = SimpleNamespace(
        get_all_accounts_with_positions=lambda: [
            _db_account("Brokerage", "taxable", "VTI", 1000.0),
            _db_account("Home", "property", "HOME", 685000.0),
        ]
    )
    portfolio = db_to_portfolio(db)
    assert [a.name for a in portfolio.accounts] == ["Brokerage"]
    assert portfolio.total_value == 1000.0


def test_payload_path_leaves_property_accounts_out():
    payload = PortfolioPayload(
        accounts=[
            _payload_account("Brokerage", "taxable", "VTI", 1000.0),
            _payload_account("Home", "property", "HOME", 685000.0),
        ]
    )
    portfolio = payload_to_portfolio(payload)
    assert [a.name for a in portfolio.accounts] == ["Brokerage"]
    assert portfolio.total_value == 1000.0


def test_other_account_types_are_unchanged_on_both_paths():
    db = SimpleNamespace(get_all_accounts_with_positions=lambda: [_db_account("Rental", "taxable", "RE", 500.0)])
    payload = PortfolioPayload(accounts=[_payload_account("Rental", "taxable", "RE", 500.0)])
    assert db_to_portfolio(db).total_value == 500.0
    assert payload_to_portfolio(payload).total_value == 500.0
