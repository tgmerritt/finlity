"""
Vanguard CSV Importer Plugin

Imports positions from Vanguard CSV exports. Handles two distinct shapes:

1. Brokerage account export (post-2013 Vanguard Brokerage Services accounts)
   Headers typically include:
       Account Number, Investment Name, Symbol, Shares, Share Price,
       Total Value, Holding Type
2. Legacy mutual-fund-only account export (pre-migration accounts; file
   often named ``OFXDownload.csv``)
   Headers typically include:
       Fund Account Number, Fund Name, Fund Number, Shares, Price,
       Total Value, Yield to Date

Cost basis is generally NOT included in either export -- it lives in a
separate Unrealized Gains/Losses report. We log a friendly notice and
continue.

Vanguard money-market sweep tickers (VMFXX, VUSXX, VMRXX, VFFXX) are
treated as cash equivalents and skipped from the position list. The
cross-cutting yfinance skip list lives in ``src/data/prices.py``.
"""

import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import pandas as pd

from src.plugins.base import (
    ImporterPlugin,
    ImportResult,
)

logger = logging.getLogger(__name__)


# Vanguard column aliases for the brokerage and mutual-fund exports.
# Order matters: first matching alias wins.
VANGUARD_COLUMN_ALIASES: dict[str, list[str]] = {
    "account_number": ["Account Number", "Fund Account Number", "Account"],
    "ticker": ["Symbol", "Ticker", "Fund Number"],
    "name": ["Investment Name", "Fund Name", "Security Name", "Description"],
    "shares": ["Shares", "Quantity", "Total Shares"],
    "price": ["Share Price", "Price", "Last Price", "NAV"],
    "market_value": ["Total Value", "Market Value", "Value", "Current Value"],
    "cost_basis": ["Cost Basis", "Total Cost Basis", "Cost Basis Total"],
    "cost_per_share": ["Cost Per Share", "Average Cost"],
    "holding_type": ["Holding Type", "Security Type", "Fund Type"],
    "trade_date": ["Trade Date", "Date", "Transaction Date"],
    "account_type": ["Account Type"],
}

# Money market funds and other non-priceable cash equivalents to skip.
# The yfinance skip list in src/data/prices.py is the source of truth for
# which tickers to NOT call out to a price API for; this set mirrors the
# Vanguard subset for in-importer filtering of position rows.
VANGUARD_MONEY_MARKET_SYMBOLS: set[str] = {
    "VMFXX",  # Vanguard Federal Money Market
    "VUSXX",  # Vanguard Treasury Money Market
    "VMRXX",  # Vanguard Cash Reserves Federal Money Market
    "VFFXX",  # Vanguard Federal Money Market - Investor Shares
}

# Generic non-position rows / sentinels.
SKIP_SYMBOLS: set[str] = {
    "", "--", "n/a", "nan", "none", "cash", "total", "pending",
    "pending activity", "account total", "settlement fund",
    "money market", "totals",
}

# Vanguard-specific tickers used for high-confidence detection.
VANGUARD_KNOWN_TICKERS: set[str] = {
    "VTI", "VTSAX", "VFIAX", "VBTLX", "VOO", "VXUS", "VTIAX", "VWO",
    "VEA", "VTV", "VUG", "VBR", "VB", "VYM", "VIG", "VNQ", "VGT",
    "VHT", "VFINX", "VTSMX", "VBMFX", "VGTSX", "VGSTX", "VWELX",
    "VMFXX", "VUSXX", "VMRXX", "VFFXX",
}

# Fund-name keywords that indicate a fund/ETF position.
FUND_INDICATORS = (
    "etf", "fund", "index", "trust", "portfolio", "ishares",
    "vanguard", "spdr", "admiral", "investor shares",
)


