"""Portfolio API endpoints."""

import csv
import io
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any, Optional, cast

from src.database import Database
from src.models.account_types import get_all_predefined_types

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


from src.api.dependencies import get_db  # noqa: E402  (public router dep)


def check_demo_mode_write() -> None:
    """Check if demo data modifications are protected.

    Uses centralized check from demo_mode service.
    Only blocks when BOTH demo mode AND PROTECT_DEMO_DATA env var are enabled.
    """
    from src.services.demo_mode import check_demo_data_protection
    check_demo_data_protection()


class AccountResponse(BaseModel):
    """Account response model."""
    id: str
    name: str
    account_type: str
    display_type: str
    brokerage: str
    value: float
    cost_basis: Optional[float]
    position_count: int
    beneficiary: Optional[str] = None
    is_retirement: bool = False
    entity_id: Optional[str] = None


class PositionResponse(BaseModel):
    """Position response model."""
    id: str
    account_id: str
    account_name: str
    ticker: str
    name: Optional[str]
    shares: float
    current_price: Optional[float]
    cost_basis: Optional[float]
    market_value: float
    accrued_value: Optional[float] = None  # For CDs/bonds: principal + accrued interest
    gain_loss: Optional[float]
    gain_loss_pct: Optional[float]
    is_fund: bool
    asset_class: str
    position_type: str
    maturity_date: Optional[str] = None
    purchase_date: Optional[str] = None
    interest_rate: Optional[float] = None  # APY as decimal (0.05 = 5%)


class PortfolioSummary(BaseModel):
    """Portfolio summary response."""
    total_value: float
    total_cost_basis: Optional[float]
    total_gain_loss: Optional[float]
    retirement_value: float
    taxable_value: float
    account_count: int
    position_count: int
    accounts: list[AccountResponse]


class CreateAccountRequest(BaseModel):
    """Request model for creating an account."""
    name: str
    account_type: str  # roth_ira, traditional_401k, taxable, custom:Name, etc.
    brokerage: str = "other"
    beneficiary: Optional[str] = None  # For 529 accounts
    custom_type_name: Optional[str] = None  # Display name for custom types
    is_retirement: Optional[bool] = None  # Override retirement status


class CreatePositionRequest(BaseModel):
    """Request model for manually adding a position."""
    account_id: str
    ticker: str
    shares: float
    name: Optional[str] = None
    current_price: Optional[float] = None
    cost_basis: Optional[float] = None
    is_fund: bool = False
    position_type: str = "equity"  # equity, fund, cash, cd, bond, treasury
    asset_class: str = "equity"  # equity, fixed_income, cash, alternative


class CreateCashPositionRequest(BaseModel):
    """Request model for adding a cash position."""
    account_id: str
    amount: float
    name: str = "Cash"
    interest_rate: Optional[float] = None  # Optional APY for high-yield savings (as decimal)


class CreateCDPositionRequest(BaseModel):
    """Request model for adding a CD position."""
    account_id: str
    amount: float  # Principal amount
    name: str
    interest_rate: float  # Annual rate as decimal (e.g., 0.05 for 5%)
    maturity_date: str  # ISO format date
    purchase_date: Optional[str] = None  # ISO format date


class CreateRealEstateRequest(BaseModel):
    """Request model for adding a real estate position."""
    account_id: str
    name: str  # e.g., "Primary Residence", "123 Main St"
    current_value: float  # Current estimated market value
    cost_basis: float  # Purchase price + improvements
    purchase_date: Optional[str] = None  # ISO format date


class AccountTypeResponse(BaseModel):
    """Account type option for dropdowns."""
    value: str
    label: str
    is_retirement: bool
    description: Optional[str] = None
    has_beneficiary: bool = False


@router.get("", response_model=PortfolioSummary)
def get_portfolio_summary(db: Database = Depends(get_db)) -> PortfolioSummary:
    """Get current portfolio summary."""
    summary = db.get_portfolio_summary()

    accounts = [
        AccountResponse(
            id=a["id"],
            name=a["name"],
            account_type=a["account_type"],
            display_type=a["display_type"],
            brokerage=a["brokerage"],
            value=a["value"],
            cost_basis=a["cost_basis"],
            position_count=a["position_count"],
            is_retirement=a["is_retirement"],
            entity_id=a.get("entity_id"),
        )
        for a in summary["accounts"]
    ]

    return PortfolioSummary(
        total_value=summary["total_value"],
        total_cost_basis=summary["total_cost_basis"],
        total_gain_loss=summary["total_gain_loss"],
        retirement_value=summary["retirement_value"],
        taxable_value=summary["taxable_value"],
        account_count=summary["account_count"],
        position_count=summary["position_count"],
        accounts=accounts,
    )


