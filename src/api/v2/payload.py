"""Payload models and adapters for the stateless /api/v2 API.

v2 endpoints receive the client's full portfolio/budget state in the request
body instead of reading it from the server-side SQLite DB. These models
mirror the shape of `src/database/models.py` (the superset "full ORM-like"
position/account fields) so the client can send exactly what it stores
locally.

Two adapters bridge payloads to the pure analysis code:
- `payload_to_portfolio`: builds the same Pydantic `Portfolio` that v1's
  `db_to_portfolio` (src/api/analysis.py) builds, so downstream analyzers
  (performance, risk, allocation, correlation) run identical code paths.
- `payload_to_raw_positions`: builds "full ORM-like" dicts (one per
  position, with account info attached) for the code that needs the fuller
  shape not captured by the Pydantic Position model (expense-drag detailed
  allocation, triggers) — e.g. position_type, asset_class, options fields.
"""

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from src.api.analysis import map_account_type_str, map_brokerage_str
from src.models import Portfolio, Account as PydanticAccount, Position as PydanticPosition
from src.models.position_types import position_market_value


class PositionPayload(BaseModel):
    """Full ORM-like position shape sent by the client."""

    id: Optional[str] = None
    ticker: str
    name: Optional[str] = None
    shares: float
    cost_basis: Optional[float] = None
    current_price: Optional[float] = None
    sector: Optional[str] = None
    is_fund: bool = False
    asset_class: str = "equity"
    position_type: str = "equity"
    maturity_date: Optional[datetime] = None
    purchase_date: Optional[datetime] = None
    interest_rate: Optional[float] = None
    option_underlying: Optional[str] = None
    option_expiration: Optional[datetime] = None
    option_strike: Optional[float] = None
    option_type: Optional[str] = None
    contract_multiplier: Optional[float] = None


class AccountPayload(BaseModel):
    """Full ORM-like account shape sent by the client."""

    id: Optional[str] = None
    name: str
    account_type: str
    brokerage: Optional[str] = "other"
    beneficiary: Optional[str] = None
    custom_type_name: Optional[str] = None
    is_retirement_account: bool = False
    entity_id: Optional[str] = None
    positions: list[PositionPayload] = Field(default_factory=list)


class PortfolioPayload(BaseModel):
    """Full portfolio (all accounts + positions) sent by the client."""

    accounts: list[AccountPayload] = Field(default_factory=list)
    market_config: Optional[dict] = Field(
        None,
        description=(
            "Optional overrides for RiskAnalyzer's market assumptions "
            "(risk_free_rate). Keys match config.yaml's `market` section. "
            "Only consumed by /risk; other endpoints ignore this field. "
            "Never triggers a server-side config/DB lookup: when omitted, "
            "RiskAnalyzer's own class defaults apply (not load_config())."
        ),
    )


class TriggerPayload(BaseModel):
    """Mirrors allocation_triggers columns."""

    id: Optional[str] = None
    name: str
    condition_type: str
    ticker: Optional[str] = None
    account_type: Optional[str] = None
    sector: Optional[str] = None
    operator: str
    threshold: float
    is_active: bool = True


class IncomeSourcePayload(BaseModel):
    """Mirrors budget_income_sources columns."""

    id: Optional[str] = None
    name: str
    income_type: str = "employment"
    gross_annual: float
    pay_frequency: str = "biweekly"
    state: str = "CA"
    is_active: bool = True


class DeductionPayload(BaseModel):
    """Mirrors budget_pretax_deductions columns."""

    id: Optional[str] = None
    income_source_id: Optional[str] = None
    label: Optional[str] = None
    deduction_type: str = "401k"
    amount_per_period: float
    employer_match: float = 0
    is_percentage: bool = False
    max_annual: Optional[float] = None


class ExpensePayload(BaseModel):
    """Mirrors budget_expenses columns.

    `category_name` is carried directly on the payload (rather than via an
    ORM relationship lookup) since v2 has no category table to join against.
    """

    id: Optional[str] = None
    category_id: Optional[str] = None
    category_name: str = "Other"
    name: str
    amount: float
    frequency: str = "monthly"
    is_pretax: bool = False
    is_mortgage: bool = False
    principal_portion: Optional[float] = None
    interest_portion: Optional[float] = None
    is_active: bool = True


class TaxConfigPayload(BaseModel):
    """Mirrors budget_tax_config columns."""

    id: Optional[str] = None
    tax_year: int = 2024
    filing_status: str = "single"
    state: str = "CA"
    ss_benefit_override: Optional[float] = None
    additional_withholding: float = 0
    itemized_deduction: Optional[float] = None
    ss_claiming_age: int = 67


class ExcludedPosition(BaseModel):
    """A position dropped by payload_to_portfolio_with_warnings, and why."""

    ticker: str
    account_name: str
    reason: str = "missing_price"


