"""
Schwab CSV Importer Plugin

Imports positions from Charles Schwab CSV exports.
Schwab exports have a specific format with header rows that need
to be skipped and specific column naming conventions.
"""

import logging
import re
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from src.plugins.base import (
    ImporterPlugin,
    ImportResult,
    PluginManifest,
)

logger = logging.getLogger(__name__)

# Schwab-specific column mappings
SCHWAB_COLUMNS = {
    "ticker": "Symbol",
    "name": "Description",
    "shares": "Quantity",
    "price": "Price",
    "market_value": "Market Value",
    "cost_basis": "Cost Basis",
    "gain_loss": "Gain/Loss $",
    "gain_loss_pct": "Gain/Loss %",
}

# Alternative column names (older Schwab formats)
SCHWAB_COLUMN_ALIASES = {
    "ticker": ["Symbol", "Sym"],
    "shares": ["Quantity", "Qty", "Qty (Quantity)"],
    "price": ["Price", "Last Price", "Price ($)"],
    "market_value": ["Market Value", "Mkt Val", "Mkt Val (Market Value)"],
    "cost_basis": ["Cost Basis", "Cost Basis Total"],
}

# Symbols to skip
SKIP_SYMBOLS = {
    "cash", "total", "pending activity", "account total",
    "cash & cash investments", "--", "n/a", "",
    "schwab bank sweep", "schwab money",
}