@router.get("/accounts", response_model=list[AccountResponse])
def get_accounts(db: Database = Depends(get_db)) -> list[AccountResponse]:
    """Get all accounts."""
    accounts = db.get_all_accounts()
    result = []

    for account in accounts:
        positions = db.get_positions_by_account(cast(str, account.id))
        value: float = float(sum(
            (p.shares * p.current_price) if p.current_price else 0
            for p in positions
        ))
        cost_basis: float = float(sum(p.cost_basis for p in positions if p.cost_basis))

        result.append(AccountResponse(
            id=cast(str, account.id),
            name=cast(str, account.name),
            account_type=cast(str, account.account_type),
            display_type=account.display_type,
            brokerage=cast(str, account.brokerage),
            value=value,
            cost_basis=cost_basis if cost_basis else None,
            position_count=len(positions),
            beneficiary=cast(Optional[str], account.beneficiary),
            is_retirement=account.is_retirement,
            entity_id=cast(Optional[str], account.entity_id),
        ))

    return result


@router.get("/account-types", response_model=list[AccountTypeResponse])
def get_account_types() -> list[AccountTypeResponse]:
    """Get all available account types for dropdowns."""
    types = get_all_predefined_types()
    return [
        AccountTypeResponse(
            value=t["value"],
            label=t["label"],
            is_retirement=t.get("is_retirement", False),
            description=t.get("description"),
            has_beneficiary=t.get("has_beneficiary", False),
        )
        for t in types
    ]


@router.get("/positions", response_model=list[PositionResponse])
def get_all_positions(db: Database = Depends(get_db)) -> list[PositionResponse]:
    """Get all positions across all accounts."""
    positions = db.get_all_positions()
    accounts = {a.id: a for a in db.get_all_accounts()}
    result = []

    for pos in positions:
        account = accounts.get(pos.account_id)

        # Calculate accrued value for positions with interest rates (CDs, bonds, cash with APY)
        accrued_value = db.calculate_accrued_value(pos)

        # For positions with interest, use accrued value as market value
        # For regular positions, use shares * price
        market_value: float
        if pos.interest_rate and pos.interest_rate > 0:
            market_value = float(accrued_value)
        else:
            market_value = float(pos.shares * pos.current_price) if pos.current_price else 0.0

        gain_loss: Optional[float] = None
        gain_loss_pct: Optional[float] = None

        if pos.cost_basis and market_value:
            gain_loss = float(market_value - pos.cost_basis)
            if pos.cost_basis > 0:
                gain_loss_pct = (gain_loss / float(pos.cost_basis)) * 100

        result.append(PositionResponse(
            id=cast(str, pos.id),
            account_id=cast(str, pos.account_id),
            account_name=cast(str, account.name) if account else "Unknown",
            ticker=cast(str, pos.ticker),
            name=cast(Optional[str], pos.name),
            shares=cast(float, pos.shares),
            current_price=cast(Optional[float], pos.current_price),
            cost_basis=cast(Optional[float], pos.cost_basis),
            market_value=market_value,
            accrued_value=accrued_value if pos.interest_rate else None,
            gain_loss=gain_loss,
            gain_loss_pct=gain_loss_pct,
            is_fund=cast(bool, pos.is_fund),
            asset_class=cast(str, pos.asset_class or "equity"),
            position_type=cast(str, pos.position_type or "equity"),
            maturity_date=pos.maturity_date.isoformat() if pos.maturity_date else None,
            purchase_date=pos.purchase_date.isoformat() if pos.purchase_date else None,
            interest_rate=cast(Optional[float], pos.interest_rate),
        ))

    return result


@router.post("/snapshot")
def take_snapshot(db: Database = Depends(get_db)) -> dict:
    """Take a snapshot of the current portfolio."""
    snapshot = db.take_snapshot()
    return {
        "message": "Snapshot created",
        "snapshot_date": snapshot.snapshot_date.isoformat(),
        "total_value": snapshot.total_value,
    }


@router.get("/snapshots")
def get_snapshots(limit: int = 365, db: Database = Depends(get_db)) -> list[dict]:
    """Get historical snapshots."""
    snapshots = db.get_snapshots(limit)
    return [
        {
            "id": s.id,
            "snapshot_date": s.snapshot_date.isoformat(),
            "total_value": s.total_value,
            "retirement_value": s.retirement_value,
            "taxable_value": s.taxable_value,
        }
        for s in snapshots
    ]


