#!/usr/bin/env python3
"""
Generate demo portfolio data for demonstration purposes.

This script creates a realistic fake portfolio with:
- Multiple account types (401k, IRA, taxable, HSA, 529)
- ~50 diversified positions across various asset classes
- Real current prices fetched via multiple APIs with fallbacks
- CDs and cash with APY

Usage:
    python scripts/generate_demo.py

Can also be triggered via API: POST /api/demo/generate
"""

import random
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import yaml

from src.database import Database
from src.database.models import (
    Account,
    Position,
    BudgetIncomeSource,
    BudgetPretaxDeduction,
    BudgetExpense,
    BudgetExpenseCategory,
)


# Demo portfolio structure
DEMO_ACCOUNTS = [
    {
        "name": "Company 401k",
        "account_type": "traditional_401k",
        "brokerage": "Fidelity",
    },
    {
        "name": "Roth IRA",
        "account_type": "roth_ira",
        "brokerage": "Schwab",
    },
    {
        "name": "Traditional IRA",
        "account_type": "traditional_ira",
        "brokerage": "Vanguard",
    },
    {
        "name": "Taxable Brokerage",
        "account_type": "taxable",
        "brokerage": "Schwab",
    },
    {
        "name": "Health Savings Account",
        "account_type": "hsa",
        "brokerage": "Fidelity",
    },
    {
        "name": "College 529",
        "account_type": "529",
        "brokerage": "Vanguard",
    },
]

# Demo positions - diversified across asset classes
# Format: (ticker, name, is_fund, position_type, target_value_range)
DEMO_POSITIONS = [
    # US Large Cap Index Funds
    ("VTI", "Vanguard Total Stock Market ETF", True, "fund", (25000, 45000)),
    ("VOO", "Vanguard S&P 500 ETF", True, "fund", (20000, 40000)),
    ("SWPPX", "Schwab S&P 500 Index Fund", True, "fund", (15000, 30000)),
    ("FXAIX", "Fidelity 500 Index Fund", True, "fund", (20000, 35000)),

    # US Growth/Tech
    ("QQQ", "Invesco QQQ Trust", True, "fund", (10000, 25000)),
    ("VGT", "Vanguard Information Technology ETF", True, "fund", (8000, 18000)),
    ("ARKK", "ARK Innovation ETF", True, "fund", (3000, 8000)),

    # US Mid/Small Cap
    ("VXF", "Vanguard Extended Market ETF", True, "fund", (5000, 12000)),
    ("IJR", "iShares Core S&P Small-Cap ETF", True, "fund", (4000, 10000)),
    ("VB", "Vanguard Small-Cap ETF", True, "fund", (5000, 12000)),

    # International Developed
    ("VXUS", "Vanguard Total International Stock ETF", True, "fund", (15000, 30000)),
    ("VEA", "Vanguard FTSE Developed Markets ETF", True, "fund", (8000, 18000)),
    ("EFA", "iShares MSCI EAFE ETF", True, "fund", (6000, 14000)),

    # Emerging Markets
    ("VWO", "Vanguard FTSE Emerging Markets ETF", True, "fund", (5000, 12000)),
    ("IEMG", "iShares Core MSCI Emerging Markets ETF", True, "fund", (4000, 10000)),

    # Bonds & Fixed Income
    ("BND", "Vanguard Total Bond Market ETF", True, "fund", (8000, 20000)),
    ("VGIT", "Vanguard Intermediate-Term Treasury ETF", True, "fund", (5000, 12000)),
    ("VTIP", "Vanguard Short-Term Inflation-Protected Securities ETF", True, "fund", (3000, 8000)),
    ("AGG", "iShares Core U.S. Aggregate Bond ETF", True, "fund", (5000, 12000)),

    # Real Estate
    ("VNQ", "Vanguard Real Estate ETF", True, "fund", (4000, 10000)),
    ("SCHH", "Schwab U.S. REIT ETF", True, "fund", (3000, 8000)),

    # Dividend/Value
    ("VYM", "Vanguard High Dividend Yield ETF", True, "fund", (5000, 12000)),
    ("SCHD", "Schwab US Dividend Equity ETF", True, "fund", (6000, 14000)),
    ("VTV", "Vanguard Value ETF", True, "fund", (4000, 10000)),

    # Individual Stocks - Tech
    ("AAPL", "Apple Inc.", False, "equity", (5000, 15000)),
    ("MSFT", "Microsoft Corporation", False, "equity", (5000, 15000)),
    ("GOOGL", "Alphabet Inc.", False, "equity", (4000, 12000)),
    ("NVDA", "NVIDIA Corporation", False, "equity", (5000, 18000)),
    ("META", "Meta Platforms Inc.", False, "equity", (3000, 10000)),
    ("AMZN", "Amazon.com Inc.", False, "equity", (4000, 12000)),

    # Individual Stocks - Healthcare
    ("JNJ", "Johnson & Johnson", False, "equity", (3000, 8000)),
    ("UNH", "UnitedHealth Group Inc.", False, "equity", (3000, 9000)),
    ("LLY", "Eli Lilly and Company", False, "equity", (4000, 12000)),

    # Individual Stocks - Financial
    ("JPM", "JPMorgan Chase & Co.", False, "equity", (3000, 8000)),
    ("V", "Visa Inc.", False, "equity", (3000, 9000)),
    ("BRK-B", "Berkshire Hathaway Inc.", False, "equity", (4000, 10000)),

    # Individual Stocks - Consumer
    ("COST", "Costco Wholesale Corporation", False, "equity", (3000, 8000)),
    ("HD", "The Home Depot Inc.", False, "equity", (2500, 7000)),

    # Individual Stocks - Industrial/Energy
    ("CAT", "Caterpillar Inc.", False, "equity", (2000, 6000)),
    ("XOM", "Exxon Mobil Corporation", False, "equity", (2500, 7000)),

    # Treasury/Cash Equivalents
    ("SGOV", "iShares 0-3 Month Treasury Bond ETF", True, "fund", (5000, 15000)),
    ("BIL", "SPDR Bloomberg 1-3 Month T-Bill ETF", True, "fund", (3000, 10000)),
    ("SHV", "iShares Short Treasury Bond ETF", True, "fund", (3000, 8000)),
]