class VanguardCSVImporter(ImporterPlugin):
    """Importer for Vanguard CSV position exports."""

    # ----------------------------- detection -----------------------------

    def can_handle(self, file_path: Path, content_preview: bytes) -> float:
        """
        Return a confidence score for handling this file.

        We require at least one *structural* Vanguard signal in addition
        to brand-mention so a Schwab/Fidelity export that happens to
        contain a Vanguard fund description does not steal the file.
        """
        if file_path.suffix.lower() != ".csv":
            return 0.0

        try:
            preview_text = content_preview.decode("utf-8", errors="ignore")
        except Exception:
            return 0.0

        if not preview_text:
            return 0.0

        preview_lower = preview_text.lower()
        first_line = preview_text.split("\n", 1)[0].lower()
        filename_lower = file_path.name.lower()

        # Hard schwab-format signal -- bail out so schwab importer wins.
        if first_line.startswith('"positions for account'):
            return 0.0

        # Structural signals -- presence of any of these is strong evidence
        # the file is a Vanguard export and not just a CSV mentioning the
        # word "Vanguard" in a fund description.
        structural_signals = 0

        # Brokerage export header signature.
        if "investment name" in preview_lower and "share price" in preview_lower:
            structural_signals += 2
        elif "investment name" in preview_lower:
            structural_signals += 1

        # Legacy mutual-fund export header signature.
        if "fund number" in preview_lower and "fund name" in preview_lower:
            structural_signals += 2
        elif "fund account number" in preview_lower:
            structural_signals += 1

        # OFXDownload.csv is the canonical legacy filename.
        if "ofxdownload" in filename_lower:
            structural_signals += 2

        # Holding Type column is fairly Vanguard-specific in CSV exports.
        if "holding type" in preview_lower:
            structural_signals += 1

        # Count Vanguard-known tickers in the preview.
        ticker_hits = sum(
            1 for t in VANGUARD_KNOWN_TICKERS
            if re.search(rf"(^|[,\s\"]){re.escape(t)}([,\s\"]|$)", preview_text)
        )
        if ticker_hits >= 2:
            structural_signals += 2
        elif ticker_hits == 1:
            structural_signals += 1

        # Brand mention -- weakest signal, only useful as a tiebreaker.
        brand_mention = (
            "vanguard" in preview_lower
            or first_line.startswith("vg ")
            or ",vg," in preview_lower
        )

        # Score.
        if structural_signals >= 3:
            return 0.92  # Very high confidence
        if structural_signals >= 2:
            return 0.85  # High confidence -- beats generic and fidelity-1-match
        if structural_signals >= 1 and brand_mention:
            return 0.7   # Above generic-csv (max 0.4)
        if structural_signals >= 1:
            return 0.5   # Just enough to beat generic-csv
        return 0.0

    # ------------------------------ import -------------------------------

    def import_file(self, file_path: Path, account_type: str) -> ImportResult:
        """Import positions from a Vanguard CSV file."""
        try:
            df = self._load_vanguard_file(file_path)
            if df is None or df.empty:
                return ImportResult(
                    success=True,
                    positions=[],
                    message=f"Vanguard file contained no rows: {file_path.name}",
                    warnings=["File is empty"],
                )

            column_map = self._map_columns(df)
            if "ticker" not in column_map:
                return ImportResult(
                    success=False,
                    message="Could not find Symbol/Fund Number column in Vanguard export",
                    errors=[f"Columns found: {list(df.columns)}"],
                )

            account_name: Optional[str] = None
            positions: list[dict] = []
            warnings: list[str] = []
            money_market_skips = 0
            cost_basis_seen = "cost_basis" in column_map or "cost_per_share" in column_map

            for idx, row in df.iterrows():
                try:
                    if account_name is None:
                        account_name = self._extract_account_name(row, column_map)

                    position = self._extract_position(row, column_map)
                    if position is None:
                        continue
                    if position.get("_money_market"):
                        money_market_skips += 1
                        continue
                    position.pop("_money_market", None)
                    positions.append(position)
                except Exception as e:
                    warnings.append(f"Row {idx + 1}: {str(e)}")
                    logger.debug("Skipping malformed Vanguard row %s: %s", idx + 1, e)

            if not cost_basis_seen:
                logger.info(
                    "Vanguard import for %s did not include cost basis -- this "
                    "typically lives in a separate Unrealized Gains/Losses "
                    "report and can be uploaded as a follow-up.",
                    file_path.name,
                )

            if money_market_skips:
                warnings.append(
                    f"Skipped {money_market_skips} Vanguard money-market position(s) "
                    "(treated as cash equivalents)."
                )

            return ImportResult(
                success=True,
                positions=positions,
                account_name=account_name,
                message=f"Imported {len(positions)} positions from Vanguard",
                warnings=warnings[:10],
            )

        except Exception as e:
            logger.exception("Error importing Vanguard file %s: %s", file_path, e)
            return ImportResult(
                success=False,
                message=f"Import failed: {str(e)}",
                errors=[str(e)],
            )

    # --------------------------- file loading ----------------------------

    def _load_vanguard_file(self, file_path: Path) -> Optional[pd.DataFrame]:
        """
        Load a Vanguard CSV.

        Vanguard exports occasionally have a leading title row or a
        trailing blank row. Auto-detect the header row by scanning the
        first few lines for known column tokens.
        """
        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
        except Exception as e:
            logger.error("Could not open Vanguard file %s: %s", file_path, e)
            return None

        if not lines:
            return None

        skip_rows = 0
        header_tokens = (
            "investment name", "fund name", "fund number",
            "symbol", "share price",
        )
        for i, line in enumerate(lines[:10]):
            line_lower = line.lower()
            if any(tok in line_lower for tok in header_tokens):
                skip_rows = i
                break

        try:
            df = pd.read_csv(
                file_path,
                skiprows=skip_rows,
                skip_blank_lines=True,
                dtype=str,
            )
        except pd.errors.EmptyDataError:
            return None
        except Exception as e:
            logger.error("Error reading Vanguard CSV %s: %s", file_path, e)
            return None

        # Drop trailing summary rows (e.g., "Total" rows or all-blank rows).
        df = self._drop_summary_rows(df)
        return df

    @staticmethod
    def _drop_summary_rows(df: pd.DataFrame) -> pd.DataFrame:
        """Remove blank rows and trailing 'Total' summary rows."""
        if df.empty:
            return df

        # Drop rows where every value is null/empty.
        df = df.dropna(how="all")

        def _is_summary(row: pd.Series) -> bool:
            for v in row.values:
                if v is None:
                    continue
                if isinstance(v, float) and pd.isna(v):
                    continue
                s = str(v).strip().lower()
                if s in {"total", "totals", "grand total", "account total"}:
                    return True
            return False

        keep = [not _is_summary(r) for _, r in df.iterrows()]
        return df.loc[keep].reset_index(drop=True)

    # ---------------------------- mapping --------------------------------

    def _map_columns(self, df: pd.DataFrame) -> dict[str, str]:
        """Map Vanguard columns to standard field names."""
        column_map: dict[str, str] = {}
        df_columns = {str(col).lower().strip(): col for col in df.columns}

        for field, aliases in VANGUARD_COLUMN_ALIASES.items():
            for alias in aliases:
                alias_lower = alias.lower()
                if alias_lower in df_columns:
                    column_map[field] = df_columns[alias_lower]
                    break

        return column_map

    # --------------------------- extraction ------------------------------

    def _extract_account_name(
        self,
        row: pd.Series,
        column_map: dict[str, str],
    ) -> Optional[str]:
        """Build a human-friendly account name from the row."""
        acct_col = column_map.get("account_number")
        if acct_col:
            value = row.get(acct_col)
            if value is not None and not (isinstance(value, float) and pd.isna(value)):
                cleaned = str(value).strip()
                if cleaned and cleaned.lower() not in SKIP_SYMBOLS:
                    return f"Vanguard {cleaned}"

        acct_type_col = column_map.get("account_type")
        if acct_type_col:
            value = row.get(acct_type_col)
            if value is not None and not (isinstance(value, float) and pd.isna(value)):
                cleaned = str(value).strip()
                if cleaned and cleaned.lower() not in SKIP_SYMBOLS:
                    return f"Vanguard {cleaned}"

        return None

    def _extract_position(
        self,
        row: pd.Series,
        column_map: dict[str, str],
    ) -> Optional[dict]:
        """Extract a single position dict from a Vanguard row."""
        ticker_col = column_map.get("ticker")
        if not ticker_col:
            return None

        raw_ticker = row.get(ticker_col)
        if raw_ticker is None or (isinstance(raw_ticker, float) and pd.isna(raw_ticker)):
            return None

        ticker = str(raw_ticker).strip().upper()
        if not ticker or ticker.lower() in SKIP_SYMBOLS:
            return None

        # Money-market sweep funds are cash equivalents -- mark for skip.
        if ticker in VANGUARD_MONEY_MARKET_SYMBOLS:
            return {"_money_market": True, "ticker": ticker}

        shares_col = column_map.get("shares")
        shares = self._parse_number(row.get(shares_col)) if shares_col else None
        if shares is None or shares <= 0:
            return None

        name_col = column_map.get("name")
        name = (
            str(row.get(name_col)).strip()
            if name_col and pd.notna(row.get(name_col))
            else ticker
        )

        price_col = column_map.get("price")
        price = self._parse_number(row.get(price_col)) if price_col else None

        # Cost basis (rarely present in Vanguard exports).
        cost_basis_col = column_map.get("cost_basis")
        cost_basis = (
            self._parse_number(row.get(cost_basis_col)) if cost_basis_col else None
        )
        if cost_basis is None:
            cost_per_share_col = column_map.get("cost_per_share")
            if cost_per_share_col:
                cps = self._parse_number(row.get(cost_per_share_col))
                if cps is not None and shares is not None:
                    cost_basis = cps * shares

        # Use Holding Type to inform is_fund when present.
        holding_type_col = column_map.get("holding_type")
        holding_type = (
            str(row.get(holding_type_col)).strip().lower()
            if holding_type_col and pd.notna(row.get(holding_type_col))
            else ""
        )
        is_fund = self._is_fund(ticker, name, holding_type)

        # Optional trade date (parsed but not currently surfaced; kept for
        # future use and to validate parser behaviour in tests).
        trade_date_col = column_map.get("trade_date")
        trade_date = None
        if trade_date_col:
            trade_date = self._parse_date(row.get(trade_date_col))

        position: dict[str, Any] = {
            "ticker": ticker,
            "shares": shares,
            "name": name,
            "price": price,
            "cost_basis": cost_basis,
            "is_fund": is_fund,
        }
        if trade_date is not None:
            position["trade_date"] = trade_date.isoformat()

        # Sprint 8 lot wire-up: when both trade_date and cost_basis are
        # present (rare in standard Vanguard exports, but valid in some
        # cost-basis reports), surface a single explicit lot. The
        # persistence layer will turn this into a PositionLot row with
        # the real purchase_date instead of the import-timestamp
        # fallback. When only one of the two is present we leave `lots`
        # absent and let the persistence layer's single-lot fallback
        # handle it (using the import timestamp for purchase_date).
        if trade_date is not None and cost_basis is not None and shares:
            position["lots"] = [{
                "purchase_date": trade_date.isoformat(),
                "shares": float(shares),
                "cost_basis": float(cost_basis),
            }]

        return position

    # --------------------------- parsing utils ---------------------------

    @staticmethod
    def _parse_number(value: Any) -> Optional[float]:
        """Parse a numeric value from common Vanguard formats."""
        if value is None:
            return None
        if isinstance(value, float) and pd.isna(value):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        try:
            cleaned = str(value).strip()
            cleaned = re.sub(r"[$,\s]", "", cleaned)
            if cleaned.startswith("(") and cleaned.endswith(")"):
                cleaned = "-" + cleaned[1:-1]
            cleaned = cleaned.rstrip("%")
            if cleaned.lower() in {"n/a", "--", "", "nan", "none"}:
                return None
            return float(cleaned)
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _parse_date(value: Any) -> Optional[datetime]:
        """Parse Vanguard date strings (MM/DD/YYYY or MM/DD/YY)."""
        if value is None:
            return None
        if isinstance(value, float) and pd.isna(value):
            return None
        s = str(value).strip()
        if not s or s.lower() in {"n/a", "--", "nan"}:
            return None

        for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d", "%m-%d-%Y"):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                continue
        return None

    @staticmethod
    def _is_fund(ticker: str, name: str, holding_type: str) -> bool:
        """Determine whether a position should be treated as a fund/ETF."""
        if holding_type:
            ht = holding_type.lower()
            if "stock" in ht or "equity" == ht:
                return False
            if "etf" in ht or "fund" in ht or "mutual" in ht:
                return True

        name_lower = (name or "").lower()
        if any(ind in name_lower for ind in FUND_INDICATORS):
            return True

        # Vanguard fund tickers mostly end in 'X' for mutual funds.
        if len(ticker) == 5 and ticker.endswith("X"):
            return True
        return False

    # ------------------------------ info ---------------------------------

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "importer",
            "formats": [".csv"],
            "description": "Vanguard brokerage and mutual-fund CSV importer",
            "brokerage": "vanguard",
        }
