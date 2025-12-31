#!/usr/bin/env python3
"""
Generate demo portfolio data for demonstration purposes.

This script creates a realistic fake portfolio with:
- Multiple account types (401k, IRA, taxable, HSA, 529)
- ~50 diversified positions across various asset classes
- Real current prices fetched via yfinance
- CDs and cash with APY

Usage:
    python scripts/generate_demo.py
"""

import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import yaml
import yfinance as yf

from src.database import Database
from src.database.models import Account, Position


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


def fetch_prices(tickers: list[str]) -> dict[str, float]:
    """Fetch current prices for tickers using yfinance."""
    print(f"Fetching prices for {len(tickers)} tickers...")
    prices = {}

    # Batch fetch for efficiency
    try:
        data = yf.download(tickers, period="1d", progress=False)
        if "Close" in data.columns:
            # Multiple tickers
            for ticker in tickers:
                if ticker in data["Close"].columns:
                    price = data["Close"][ticker].iloc[-1]
                    if not pd.isna(price):
                        prices[ticker] = float(price)
        else:
            # Single ticker fallback
            for ticker in tickers:
                try:
                    t = yf.Ticker(ticker)
                    info = t.info
                    price = info.get("regularMarketPrice") or info.get("previousClose")
                    if price:
                        prices[ticker] = float(price)
                except Exception as e:
                    print(f"  Warning: Could not fetch {ticker}: {e}")
    except Exception as e:
        print(f"Batch fetch failed: {e}, trying individual...")
        for ticker in tickers:
            try:
                t = yf.Ticker(ticker)
                info = t.info
                price = info.get("regularMarketPrice") or info.get("previousClose")
                if price:
                    prices[ticker] = float(price)
            except Exception as e:
                print(f"  Warning: Could not fetch {ticker}: {e}")

    print(f"  Got prices for {len(prices)} tickers")
    return prices


def generate_demo_data():
    """Generate demo portfolio data."""
    print("\n" + "=" * 50)
    print("DEMO DATA GENERATOR")
    print("=" * 50)

    # Ensure demo directory exists
    demo_dir = Path("data/demo")
    demo_dir.mkdir(parents=True, exist_ok=True)

    # Load config to get demo db path
    config_path = Path("config.yaml")
    if config_path.exists():
        with open(config_path) as f:
            config = yaml.safe_load(f)
    else:
        config = {}

    demo_db_path = config.get("demo", {}).get("database", "data/demo/demo.db")

    # Delete existing demo db if exists
    db_file = Path(demo_db_path)
    if db_file.exists():
        print(f"\nRemoving existing demo database: {demo_db_path}")
        db_file.unlink()

    # Initialize demo database
    print(f"Creating demo database: {demo_db_path}")
    db = Database(demo_db_path)

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

    # Fetch real prices
    tickers = [pos[0] for pos in DEMO_POSITIONS]
    prices = fetch_prices(tickers)

    # Assign positions to accounts strategically
    account_names = list(accounts.keys())
    print("\nCreating positions...")

    total_value = 0

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

    # Take a snapshot
    print("\nTaking portfolio snapshot...")
    snapshot = db.take_snapshot()

    print(f"\n{'=' * 50}")
    print(f"DEMO DATA GENERATION COMPLETE")
    print(f"{'=' * 50}")
    print(f"\nDatabase: {demo_db_path}")
    print(f"Accounts: {len(accounts)}")
    print(f"Total Portfolio Value: ${total_value:,.0f}")
    print(f"\nTo use demo mode, either:")
    print(f"  1. Run: python -m src.main --demo")
    print(f"  2. Or set 'demo.enabled: true' in config.yaml")
    print()


if __name__ == "__main__":
    import pandas as pd  # Import here to check availability
    generate_demo_data()