# CD positions to add (these don't have yfinance prices)
DEMO_CDS = [
    ("12-Month CD", 10000, 0.0495, 12),  # name, amount, APY, months to maturity
    ("18-Month CD", 15000, 0.0475, 18),
    ("6-Month CD", 8000, 0.0450, 6),
]

# Cash positions with APY
DEMO_CASH = [
    ("Settlement Cash", 5000, 0.0425),  # name, amount, APY
    ("HYSA Cash Reserve", 12000, 0.0485),
]

# Demo budget data - income sources
DEMO_INCOME_SOURCES = [
    {"name": "John's Primary Job", "income_type": "employment", "gross_annual": 145000, "pay_frequency": "biweekly", "state": "CA"},
    {"name": "Jane's Primary Job", "income_type": "employment", "gross_annual": 115000, "pay_frequency": "biweekly", "state": "CA"},
]

# Demo budget data - pre-tax deductions with labels
DEMO_DEDUCTIONS = [
    {"label": "John's 401k", "deduction_type": "401k", "amount_per_period": 750, "employer_match": 300},
    {"label": "Jane's 401k", "deduction_type": "401k", "amount_per_period": 500, "employer_match": 200},
    {"label": "Family HSA", "deduction_type": "hsa", "amount_per_period": 150, "employer_match": 0},
    {"label": "John's Dental", "deduction_type": "dental", "amount_per_period": 25, "employer_match": 0},
    {"label": "Jane's Dental", "deduction_type": "dental", "amount_per_period": 25, "employer_match": 0},
]