class SchwabCSVImporter(ImporterPlugin):
    """Importer for Charles Schwab CSV position exports."""

    def can_handle(self, file_path: Path, content_preview: bytes) -> float:
        """
        Return confidence score for handling this file.

        Schwab files start with "Positions for account" header.
        """
        if file_path.suffix.lower() != ".csv":
            return 0.0

        try:
            preview_text = content_preview.decode("utf-8", errors="ignore")
            first_line = preview_text.split("\n")[0] if preview_text else ""

            # Schwab exports start with "Positions for account"
            if first_line.startswith('"Positions for account'):
                return 0.95  # Very high confidence

            # Check for Schwab-specific column names
            preview_lower = preview_text.lower()
            schwab_indicators = [
                "schwab", "qty (quantity)", "mkt val (market value)",
                "cost basis total", "gain/loss"
            ]

            matches = sum(1 for ind in schwab_indicators if ind in preview_lower)
            if matches >= 2:
                return 0.8  # High confidence

            return 0.0

        except Exception:
            return 0.0

    def import_file(self, file_path: Path, account_type: str) -> ImportResult:
        """Import positions from Schwab CSV file."""
        try:
            # Load the file, skipping Schwab header rows
            df = self._load_schwab_file(file_path)
            if df is None or df.empty:
                return ImportResult(
                    success=False,
                    message=f"Could not load Schwab file: {file_path.name}",
                    errors=["File is empty or format not recognized"],
                )

            # Map columns to standard names
            column_map = self._map_columns(df)
            if "ticker" not in column_map:
                return ImportResult(
                    success=False,
                    message="Could not find Symbol column in Schwab export",
                    errors=[f"Columns found: {list(df.columns)}"],
                )

            # Extract account name from header if available
            account_name = self._extract_account_name(file_path)

            # Process rows
            positions = []
            warnings = []

            for idx, row in df.iterrows():
                try:
                    position = self._extract_position(row, column_map)
                    if position:
                        positions.append(position)
                except Exception as e:
                    warnings.append(f"Row {idx + 1}: {str(e)}")

            return ImportResult(
                success=True,
                positions=positions,
                account_name=account_name,
                message=f"Imported {len(positions)} positions from Schwab",
                warnings=warnings[:10],
            )

        except Exception as e:
            logger.exception(f"Error importing Schwab file {file_path}: {e}")
            return ImportResult(
                success=False,
                message=f"Import failed: {str(e)}",
                errors=[str(e)],
            )

    def _load_schwab_file(self, file_path: Path) -> Optional[pd.DataFrame]:
        """Load Schwab CSV file, handling their specific format."""
        try:
            # First, detect if it's the standard Schwab format
            with open(file_path, "r", encoding="utf-8") as f:
                first_line = f.readline()

            if first_line.startswith('"Positions for account'):
                # Standard Schwab format: skip first 2 rows
                # Row 1: "Positions for account XXXX-XXXX..."
                # Row 2: blank line
                # Row 3: Column headers
                return pd.read_csv(file_path, skiprows=2)
            else:
                # Try standard CSV
                return pd.read_csv(file_path)

        except Exception as e:
            logger.error(f"Error loading Schwab file {file_path}: {e}")
            return None

    def _extract_account_name(self, file_path: Path) -> Optional[str]:
        """Extract account name from Schwab file header."""
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                first_line = f.readline()

            # Parse "Positions for account XXXX-XXXX as of..."
            match = re.search(r'Positions for account\s+([^"]+)', first_line)
            if match:
                account_info = match.group(1).strip()
                # Extract just the account identifier
                parts = account_info.split(" as of")
                return f"Schwab {parts[0].strip()}" if parts else None

        except Exception:
            pass
        return None

    def _map_columns(self, df: pd.DataFrame) -> dict[str, str]:
        """Map Schwab columns to standard field names."""
        column_map = {}
        df_columns = {str(col).lower().strip(): col for col in df.columns}

        for field, aliases in SCHWAB_COLUMN_ALIASES.items():
            for alias in aliases:
                alias_lower = alias.lower()
                if alias_lower in df_columns:
                    column_map[field] = df_columns[alias_lower]
                    break

        # Also check for name/description
        for col in df.columns:
            col_lower = str(col).lower()
            if "description" in col_lower and "name" not in column_map:
                column_map["name"] = col
            elif "security" in col_lower and "name" not in column_map:
                column_map["name"] = col

        return column_map

    def _extract_position(
        self,
        row: pd.Series,
        column_map: dict[str, str],
    ) -> Optional[dict]:
        """Extract position data from a Schwab row."""
        # Get ticker
        ticker_col = column_map.get("ticker")
        if not ticker_col:
            return None

        ticker = str(row.get(ticker_col, "")).strip().upper()

        # Skip non-position rows
        if not ticker or ticker.lower() in SKIP_SYMBOLS:
            return None

        # Skip cash/money market
        if any(skip in ticker.lower() for skip in ["sweep", "money market"]):
            return None

        # Get shares
        shares_col = column_map.get("shares")
        shares = self._parse_number(row.get(shares_col)) if shares_col else None

        if shares is None or shares <= 0:
            return None

        # Get other fields
        name_col = column_map.get("name")
        name = str(row.get(name_col, ticker)).strip() if name_col else ticker

        price_col = column_map.get("price")
        price = self._parse_number(row.get(price_col)) if price_col else None

        cost_basis_col = column_map.get("cost_basis")
        cost_basis = self._parse_number(row.get(cost_basis_col)) if cost_basis_col else None

        # Determine if fund
        is_fund = self._is_fund(ticker, name)

        return {
            "ticker": ticker,
            "shares": shares,
            "name": name,
            "price": price,
            "cost_basis": cost_basis,
            "is_fund": is_fund,
        }

    def _parse_number(self, value: Any) -> Optional[float]:
        """Parse a numeric value from Schwab format."""
        if value is None or pd.isna(value):
            return None

        if isinstance(value, (int, float)):
            return float(value)

        try:
            cleaned = str(value).strip()
            # Remove $, commas, and whitespace
            cleaned = re.sub(r"[$,\s]", "", cleaned)

            # Handle parentheses for negative (common in Schwab)
            if cleaned.startswith("(") and cleaned.endswith(")"):
                cleaned = "-" + cleaned[1:-1]

            # Handle N/A
            if cleaned.lower() in ["n/a", "--", ""]:
                return None

            return float(cleaned)

        except (ValueError, TypeError):
            return None

    def _is_fund(self, ticker: str, name: str) -> bool:
        """Determine if position is a fund/ETF."""
        name_lower = name.lower()
        fund_indicators = ["etf", "fund", "index", "trust", "portfolio", "ishares", "vanguard", "spdr"]
        return any(ind in name_lower for ind in fund_indicators)

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "importer",
            "formats": [".csv"],
            "description": "Charles Schwab position export importer",
            "brokerage": "schwab",
        }
