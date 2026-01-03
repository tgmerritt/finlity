#!/usr/bin/env python3
"""
Script to update cost_basis for existing positions from Schwab CSV files.

This script reads Schwab CSV files and updates positions that have NULL cost_basis
with calculated values from the Cost/Share column.

Usage:
    python scripts/update_cost_basis.py

Or via Docker:
    docker exec -it portfolio-analyzer python scripts/update_cost_basis.py
"""

import re
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pandas as pd
from src.database import get_database


def parse_number(value) -> float:
    """Parse a number from various formats."""
    if value is None or pd.isna(value):
        return 0.0

    if isinstance(value, (int, float)):
        return float(value)

    cleaned = str(value).strip()
    # Remove $, commas, whitespace
    cleaned = re.sub(r"[$,\s]", "", cleaned)

    # Handle N/A
    if cleaned.lower() in ["n/a", "--", ""]:
        return 0.0

    try:
        return float(cleaned)
    except (ValueError, TypeError):
        return 0.0


def update_from_csv(db, csv_path: Path) -> int:
    """Update positions from a Schwab CSV file."""
    updates = 0

    try:
        # Read the file, skipping Schwab header rows
        with open(csv_path, "r", encoding="utf-8") as f:
            first_line = f.readline()

        skip_rows = 2 if first_line.startswith('"Positions for account') else 0
        df = pd.read_csv(csv_path, skiprows=skip_rows)

        # Find the relevant columns
        columns = {col.lower().strip(): col for col in df.columns}

        ticker_col = None
        shares_col = None
        cost_per_share_col = None

        for col_name, orig_col in columns.items():
            if 'symbol' in col_name:
                ticker_col = orig_col
            elif 'qty' in col_name or 'quantity' in col_name:
                shares_col = orig_col
            elif 'cost/share' in col_name or 'cost per share' in col_name:
                cost_per_share_col = orig_col

        if not all([ticker_col, shares_col, cost_per_share_col]):
            print(f"  Skipping {csv_path.name}: Missing required columns")
            print(f"    Found: ticker={ticker_col}, shares={shares_col}, cost_per_share={cost_per_share_col}")
            return 0

        print(f"  Processing {csv_path.name}...")
        print(f"    Using columns: {ticker_col}, {shares_col}, {cost_per_share_col}")

        # Load all positions once for efficiency
        all_positions = db.get_all_positions()

        # Process each row
        for _, row in df.iterrows():
            ticker = str(row.get(ticker_col, "")).strip().upper()
            if not ticker or ticker.lower() in ["cash", "total", "--", "n/a", "account total", "cash & cash investments"]:
                continue

            shares = parse_number(row.get(shares_col))
            cost_per_share = parse_number(row.get(cost_per_share_col))

            if shares <= 0 or cost_per_share <= 0:
                continue

            cost_basis = cost_per_share * shares

            # Update positions with NULL cost_basis
            # Filter by ticker from pre-loaded positions
            matching_positions = [p for p in all_positions if p.ticker.upper() == ticker]

            for pos in matching_positions:
                if pos.cost_basis is None or pos.cost_basis == 0:
                    # Match by shares (approximately - within 1%)
                    if abs(pos.shares - shares) / max(shares, 0.01) < 0.01:
                        db.update_position(
                            pos.id,
                            cost_basis=cost_basis
                        )
                        print(f"    Updated {ticker}: {shares:.4f} shares, cost_basis=${cost_basis:.2f}")
                        updates += 1

        return updates

    except Exception as e:
        print(f"  Error processing {csv_path.name}: {e}")
        return 0


def main():
    print("=" * 60)
    print("Cost Basis Update Script")
    print("=" * 60)

    db = get_database()

    # Find all CSV files in import folders
    imports_dir = Path("data/imports")
    if not imports_dir.exists():
        print(f"Imports directory not found: {imports_dir}")
        return

    csv_files = list(imports_dir.rglob("*.csv"))
    print(f"\nFound {len(csv_files)} CSV files to process\n")

    total_updates = 0
    for csv_path in csv_files:
        updates = update_from_csv(db, csv_path)
        total_updates += updates

    print(f"\n{'=' * 60}")
    print(f"Total positions updated: {total_updates}")
    print("=" * 60)


if __name__ == "__main__":
    main()