# Demo budget data - expenses (category_id matches default categories)
DEMO_EXPENSES = [
    {"category_id": 1, "name": "Mortgage", "amount": 3200, "frequency": "monthly"},
    {"category_id": 1, "name": "Property Tax", "amount": 850, "frequency": "monthly"},
    {"category_id": 1, "name": "Home Insurance", "amount": 180, "frequency": "monthly"},
    {"category_id": 2, "name": "Electric", "amount": 200, "frequency": "monthly"},
    {"category_id": 2, "name": "Gas", "amount": 80, "frequency": "monthly"},
    {"category_id": 2, "name": "Water/Sewer", "amount": 75, "frequency": "monthly"},
    {"category_id": 2, "name": "Internet", "amount": 85, "frequency": "monthly"},
    {"category_id": 3, "name": "Car Payment #1", "amount": 450, "frequency": "monthly"},
    {"category_id": 3, "name": "Car Insurance", "amount": 180, "frequency": "monthly"},
    {"category_id": 3, "name": "Gas/Fuel", "amount": 250, "frequency": "monthly"},
    {"category_id": 4, "name": "Life Insurance", "amount": 85, "frequency": "monthly"},
    {"category_id": 4, "name": "Umbrella Policy", "amount": 35, "frequency": "monthly"},
    {"category_id": 7, "name": "Groceries", "amount": 800, "frequency": "monthly"},
    {"category_id": 7, "name": "Dining Out", "amount": 400, "frequency": "monthly"},
    {"category_id": 8, "name": "Streaming Services", "amount": 65, "frequency": "monthly"},
    {"category_id": 10, "name": "Cell Phones", "amount": 140, "frequency": "monthly"},
]

# Fallback prices (approximate recent prices as of late 2024)
# Used if all API sources fail
FALLBACK_PRICES = {
    "VTI": 290.00, "VOO": 540.00, "SWPPX": 85.00, "FXAIX": 200.00,
    "QQQ": 520.00, "VGT": 600.00, "ARKK": 55.00,
    "VXF": 175.00, "IJR": 115.00, "VB": 225.00,
    "VXUS": 62.00, "VEA": 50.00, "EFA": 82.00,
    "VWO": 45.00, "IEMG": 55.00,
    "BND": 72.00, "VGIT": 60.00, "VTIP": 50.00, "AGG": 98.00,
    "VNQ": 95.00, "SCHH": 22.00,
    "VYM": 125.00, "SCHD": 82.00, "VTV": 165.00,
    "AAPL": 250.00, "MSFT": 430.00, "GOOGL": 190.00, "NVDA": 140.00,
    "META": 600.00, "AMZN": 225.00,
    "JNJ": 145.00, "UNH": 590.00, "LLY": 790.00,
    "JPM": 245.00, "V": 315.00, "BRK-B": 465.00,
    "COST": 950.00, "HD": 410.00,
    "CAT": 390.00, "XOM": 110.00,
    "SGOV": 100.50, "BIL": 91.70, "SHV": 110.00,
}


def fetch_prices_with_service(tickers: list[str]) -> dict[str, float]:
    """Fetch current prices using PriceService with multiple fallbacks."""
    from src.data.prices import PriceService

    print(f"Fetching prices for {len(tickers)} tickers...")
    prices = {}
    failed = []

    # Initialize price service
    price_service = PriceService()

    for ticker in tickers:
        try:
            price_data = price_service.get_current_price(ticker)
            if price_data and price_data.current_price > 0:
                prices[ticker] = price_data.current_price
                print(f"  {ticker}: ${price_data.current_price:.2f}")
            else:
                failed.append(ticker)
        except Exception as e:
            print(f"  Failed to get {ticker}: {e}")
            failed.append(ticker)

    # Use fallback prices for any failures
    if failed:
        print(f"\nUsing fallback prices for {len(failed)} tickers...")
        for ticker in failed:
            if ticker in FALLBACK_PRICES:
                prices[ticker] = FALLBACK_PRICES[ticker]
                print(f"  {ticker}: ${FALLBACK_PRICES[ticker]:.2f} (fallback)")
            else:
                print(f"  {ticker}: No fallback price available")

    print(f"\nGot prices for {len(prices)}/{len(tickers)} tickers")
    return prices


