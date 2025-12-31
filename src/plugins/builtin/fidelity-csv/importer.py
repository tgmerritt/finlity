"""
Fidelity CSV Importer Plugin

Imports positions from Fidelity CSV exports.
Fidelity exports have their own format with specific column names
and sometimes multiple accounts in one file.
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

# Fidelity-specific column mappings
FIDELITY_COLUMN_ALIASES = {
    "ticker": ["Symbol", "Ticker"],
    "name": ["Description", "Security Description", "Name"],
    "shares": ["Quantity", "Shares", "Units"],
    "price": ["Last Price", "Current Price", "Price", "Last Price Change"],
    "market_value": ["Current Value", "Market Value", "Value"],
    "cost_basis": ["Cost Basis Total", "Cost Basis", "Total Cost"],
    "cost_per_share": ["Cost Basis Per Share", "Average Cost Basis"],
    "account": ["Account Name", "Account Number", "Account"],
}

# Symbols to skip
SKIP_SYMBOLS = {
    "cash", "total", "pending", "core", "fdrxx", "spaxx", "fcash",
    "pending activity", "", "--", "n/a",
}


class FidelityCSVImporter(ImporterPlugin):
    """Importer for Fidelity CSV position exports."""

    def can_handle(self, file_path: Path, content_preview: bytes) -> float:
        """
        Return confidence score for handling this file.

        Fidelity files have specific indicators in headers.
        """
        if file_path.suffix.lower() != ".csv":
            return 0.0

        try:
            preview_text = content_preview.decode("utf-8", errors="ignore")
            preview_lower = preview_text.lower()

            # Check for Fidelity-specific indicators
            fidelity_indicators = [
                "fidelity", "account name/number",
                "cost basis total", "cost basis per share",
                "last price change", "today's gain/loss",
                "spaxx", "fdrxx",  # Fidelity money market funds
            ]

            matches = sum(1 for ind in fidelity_indicators if ind in preview_lower)

            if matches >= 2:
                return 0.9  # High confidence
            elif matches >= 1:
                return 0.6  # Moderate confidence

            # Check for Fidelity column structure
            if "symbol" in preview_lower and "current value" in preview_lower:
                return 0.5

            return 0.0

        except Exception:
            return 0.0

    def import_file(self, file_path: Path, account_type: str) -> ImportResult:
        """Import positions from Fidelity CSV file."""
        try:
            # Load the file
            df = self._load_fidelity_file(file_path)
            if df is None or df.empty:
                return ImportResult(
                    success=False,
                    message=f"Could not load Fidelity file: {file_path.name}",
                    errors=["File is empty or format not recognized"],
                )

            # Map columns
            column_map = self._map_columns(df)
            if "ticker" not in column_map:
                return ImportResult(
                    success=False,
                    message="Could not find Symbol column in Fidelity export",
                    errors=[f"Columns found: {list(df.columns)}"],
                )

            # Process rows
            positions = []
            warnings = []
            account_name = None

            for idx, row in df.iterrows():
                try:
                    # Try to get account name from row
                    if account_name is None and "account" in column_map:
                        acc_val = row.get(column_map["account"])
                        if acc_val and pd.notna(acc_val):
                            account_name = f"Fidelity {str(acc_val).strip()}"

                    position = self._extract_position(row, column_map)
                    if position:
                        positions.append(position)
                except Exception as e:
                    warnings.append(f"Row {idx + 1}: {str(e)}")

            return ImportResult(
                success=True,
                positions=positions,
                account_name=account_name,
                message=f"Imported {len(positions)} positions from Fidelity",
                warnings=warnings[:10],
            )

        except Exception as e:
            logger.exception(f"Error importing Fidelity file {file_path}: {e}")
            return ImportResult(
                success=False,
                message=f"Import failed: {str(e)}",
                errors=[str(e)],
            )

    def _load_fidelity_file(self, file_path: Path) -> Optional[pd.DataFrame]:
        """Load Fidelity CSV file."""
        try:
            # First, check if there are header rows to skip
            with open(file_path, "r", encoding="utf-8") as f:
                lines = f.readlines()

            # Find where the actual data starts (look for column headers)
            skip_rows = 0
            for i, line in enumerate(lines[:10]):  # Check first 10 lines
                line_lower = line.lower()
                if "symbol" in line_lower or "ticker" in line_lower:
                    skip_rows = i
                    break

            return pd.read_csv(file_path, skiprows=skip_rows)

        except Exception as e:
            logger.error(f"Error loading Fidelity file {file_path}: {e}")
            return None

    def _map_columns(self, df: pd.DataFrame) -> dict[str, str]:
        """Map Fidelity columns to standard field names."""
        column_map = {}
        df_columns = {str(col).lower().strip(): col for col in df.columns}

        for field, aliases in FIDELITY_COLUMN_ALIASES.items():
            for alias in aliases:
                alias_lower = alias.lower()
                # Check for exact match
                if alias_lower in df_columns:
                    column_map[field] = df_columns[alias_lower]
                    break
                # Check for partial match
                for col_lower, col_orig in df_columns.items():
                    if alias_lower in col_lower:
                        column_map[field] = col_orig
                        break
                if field in column_map:
                    break

        return column_map

    def _extract_position(
        self,
        row: pd.Series,
        column_map: dict[str, str],
    ) -> Optional[dict]:
        """Extract position data from a Fidelity row."""
        # Get ticker
        ticker_col = column_map.get("ticker")
        if not ticker_col:
            return None

        ticker = str(row.get(ticker_col, "")).strip().upper()

        # Skip non-position rows
        if not ticker or ticker.lower() in SKIP_SYMBOLS:
            return None

        # Skip Fidelity money market funds (they're cash equivalents)
        if ticker in ["SPAXX", "FDRXX", "FCASH", "FZFXX"]:
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

        # If no total cost basis, try to calculate from per-share
        if cost_basis is None:
            cost_per_share_col = column_map.get("cost_per_share")
            if cost_per_share_col:
                cost_per_share = self._parse_number(row.get(cost_per_share_col))
                if cost_per_share and shares:
                    cost_basis = cost_per_share * shares

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
        """Parse a numeric value from Fidelity format."""
        if value is None or pd.isna(value):
            return None

        if isinstance(value, (int, float)):
            return float(value)

        try:
            cleaned = str(value).strip()
            # Remove $, commas, and whitespace
            cleaned = re.sub(r"[$,\s]", "", cleaned)

            # Handle parentheses for negative
            if cleaned.startswith("(") and cleaned.endswith(")"):
                cleaned = "-" + cleaned[1:-1]

            # Handle percentages
            cleaned = cleaned.rstrip("%")

            # Handle N/A and empty
            if cleaned.lower() in ["n/a", "--", "", "n/a*"]:
                return None

            return float(cleaned)

        except (ValueError, TypeError):
            return None

    def _is_fund(self, ticker: str, name: str) -> bool:
        """Determine if position is a fund/ETF."""
        name_lower = name.lower()
        fund_indicators = [
            "etf", "fund", "index", "trust", "portfolio",
            "ishares", "vanguard", "spdr", "fidelity",
        ]
        return any(ind in name_lower for ind in fund_indicators)

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "importer",
            "formats": [".csv"],
            "description": "Fidelity position export importer",
            "brokerage": "fidelity",
        }