def payload_to_portfolio_with_warnings(
    p: PortfolioPayload,
) -> tuple[Portfolio, list[ExcludedPosition]]:
    """Build a Pydantic Portfolio from a client-supplied payload, and also
    return the positions that were silently dropped along the way.

    Replicates the logic of `db_to_portfolio` (src/api/analysis.py): map
    account types through the shared helper, drop positions with no
    current_price, and build Account/Position models identically to v1 —
    but unlike `payload_to_portfolio`, also reports what got dropped
    (ticker, account_name, reason) instead of discarding that information.
    """
    accounts = []
    excluded: list[ExcludedPosition] = []

    for acc in p.accounts:
        positions = []
        for pos in acc.positions:
            # Skip positions without prices (matches db_to_portfolio).
            if not pos.current_price:
                excluded.append(ExcludedPosition(
                    ticker=pos.ticker,
                    account_name=acc.name,
                    reason="missing_price",
                ))
                continue

            positions.append(PydanticPosition(
                ticker=pos.ticker,
                name=pos.name or pos.ticker,
                shares=pos.shares,
                current_price=pos.current_price,
                cost_basis=pos.cost_basis,
                account_name=acc.name,
                brokerage=map_brokerage_str(acc.brokerage),
                sector=pos.sector,
                is_fund=pos.is_fund,
                contract_multiplier=pos.contract_multiplier,
            ))

        if positions:
            accounts.append(PydanticAccount(
                name=acc.name,
                account_type=map_account_type_str(acc.account_type),
                brokerage=map_brokerage_str(acc.brokerage),
                positions=positions,
            ))

    return Portfolio(accounts=accounts), excluded


def payload_to_portfolio(p: PortfolioPayload) -> Portfolio:
    """Build a Pydantic Portfolio from a client-supplied payload.

    Backward-compatible wrapper around `payload_to_portfolio_with_warnings`
    that discards the excluded-positions list, for callers that don't need
    it. See that function's docstring for the exclusion rule.
    """
    portfolio, _excluded = payload_to_portfolio_with_warnings(p)
    return portfolio


def payload_to_raw_positions(p: PortfolioPayload) -> list[dict]:
    """Build "full ORM-like" position dicts (with account info attached).

    Unlike `payload_to_portfolio`, this does NOT drop priceless positions
    and carries the fuller field set (position_type, asset_class, options)
    needed by expense-drag, detailed-allocation, and trigger evaluation —
    mirroring what `db.get_all_positions()` / `db.get_all_accounts()` expose
    to those code paths in v1.
    """
    raw: list[dict] = []
    for acc in p.accounts:
        for pos in acc.positions:
            market_value = position_market_value(pos)
            raw.append({
                "id": pos.id,
                "ticker": pos.ticker,
                "name": pos.name or pos.ticker,
                "shares": pos.shares,
                "cost_basis": pos.cost_basis,
                "current_price": pos.current_price,
                "sector": pos.sector,
                "is_fund": pos.is_fund,
                "asset_class": pos.asset_class,
                "position_type": pos.position_type,
                "maturity_date": pos.maturity_date,
                "purchase_date": pos.purchase_date,
                "interest_rate": pos.interest_rate,
                "option_underlying": pos.option_underlying,
                "option_expiration": pos.option_expiration,
                "option_strike": pos.option_strike,
                "option_type": pos.option_type,
                "contract_multiplier": pos.contract_multiplier,
                "market_value": market_value,
                # Account context
                "account_id": acc.id,
                "account_name": acc.name,
                "account_type": acc.account_type,
                "brokerage": acc.brokerage,
                "is_retirement_account": acc.is_retirement_account,
            })
    return raw


def payload_to_advisor_portfolio_context(p: PortfolioPayload) -> dict:
    """Build the same shape as AdvisorAnalysisService._get_portfolio_context()
    (src/services/advisor_analysis.py) from a client-supplied payload, so the
    advisor service can run without a DB.
    """
    raw_positions = payload_to_raw_positions(p)

    holdings: dict[str, dict] = {}
    total_value = 0.0
    account_holdings: dict[str, dict] = {}

    for pos in raw_positions:
        value = pos["market_value"]
        if not value:
            continue
        total_value += value

        ticker = (pos["ticker"] or "").upper()
        if ticker not in holdings:
            holdings[ticker] = {
                "ticker": ticker,
                "name": pos["name"] or ticker,
                "value": 0.0,
                "is_fund": pos["is_fund"],
                "accounts": [],
            }
        holdings[ticker]["value"] += value

        acc_info = {
            "name": pos["account_name"],
            "type": pos["account_type"],
            "is_retirement": pos["is_retirement_account"],
        }
        if acc_info not in holdings[ticker]["accounts"]:
            holdings[ticker]["accounts"].append(acc_info)

        account_name = pos["account_name"]
        if account_name not in account_holdings:
            account_holdings[account_name] = {
                "type": pos["account_type"],
                "is_retirement": pos["is_retirement_account"],
                "positions": [],
            }
        account_holdings[account_name]["positions"].append({
            "ticker": ticker,
            "value": value,
        })

    for ticker, data in holdings.items():
        data["pct"] = round(data["value"] / total_value * 100, 2) if total_value > 0 else 0

    return {
        "total_value": total_value,
        "holdings": list(holdings.values()),
        "accounts": account_holdings,
        "holding_count": len(holdings),
    }