def generate_demo_data(db_path: Optional[str] = None) -> dict:
    """Generate demo portfolio data.

    Args:
        db_path: Optional path to demo database. If not provided, reads from config.

    Returns:
        dict with generation results
    """
    print("\n" + "=" * 50)
    print("DEMO DATA GENERATOR")
    print("=" * 50)

    # Ensure demo directory exists
    demo_dir = Path("data/demo")
    demo_dir.mkdir(parents=True, exist_ok=True)

    # Load config to get demo db path if not provided
    if not db_path:
        config_path = Path("config.yaml")
        if config_path.exists():
            with open(config_path) as f:
                config = yaml.safe_load(f)
        else:
            config = {}
        db_path = config.get("demo", {}).get("database", "data/demo/demo.db")

    # Delete existing demo db if exists
    db_file = Path(db_path)
    if db_file.exists():
        print(f"\nRemoving existing demo database: {db_path}")
        db_file.unlink()

    # Initialize demo database
    print(f"Creating demo database: {db_path}")
    db = Database(db_path)

    # Create accounts
    print("\nCreating demo accounts...")
    accounts = {}
    for acc_data in DEMO_ACCOUNTS:
        account = Account(
            name=acc_data["name"],
            account_type=acc_data["account_type"],
            brokerage=acc_data["brokerage"],
        )
        with db.get_session() as session:
            session.add(account)
            session.commit()
            session.refresh(account)
            accounts[acc_data["name"]] = account.id
        print(f"  Created: {acc_data['name']} ({acc_data['account_type']})")

    # Fetch real prices using PriceService
    tickers = [pos[0] for pos in DEMO_POSITIONS]
    prices = fetch_prices_with_service(tickers)

    # Assign positions to accounts strategically
    account_names = list(accounts.keys())
    print("\nCreating positions...")

    total_value = 0
    positions_created = 0

    for ticker, name, is_fund, pos_type, value_range in DEMO_POSITIONS:
        if ticker not in prices:
            print(f"  Skipping {ticker} - no price available")
            continue

        price = prices[ticker]
        target_value = random.uniform(value_range[0], value_range[1])
        shares = round(target_value / price, 4)
        actual_value = shares * price

        # Cost basis with slight variation (simulating purchase over time)
        cost_basis_factor = random.uniform(0.75, 1.1)
        cost_basis = round(actual_value * cost_basis_factor, 2)

        # Assign to an account (favor retirement accounts)
        if is_fund:
            # Funds go to retirement accounts primarily
            account_name = random.choice(account_names[:4])
        else:
            # Individual stocks in taxable more often
            account_name = random.choice(account_names)

        position = Position(
            account_id=accounts[account_name],
            ticker=ticker,
            name=name,
            shares=shares,
            cost_basis=cost_basis,
            current_price=price,
            is_fund=is_fund,
            position_type=pos_type,
        )

        with db.get_session() as session:
            session.add(position)
            session.commit()

        total_value += actual_value
        positions_created += 1
        print(f"  {ticker}: {shares:.4f} shares @ ${price:.2f} = ${actual_value:,.0f}")

    # Add CDs to various accounts
    print("\nAdding CD positions...")
    for cd_name, amount, apy, months_to_maturity in DEMO_CDS:
        # Purchase date is some time in the past
        months_held = random.randint(1, max(1, months_to_maturity - 1))
        purchase_date = datetime.now() - timedelta(days=months_held * 30)
        maturity_date = purchase_date + timedelta(days=months_to_maturity * 30)

        account_name = random.choice(["Health Savings Account", "Taxable Brokerage"])

        position = Position(
            account_id=accounts[account_name],
            ticker="CD",
            name=cd_name,
            shares=1,
            cost_basis=amount,
            current_price=amount,
            is_fund=False,
            position_type="cd",
            interest_rate=apy,
            purchase_date=purchase_date,
            maturity_date=maturity_date,
        )

        with db.get_session() as session:
            session.add(position)
            session.commit()

        total_value += amount
        print(f"  {cd_name}: ${amount:,.0f} @ {apy*100:.2f}% APY (matures {maturity_date.date()})")

    # Add cash positions
    print("\nAdding cash positions...")
    for cash_name, amount, apy in DEMO_CASH:
        # Cash in checking/savings type accounts
        account_name = random.choice(["Health Savings Account", "Taxable Brokerage"])

        purchase_date = datetime.now() - timedelta(days=random.randint(30, 180))

        position = Position(
            account_id=accounts[account_name],
            ticker="CASH",
            name=cash_name,
            shares=amount,
            cost_basis=amount,
            current_price=1.0,
            is_fund=False,
            position_type="cash",
            interest_rate=apy if apy > 0 else None,
            purchase_date=purchase_date if apy > 0 else None,
        )

        with db.get_session() as session:
            session.add(position)
            session.commit()

        total_value += amount
        print(f"  {cash_name}: ${amount:,.0f}" + (f" @ {apy*100:.2f}% APY" if apy else ""))

    # Add budget data - expense categories first
    print("\nAdding expense categories...")
    from src.budget.models import DEFAULT_EXPENSE_CATEGORIES
    category_map = {}
    for cat in DEFAULT_EXPENSE_CATEGORIES:
        db_cat = BudgetExpenseCategory(
            name=cat.name,
            icon=cat.icon,
            color=cat.color,
            sort_order=cat.sort_order,
        )
        with db.get_session() as session:
            session.add(db_cat)
            session.commit()
            session.refresh(db_cat)
            category_map[cat.id] = db_cat.id
        print(f"  Category: {cat.name}")

    # Add income sources
    print("\nAdding income sources...")
    for income_data in DEMO_INCOME_SOURCES:
        income = BudgetIncomeSource(
            name=income_data["name"],
            income_type=income_data["income_type"],
            gross_annual=income_data["gross_annual"],
            pay_frequency=income_data["pay_frequency"],
            state=income_data["state"],
        )
        with db.get_session() as session:
            session.add(income)
            session.commit()
        print(f"  {income_data['name']}: ${income_data['gross_annual']:,}/yr")

    # Add pre-tax deductions with labels
    print("\nAdding pre-tax deductions...")
    for ded_data in DEMO_DEDUCTIONS:
        deduction = BudgetPretaxDeduction(
            label=ded_data["label"],
            deduction_type=ded_data["deduction_type"],
            amount_per_period=ded_data["amount_per_period"],
            employer_match=ded_data["employer_match"],
        )
        with db.get_session() as session:
            session.add(deduction)
            session.commit()
        match_str = f" + ${ded_data['employer_match']} match" if ded_data["employer_match"] > 0 else ""  # type: ignore[operator]  # DEMO_DEDUCTIONS literal always defines employer_match as int
        print(f"  {ded_data['label']}: ${ded_data['amount_per_period']}/period{match_str}")

    # Add expenses
    print("\nAdding expenses...")
    for exp_data in DEMO_EXPENSES:
        # Map the default category ID to the actual database ID
        actual_category_id = category_map.get(exp_data["category_id"])
        expense = BudgetExpense(
            category_id=actual_category_id,
            name=exp_data["name"],
            amount=exp_data["amount"],
            frequency=exp_data["frequency"],
        )
        with db.get_session() as session:
            session.add(expense)
            session.commit()
        print(f"  {exp_data['name']}: ${exp_data['amount']}/{exp_data['frequency']}")

    # Take a snapshot
    print("\nTaking portfolio snapshot...")
    db.take_snapshot()

    result = {
        "success": True,
        "database": str(db_path),
        "accounts_created": len(accounts),
        "positions_created": positions_created,
        "total_value": total_value,
        "message": f"Demo data generated successfully with {positions_created} positions worth ${total_value:,.0f}",
    }

    print(f"\n{'=' * 50}")
    print(f"DEMO DATA GENERATION COMPLETE")
    print(f"{'=' * 50}")
    print(f"\nDatabase: {db_path}")
    print(f"Accounts: {len(accounts)}")
    print(f"Positions: {positions_created}")
    print(f"Total Portfolio Value: ${total_value:,.0f}")
    print(f"\nTo use demo mode, either:")
    print(f"  1. Run: python -m src.main --demo")
    print(f"  2. Or set 'demo.enabled: true' in config.yaml")
    print()

    return result


if __name__ == "__main__":
    generate_demo_data()