@router.delete("/accounts/{account_id}")
def delete_account(account_id: str, db: Database = Depends(get_db)) -> dict:
    """Delete an account and all its positions."""
    check_demo_mode_write()
    if db.delete_account(account_id):
        return {"message": "Account deleted"}
    raise HTTPException(status_code=404, detail="Account not found")


@router.post("/accounts")
def create_account(request: CreateAccountRequest, db: Database = Depends(get_db)) -> dict:
    """Create a new account for manual position entry."""
    check_demo_mode_write()
    # For custom types, ensure the custom_type_name is set
    custom_name = request.custom_type_name
    if request.account_type.startswith("custom:") and not custom_name:
        custom_name = request.account_type[7:]  # Extract name from type

    account = db.get_or_create_account(
        name=request.name,
        account_type=request.account_type,
        brokerage=request.brokerage,
        beneficiary=request.beneficiary,
        custom_type_name=custom_name,
        is_retirement_account=request.is_retirement,
    )

    # Create import folder for this account type
    from src.importers.folder_scanner import FolderScanner
    FolderScanner.create_import_folder("data/imports", request.account_type)

    return {
        "id": account.id,
        "name": account.name,
        "account_type": account.account_type,
        "display_type": account.display_type,
        "brokerage": account.brokerage,
        "beneficiary": account.beneficiary,
        "is_retirement": account.is_retirement,
    }


