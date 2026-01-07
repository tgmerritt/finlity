#!/usr/bin/env python3
"""
Generate a test portfolio database for local file picker testing.

This creates a database with different data than demo.db for testing
the local file functionality on Heroku.

NOTE: This file and its output are NOT committed to git.
The generated database is at data/test_portfolio.db.

Usage:
    python scripts/generate_test_db.py
"""

import sys
from pathlib import Path

# Add project root to path for imports
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from src.database import Base, Entity, Account, Position, Database


# Test data - intentionally different from demo.db
TEST_ENTITIES = [
    {
        "id": "test-user-1",
        "name": "Test User",
        "entity_type": "individual",
        "is_default": True,
        "is_household": False,
        "color": "#4A90D9",
        "icon": "user",
    },
]

TEST_ACCOUNTS = [
    {
        "id": "test-brokerage",
        "entity_id": "test-user-1",
        "name": "Test Brokerage",
        "account_type": "taxable",
        "brokerage": "E*TRADE",
    },
    {
        "id": "test-401k",
        "entity_id": "test-user-1",
        "name": "Test 401k",
        "account_type": "traditional_401k",
        "brokerage": "Merrill",
        "is_retirement_account": True,
    },
]

# Different tickers than demo.db (which uses VOO, VTI, BND, VXUS, etc.)
TEST_POSITIONS = [
    # Test Brokerage positions
    {
        "account_id": "test-brokerage",
        "ticker": "SPY",
        "name": "SPDR S&P 500 ETF Trust",
        "shares": 15.0,
        "current_price": 580.00,
        "cost_basis": 8000.00,
        "is_fund": True,
        "asset_class": "equity",
        "position_type": "fund",
    },
    {
        "account_id": "test-brokerage",
        "ticker": "GLD",
        "name": "SPDR Gold Shares",
        "shares": 10.0,
        "current_price": 240.00,
        "cost_basis": 2200.00,
        "is_fund": True,
        "asset_class": "alternative",
        "position_type": "fund",
    },
    {
        "account_id": "test-brokerage",
        "ticker": "DIS",
        "name": "Walt Disney Co",
        "shares": 12.0,
        "current_price": 115.00,
        "cost_basis": 1200.00,
        "is_fund": False,
        "asset_class": "equity",
        "position_type": "equity",
    },
    {
        "account_id": "test-brokerage",
        "ticker": "KO",
        "name": "Coca-Cola Company",
        "shares": 30.0,
        "current_price": 62.00,
        "cost_basis": 1700.00,
        "is_fund": False,
        "asset_class": "equity",
        "position_type": "equity",
    },
    # Test 401k positions
    {
        "account_id": "test-401k",
        "ticker": "IWM",
        "name": "iShares Russell 2000 ETF",
        "shares": 20.0,
        "current_price": 220.00,
        "cost_basis": 4000.00,
        "is_fund": True,
        "asset_class": "equity",
        "position_type": "fund",
    },
    {
        "account_id": "test-401k",
        "ticker": "TLT",
        "name": "iShares 20+ Year Treasury Bond ETF",
        "shares": 25.0,
        "current_price": 92.00,
        "cost_basis": 2100.00,
        "is_fund": True,
        "asset_class": "fixed_income",
        "position_type": "fund",
    },
]


def generate_test_database(output_path: str = "data/test_portfolio.db") -> str:
    """Generate a test database with fake portfolio data.

    Args:
        output_path: Path to the output database file.

    Returns:
        Path to the generated database.
    """
    db_path = Path(output_path)

    # Remove existing database if present
    if db_path.exists():
        db_path.unlink()
        print(f"Removed existing database: {db_path}")

    # Ensure parent directory exists
    db_path.parent.mkdir(parents=True, exist_ok=True)

    # Create database and initialize schema
    db = Database(str(db_path))

    # Create schema
    with db.get_session() as session:
        Base.metadata.create_all(session.get_bind())

    # Add entities
    with db.get_session() as session:
        for entity_data in TEST_ENTITIES:
            entity = Entity(**entity_data)
            session.add(entity)
        session.commit()
        print(f"Created {len(TEST_ENTITIES)} entity/entities")

    # Add accounts
    with db.get_session() as session:
        for account_data in TEST_ACCOUNTS:
            account = Account(**account_data)
            session.add(account)
        session.commit()
        print(f"Created {len(TEST_ACCOUNTS)} accounts")

    # Add positions
    with db.get_session() as session:
        for position_data in TEST_POSITIONS:
            position = Position(**position_data)
            session.add(position)
        session.commit()
        print(f"Created {len(TEST_POSITIONS)} positions")

    # Calculate and print summary
    total_value = sum(
        p["shares"] * p["current_price"] for p in TEST_POSITIONS
    )
    total_cost = sum(p["cost_basis"] for p in TEST_POSITIONS)
    total_gain = total_value - total_cost

    print(f"\n{'='*50}")
    print(f"Test database created: {db_path}")
    print(f"{'='*50}")
    print(f"  Entities:  {len(TEST_ENTITIES)}")
    print(f"  Accounts:  {len(TEST_ACCOUNTS)}")
    print(f"  Positions: {len(TEST_POSITIONS)}")
    print(f"  Total Value: ${total_value:,.2f}")
    print(f"  Total Cost:  ${total_cost:,.2f}")
    gain_pct = (total_gain / total_cost * 100) if total_cost > 0 else 0
    print(f"  Total Gain:  ${total_gain:,.2f} ({gain_pct:.1f}%)")
    print("\nUse this file to test the local file picker on Heroku.")
    print("NOTE: This file is NOT committed to git.")

    return str(db_path)


if __name__ == "__main__":
    generate_test_database()
