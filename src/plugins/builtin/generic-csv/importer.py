"""
Generic CSV Importer Plugin

Imports positions from standard CSV and Excel files with automatic
column detection. This is the fallback importer used when no
brokerage-specific importer matches the file format.
"""

import logging
import re
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from src.plugins.base import (
    ImporterPlugin,
    ImportResult,
)

logger = logging.getLogger(__name__)

# Common column name patterns for auto-detection
COLUMN_PATTERNS = {
    "ticker": [
        r"^symbol$", r"^ticker$", r"^stock$", r"^security.*symbol",
        r"^fund.*symbol", r"^sym$", r"^code$",
    ],
    "shares": [
        r"^shares$", r"^quantity$", r"^qty$", r"^units$", r"^shares.*owned",
        r"^total.*shares", r"^holdings?$", r"^position",
    ],
    "name": [
        r"^name$", r"^description$", r"^security.*name", r"^fund.*name",
        r"^company", r"^security$", r"^holding.*name",
    ],
    "price": [
        r"^price$", r"^last.*price", r"^current.*price", r"^market.*price",
        r"^close$", r"^last$", r"^quote",
    ],
    "cost_per_share": [
        r"^cost.?share", r"^avg.*cost", r"^average.*cost",
        r"^purchase.*price",
    ],
    "cost_basis": [
        r"^cost.*basis", r"^cost$", r"^basis$", r"^total.*cost",
    ],
    "market_value": [
        r"^market.*value", r"^value$", r"^current.*value", r"^total.*value",
        r"^position.*value",
    ],
    "security_type": [
        r"^security.*type", r"^type$", r"^asset.*type",
    ],
}

# Symbols/values to skip
SKIP_SYMBOLS = {
    "cash", "total", "pending", "money market", "", "account total",
    "cash & cash investments", "--", "n/a", "nan", "none",
}

# Fund indicators
FUND_INDICATORS = {"etf", "fund", "index", "trust", "portfolio"}


class GenericCSVImporter(ImporterPlugin):
    """Generic importer for standard CSV and Excel files."""

    def can_handle(self, file_path: Path, content_preview: bytes) -> float:
        """
        Return confidence score for handling this file.

        Generic importer has moderate confidence for any CSV/Excel file
        that has recognizable column headers.
        """
        # Check file extension
        ext = file_path.suffix.lower()
        if ext not in [".csv", ".xlsx", ".xls"]:
            return 0.0

        # For CSV, check if it looks like a standard CSV
        if ext == ".csv":
            try:
                preview_text = content_preview.decode("utf-8", errors="ignore")

                # Check for common position-related headers
                header_indicators = [
                    "symbol", "ticker", "shares", "quantity",
                    "price", "value", "name", "description"
                ]
                preview_lower = preview_text.lower()

                matches = sum(1 for h in header_indicators if h in preview_lower)

                if matches >= 2:
                    # Found at least 2 recognizable headers
                    return 0.4  # Moderate confidence (let specific plugins win)
                elif matches >= 1:
                    return 0.2  # Low confidence
                else:
                    return 0.1  # Very low - might still work

            except Exception:
                return 0.1

        # Excel files get moderate confidence
        return 0.3

    def import_file(self, file_path: Path, account_type: str) -> ImportResult:
        """Import positions from the file."""
        try:
            # Load the file
            df = self._load_file(file_path)
            if df is None or df.empty:
                return ImportResult(
                    success=False,
                    message=f"Could not load or empty file: {file_path.name}",
                    errors=["File is empty or unreadable"],
                )

            # Detect columns
            column_map = self._detect_columns(df)
            if "ticker" not in column_map:
                return ImportResult(
                    success=False,
                    message="Could not detect ticker/symbol column",
                    errors=[f"Columns found: {list(df.columns)}"],
                )

            if "shares" not in column_map:
                return ImportResult(
                    success=False,
                    message="Could not detect shares/quantity column",
                    errors=[f"Columns found: {list(df.columns)}"],
                )

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
                message=f"Imported {len(positions)} positions",
                warnings=warnings[:10],  # Limit warnings
            )

        except Exception as e:
            logger.exception(f"Error importing {file_path}: {e}")
            return ImportResult(
                success=False,
                message=f"Import failed: {str(e)}",
                errors=[str(e)],
            )

    def _load_file(self, file_path: Path) -> Optional[pd.DataFrame]:
        """Load file based on extension."""
        skip_rows = self.get_setting("skip_rows", 0)

        try:
            ext = file_path.suffix.lower()
            if ext in [".xlsx", ".xls"]:
                return pd.read_excel(file_path, skiprows=skip_rows)
            else:
                return pd.read_csv(file_path, skiprows=skip_rows)
        except Exception as e:
            logger.error(f"Error loading {file_path}: {e}")
            return None

    def _detect_columns(self, df: pd.DataFrame) -> dict[str, str]:
        """Auto-detect column mappings based on header patterns."""
        detected = {}
        columns_lower = {col: str(col).lower().strip() for col in df.columns}

        for field, patterns in COLUMN_PATTERNS.items():
            for col, col_lower in columns_lower.items():
                if field in detected:
                    break
                for pattern in patterns:
                    if re.search(pattern, col_lower, re.IGNORECASE):
                        detected[field] = col
                        break

        return detected

    def _extract_position(
        self,
        row: pd.Series,
        column_map: dict[str, str],
    ) -> Optional[dict]:
        """Extract position data from a row."""
        # Get ticker (required)
        ticker_col = column_map.get("ticker")
        ticker = str(row.get(ticker_col, "")).strip().upper()

        if not ticker or ticker.lower() in SKIP_SYMBOLS:
            return None

        # Get shares (required)
        shares_col = column_map.get("shares")
        shares = self._parse_number(row.get(shares_col))

        if shares is None or shares <= 0:
            return None

        # Get optional fields
        name_col = column_map.get("name")
        name = str(row.get(name_col, ticker)) if name_col else ticker

        price_col = column_map.get("price")
        price = self._parse_number(row.get(price_col)) if price_col else None

        cost_basis_col = column_map.get("cost_basis")
        cost_basis = self._parse_number(row.get(cost_basis_col)) if cost_basis_col else None

        # If no cost basis but have cost per share, calculate it
        if cost_basis is None:
            cost_per_share_col = column_map.get("cost_per_share")
            if cost_per_share_col:
                cost_per_share = self._parse_number(row.get(cost_per_share_col))
                if cost_per_share:
                    cost_basis = cost_per_share * shares

        # Determine if it's a fund
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
        """Parse a numeric value, handling currency symbols and formatting."""
        if value is None or pd.isna(value):
            return None

        if isinstance(value, (int, float)):
            return float(value)

        # String parsing
        try:
            # Remove currency symbols, commas, whitespace
            cleaned = str(value).strip()
            cleaned = re.sub(r"[$,\s]", "", cleaned)

            # Handle parentheses for negative
            if cleaned.startswith("(") and cleaned.endswith(")"):
                cleaned = "-" + cleaned[1:-1]

            # Handle percentage
            cleaned = cleaned.rstrip("%")

            return float(cleaned) if cleaned else None

        except (ValueError, TypeError):
            return None

    def _is_fund(self, ticker: str, name: str) -> bool:
        """Determine if a position is likely a fund/ETF."""
        name_lower = name.lower()
        return any(indicator in name_lower for indicator in FUND_INDICATORS)

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "importer",
            "formats": [".csv", ".xlsx", ".xls"],
            "description": "Generic importer with auto-column detection",
        }