@router.post("/positions")
def create_position(request: CreatePositionRequest, db: Database = Depends(get_db)) -> dict:
    """Manually add a position to an account."""
    check_demo_mode_write()
    # Verify account exists
    account = db.get_account_by_id(request.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    # Add the position
    position = db.add_position(
        account_id=request.account_id,
        ticker=request.ticker.upper(),
        shares=request.shares,
        name=request.name,
        current_price=request.current_price,
        cost_basis=request.cost_basis,
        is_fund=request.is_fund,
        position_type=request.position_type,
        asset_class=request.asset_class,
    )

    return {
        "id": position.id,
        "ticker": position.ticker,
        "shares": position.shares,
        "position_type": position.position_type,
        "message": f"Position added: {position.shares} shares of {position.ticker}",
    }


@router.post("/positions/cash")
def create_cash_position(request: CreateCashPositionRequest, db: Database = Depends(get_db)) -> dict:
    """Add a cash position to an account."""
    check_demo_mode_write()
    # Verify account exists
    account = db.get_account_by_id(request.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    # Add cash position (with optional APY for high-yield savings)
    position = db.add_position(
        account_id=request.account_id,
        ticker="CASH",
        shares=1.0,  # For cash, shares is always 1
        name=request.name,
        current_price=request.amount,  # Price represents the dollar amount
        cost_basis=request.amount,
        is_fund=False,
        position_type="cash",
        asset_class="cash",
        interest_rate=request.interest_rate,  # Optional APY
        purchase_date=datetime.utcnow() if request.interest_rate else None,  # Track start if APY set
    )

    msg = f"Cash position added: ${request.amount:,.2f}"
    if request.interest_rate:
        msg += f" at {request.interest_rate * 100:.2f}% APY"

    return {
        "id": position.id,
        "amount": request.amount,
        "interest_rate": request.interest_rate,
        "message": msg,
    }


@router.post("/positions/cd")
def create_cd_position(request: CreateCDPositionRequest, db: Database = Depends(get_db)) -> dict:
    """Add a CD position to an account."""
    check_demo_mode_write()
    # Verify account exists
    account = db.get_account_by_id(request.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    # Parse dates
    maturity = datetime.fromisoformat(request.maturity_date)
    purchase = datetime.fromisoformat(request.purchase_date) if request.purchase_date else datetime.utcnow()

    # Add CD position
    position = db.add_position(
        account_id=request.account_id,
        ticker="CD",
        shares=1.0,  # For CDs, shares is always 1
        name=request.name,
        current_price=request.amount,  # Price represents principal
        cost_basis=request.amount,
        is_fund=False,
        position_type="cd",
        asset_class="fixed_income",
        maturity_date=maturity,
        interest_rate=request.interest_rate,
        purchase_date=purchase,
    )

    return {
        "id": position.id,
        "amount": request.amount,
        "interest_rate": request.interest_rate,
        "maturity_date": maturity.isoformat(),
        "message": f"CD position added: ${request.amount:,.2f} at {request.interest_rate * 100:.2f}% maturing {maturity.date()}",
    }


@router.get("/positions/cd/upcoming")
def get_upcoming_cd_maturities(days: int = 30, db: Database = Depends(get_db)) -> list[dict]:
    """Get CDs maturing within the specified number of days."""
    upcoming = db.get_upcoming_cd_maturities(days)
    return [
        {
            "id": cd.id,
            "account_id": cd.account_id,
            "name": cd.name,
            "amount": cd.current_price,
            "interest_rate": cd.interest_rate,
            "maturity_date": cd.maturity_date.isoformat() if cd.maturity_date else None,
            "days_until_maturity": (cd.maturity_date - datetime.utcnow()).days if cd.maturity_date else None,
        }
        for cd in upcoming
    ]


@router.post("/positions/cd/check-maturities")
def check_cd_maturities(db: Database = Depends(get_db)) -> dict:
    """Check for matured CDs and convert them to cash."""
    check_demo_mode_write()
    matured = db.check_cd_maturities()
    return {
        "matured_count": len(matured),
        "converted": [
            {
                "id": cd.id,
                "name": cd.name,
                "final_value": cd.current_price,
            }
            for cd in matured
        ],
        "message": f"{len(matured)} CD(s) converted to cash" if matured else "No CDs have matured",
    }


@router.post("/positions/real-estate")
def create_real_estate_position(request: CreateRealEstateRequest, db: Database = Depends(get_db)) -> dict:
    """Add a real estate position to an account.

    Real estate positions track property equity:
    - cost_basis = Purchase price + improvements
    - current_price = Current estimated market value
    - Equity = current_price - cost_basis (for gain/loss tracking)

    Note: This tracks the property value, not net equity after mortgage.
    For net equity, subtract your mortgage balance from the current_value.
    """
    check_demo_mode_write()
    # Verify account exists
    account = db.get_account_by_id(request.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    # Parse purchase date if provided
    purchase = None
    if request.purchase_date:
        purchase = datetime.fromisoformat(request.purchase_date)

    # Add real estate position
    position = db.add_position(
        account_id=request.account_id,
        ticker="RE",  # Real Estate ticker
        shares=1.0,  # Always 1 for property
        name=request.name,
        current_price=request.current_value,
        cost_basis=request.cost_basis,
        is_fund=False,
        position_type="real_estate",
        asset_class="alternative",
        purchase_date=purchase,
    )

    return {
        "id": position.id,
        "name": position.name,
        "current_value": position.current_price,
        "cost_basis": position.cost_basis,
        "unrealized_gain": position.current_price - position.cost_basis,
        "position_type": "real_estate",
    }


class UpdatePositionRequest(BaseModel):
    """Request model for updating a position."""
    shares: Optional[float] = None
    current_price: Optional[float] = None
    cost_basis: Optional[float] = None
    name: Optional[str] = None
    interest_rate: Optional[float] = None  # APY as decimal
    purchase_date: Optional[str] = None  # ISO format date
    maturity_date: Optional[str] = None  # ISO format date


@router.put("/positions/{position_id}")
def update_position(position_id: str, request: UpdatePositionRequest, db: Database = Depends(get_db)) -> dict:
    """Update a position's shares, price, or other fields."""
    check_demo_mode_write()
    position = db.get_position_by_id(position_id)
    if not position:
        raise HTTPException(status_code=404, detail="Position not found")

    updates: dict[str, Any] = {}
    if request.shares is not None:
        updates["shares"] = request.shares
    if request.current_price is not None:
        updates["current_price"] = request.current_price
    if request.cost_basis is not None:
        updates["cost_basis"] = request.cost_basis
    if request.name is not None:
        updates["name"] = request.name
    if request.interest_rate is not None:
        updates["interest_rate"] = request.interest_rate
    if request.purchase_date is not None:
        updates["purchase_date"] = datetime.fromisoformat(request.purchase_date)
    if request.maturity_date is not None:
        updates["maturity_date"] = datetime.fromisoformat(request.maturity_date)

    if updates:
        db.update_position(position_id, **updates)

    return {
        "message": "Position updated",
        "position_id": position_id,
        "updates": {k: str(v) if isinstance(v, datetime) else v for k, v in updates.items()},
    }


@router.delete("/positions/{position_id}")
def delete_position(position_id: str, db: Database = Depends(get_db)) -> dict:
    """Delete a position."""
    check_demo_mode_write()
    if db.delete_position(position_id):
        return {"message": "Position deleted"}
    raise HTTPException(status_code=404, detail="Position not found")


@router.get("/duplicates")
def find_duplicates(db: Database = Depends(get_db)) -> dict:
    """Find potential duplicate positions across accounts.

    Detects positions with the SAME ticker and EXACT same shares in
    DIFFERENT accounts. This is highly suspicious because fractional
    shares are very unlikely to match exactly.

    Returns:
        List of duplicate groups with details and reason for flagging.
    """
    duplicates = db.find_duplicate_positions()
    return {
        "duplicates": duplicates,
        "count": len(duplicates),
        "has_duplicates": len(duplicates) > 0,
    }


@router.get("/export/{data_type}")
def export_to_csv(data_type: str, db: Database = Depends(get_db)) -> Any:
    """Export portfolio data to CSV format.

    Args:
        data_type: One of 'accounts', 'positions', or 'snapshots'

    Returns:
        CSV file as streaming response
    """
    if data_type not in ('accounts', 'positions', 'snapshots'):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid data type: {data_type}. Must be 'accounts', 'positions', or 'snapshots'"
        )

    output = io.StringIO()
    writer = csv.writer(output)

    if data_type == 'accounts':
        # Export accounts
        accounts = db.get_all_accounts()
        writer.writerow([
            'id', 'name', 'account_type', 'display_type', 'brokerage',
            'beneficiary', 'is_retirement', 'created_at'
        ])
        for acc in accounts:
            writer.writerow([
                acc.id,
                acc.name,
                acc.account_type,
                acc.display_type,
                acc.brokerage or '',
                acc.beneficiary or '',
                acc.is_retirement,
                acc.created_at.isoformat() if acc.created_at else ''
            ])

    elif data_type == 'positions':
        # Export positions with account info
        positions = db.get_all_positions()
        accounts_by_id: dict[str, Any] = {cast(str, a.id): a for a in db.get_all_accounts()}

        writer.writerow([
            'id', 'account_id', 'account_name', 'ticker', 'name', 'shares',
            'current_price', 'cost_basis', 'market_value', 'gain_loss',
            'is_fund', 'asset_class', 'position_type', 'maturity_date',
            'interest_rate'
        ])
        for pos in positions:
            account = accounts_by_id.get(cast(str, pos.account_id))
            market_value = (pos.shares * pos.current_price) if pos.current_price else 0
            gain_loss = (market_value - pos.cost_basis) if pos.cost_basis else None

            writer.writerow([
                pos.id,
                pos.account_id,
                account.name if account else 'Unknown',
                pos.ticker,
                pos.name or '',
                pos.shares,
                pos.current_price or '',
                pos.cost_basis or '',
                market_value,
                gain_loss if gain_loss is not None else '',
                pos.is_fund,
                pos.asset_class or '',
                pos.position_type or 'equity',
                pos.maturity_date.isoformat() if pos.maturity_date else '',
                pos.interest_rate or ''
            ])

    elif data_type == 'snapshots':
        # Export historical snapshots
        snapshots = db.get_snapshots(limit=10000)  # Get all snapshots
        writer.writerow([
            'id', 'snapshot_date', 'total_value', 'retirement_value',
            'taxable_value', 'created_at'
        ])
        for snap in snapshots:
            writer.writerow([
                snap.id,
                snap.snapshot_date.isoformat() if snap.snapshot_date else '',
                snap.total_value,
                snap.retirement_value,
                snap.taxable_value,
                snap.created_at.isoformat() if snap.created_at else ''
            ])

    # Create streaming response
    output.seek(0)
    timestamp = datetime.now().strftime('%Y-%m-%d')
    filename = f"portfolio_{data_type}_{timestamp}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


# ==================== Dashboard Retirement Metrics ====================

class DashboardMetricsResponse(BaseModel):
    """Retirement metrics for dashboard display."""
    monthly_retirement_income: Optional[float]  # Based on projected value at retirement, None if no sim
    withdrawal_rate: int
    success_probability: Optional[float]  # From latest Monte Carlo
    earliest_retirement_age: Optional[int]  # Age to reach target income with 80%+ success
    fire_number: Optional[float]  # Amount needed for target monthly income
    current_age: Optional[int]
    target_retirement_age: Optional[int]
    target_monthly_income: Optional[float]
    last_simulation_date: Optional[str]
    total_portfolio_value: float
    projected_value_at_retirement: Optional[float]  # From Monte Carlo simulation
    conservative_value_at_retirement: Optional[float]  # 25th percentile estimate
    simulation_required: bool  # True if user needs to run simulation


@router.get("/dashboard-metrics", response_model=DashboardMetricsResponse)
def get_dashboard_metrics(
    entity_id: Optional[str] = None,
    db: Database = Depends(get_db),
) -> "DashboardMetricsResponse":
    """Get retirement planning metrics for dashboard display.

    Args:
        entity_id: Optional entity ID to filter metrics for a specific person.
                   If None, returns combined household metrics.

    Returns:
    - Monthly retirement income based on PROJECTED portfolio value at retirement (from Monte Carlo)
    - Success probability from latest Monte Carlo simulation
    - Earliest retirement age where target income is sustainable
    - FIRE number (portfolio needed for target income)

    Note: Monthly income requires a Monte Carlo simulation to be run first.
    """
    from src.api.settings import load_config
    from datetime import date

    # Validate entity_id if provided
    if entity_id:
        entity = db.get_entity_by_id(entity_id)
        if not entity:
            raise HTTPException(status_code=404, detail="Entity not found")

    # Get portfolio value - filtered by entity if specified
    if entity_id:
        summary = db.get_portfolio_summary_by_entity(entity_id)
    else:
        summary = db.get_portfolio_summary()
    total_value = summary["total_value"]

    # Get personal settings
    config = load_config()
    personal = config.get("personal", {})

    withdrawal_rate = personal.get("withdrawal_rate", 4)  # Default 4%
    target_monthly_income = personal.get("target_monthly_income", 0)
    retirement_age = personal.get("retirement_age", 65)

    # Calculate current age from DOB
    current_age = None
    dob_str = personal.get("dob")
    if dob_str:
        try:
            dob = datetime.strptime(dob_str, "%Y-%m-%d").date()
            today = date.today()
            current_age = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
        except ValueError:
            pass

    # Get latest Monte Carlo result - filtered by entity if specified
    if entity_id:
        latest_mc = db.get_latest_monte_carlo_result_by_entity(entity_id)
    else:
        latest_mc = db.get_latest_monte_carlo_result()

    # Initialize values that require simulation
    monthly_retirement_income = None
    success_probability = None
    earliest_retirement_age = None
    last_simulation_date = None
    projected_value_at_retirement = None
    conservative_value_at_retirement = None
    fire_number = None
    simulation_required = True

    if latest_mc:
        simulation_required = False
        success_probability = latest_mc.success_rate
        earliest_retirement_age = int(latest_mc.earliest_retirement_age) if latest_mc.earliest_retirement_age else None
        last_simulation_date = latest_mc.run_date.isoformat() if latest_mc.run_date else None

        # Get projected value at retirement from simulation
        projected_value_at_retirement = latest_mc.projected_value_at_retirement
        conservative_value_at_retirement = latest_mc.conservative_value_at_retirement

        # Calculate monthly retirement income from PROJECTED value at retirement
        # Use conservative estimate (25th percentile) for safer planning
        if conservative_value_at_retirement:
            annual_income = conservative_value_at_retirement * (withdrawal_rate / 100)
            monthly_retirement_income = annual_income / 12

        # Calculate FIRE number
        if target_monthly_income > 0:
            # FIRE number = annual target income / withdrawal rate
            fire_number = target_monthly_income / (withdrawal_rate / 100)
        elif monthly_retirement_income:
            # No specific target - calculate what they'd need for their projected income
            fire_number = conservative_value_at_retirement
        else:
            fire_number = None

    return DashboardMetricsResponse(
        monthly_retirement_income=round(monthly_retirement_income, 2) if monthly_retirement_income else None,
        withdrawal_rate=withdrawal_rate,
        success_probability=round(success_probability * 100, 1) if success_probability is not None else None,
        earliest_retirement_age=earliest_retirement_age,
        fire_number=round(fire_number, 2) if fire_number else None,
        current_age=current_age,
        target_retirement_age=retirement_age,
        target_monthly_income=target_monthly_income if target_monthly_income > 0 else None,
        last_simulation_date=last_simulation_date,
        total_portfolio_value=round(total_value, 2),
        projected_value_at_retirement=round(projected_value_at_retirement, 2) if projected_value_at_retirement else None,
        conservative_value_at_retirement=round(conservative_value_at_retirement, 2) if conservative_value_at_retirement else None,
        simulation_required=simulation_required,
    )
