"""File importer for CSV and Excel position data."""

from pathlib import Path
from typing import Optional

import pandas as pd
from rich.console import Console
from rich.table import Table

from src.models import Account, AccountType, Brokerage, Position

console = Console()


class FileImporter:
    """Import positions from CSV or Excel files with interactive column mapping."""

    def __init__(self):
        self.df: Optional[pd.DataFrame] = None
        self.columns: list[str] = []
        self.column_map: dict[str, str] = {}

    def load_file(self, file_path: str) -> bool:
        """Load a CSV or Excel file."""
        path = Path(file_path)

        if not path.exists():
            console.print(f"[red]File not found: {file_path}[/red]")
            return False

        try:
            if path.suffix.lower() in [".xlsx", ".xls"]:
                self.df = pd.read_excel(path)
            elif path.suffix.lower() == ".csv":
                self.df = pd.read_csv(path)
            else:
                console.print(f"[red]Unsupported file type: {path.suffix}[/red]")
                console.print("[dim]Supported formats: .csv, .xlsx, .xls[/dim]")
                return False

            self.columns = list(self.df.columns)
            console.print(f"[green]Loaded {len(self.df)} rows from {path.name}[/green]")
            return True

        except Exception as e:
            console.print(f"[red]Error loading file: {e}[/red]")
            return False

    def display_columns(self) -> None:
        """Display available columns to the user."""
        console.print("\n[bold]Detected columns:[/bold]")
        table = Table(show_header=True)
        table.add_column("#", style="cyan", width=4)
        table.add_column("Column Name")
        table.add_column("Sample Values", style="dim")

        for i, col in enumerate(self.columns, 1):
            # Get first 3 non-null sample values
            samples = self.df[col].dropna().head(3).astype(str).tolist()
            sample_str = ", ".join(samples) if samples else "(empty)"
            if len(sample_str) > 50:
                sample_str = sample_str[:47] + "..."
            table.add_row(str(i), col, sample_str)

        console.print(table)

    def prompt_column_selection(self, prompt: str, required: bool = True) -> Optional[str]:
        """Prompt user to select a column by number."""
        while True:
            console.print(f"\n[bold]{prompt}[/bold]")
            if not required:
                console.print("[dim](Press Enter to skip)[/dim]")

            try:
                user_input = input("> ").strip()

                if not user_input:
                    if required:
                        console.print("[yellow]This field is required.[/yellow]")
                        continue
                    return None

                selection = int(user_input)
                if 1 <= selection <= len(self.columns):
                    selected_col = self.columns[selection - 1]
                    console.print(f"[green]Selected: {selected_col}[/green]")
                    return selected_col
                else:
                    console.print(f"[yellow]Please enter a number between 1 and {len(self.columns)}[/yellow]")

            except ValueError:
                console.print("[yellow]Please enter a valid number.[/yellow]")
            except (KeyboardInterrupt, EOFError):
                console.print("\n[red]Import cancelled.[/red]")
                raise SystemExit(1)

    def interactive_column_mapping(self) -> bool:
        """Interactively map columns from the file to position fields."""
        self.display_columns()

        # Required fields
        ticker_col = self.prompt_column_selection(
            "Which column contains the ticker/symbol?", required=True
        )
        if not ticker_col:
            return False
        self.column_map["ticker"] = ticker_col

        shares_col = self.prompt_column_selection(
            "Which column contains the number of shares/quantity?", required=True
        )
        if not shares_col:
            return False
        self.column_map["shares"] = shares_col

        # Optional fields
        console.print("\n[dim]--- Optional fields (press Enter to skip) ---[/dim]")

        name_col = self.prompt_column_selection(
            "Which column contains the security name?", required=False
        )
        if name_col:
            self.column_map["name"] = name_col

        price_col = self.prompt_column_selection(
            "Which column contains the current price?", required=False
        )
        if price_col:
            self.column_map["price"] = price_col

        cost_col = self.prompt_column_selection(
            "Which column contains the cost basis?", required=False
        )
        if cost_col:
            self.column_map["cost_basis"] = cost_col

        sector_col = self.prompt_column_selection(
            "Which column contains the sector?", required=False
        )
        if sector_col:
            self.column_map["sector"] = sector_col

        return True

    def import_positions(
        self,
        account_name: str,
        account_type: AccountType = AccountType.TAXABLE,
        brokerage: Brokerage = Brokerage.OTHER,
        fetch_prices: bool = True,
    ) -> Optional[Account]:
        """Import positions from the loaded file using the column mapping."""
        if self.df is None:
            console.print("[red]No file loaded. Call load_file() first.[/red]")
            return None

        if "ticker" not in self.column_map or "shares" not in self.column_map:
            console.print("[red]Column mapping incomplete. Run interactive_column_mapping() first.[/red]")
            return None

        positions: list[Position] = []
        errors: list[str] = []
        prices_to_fetch: list[str] = []

        for idx, row in self.df.iterrows():
            try:
                # Get ticker
                ticker = str(row[self.column_map["ticker"]]).strip().upper()
                if not ticker or ticker == "NAN" or pd.isna(row[self.column_map["ticker"]]):
                    continue

                # Get shares
                shares_val = row[self.column_map["shares"]]
                if pd.isna(shares_val):
                    continue
                shares = self._parse_number(shares_val)
                if shares <= 0:
                    continue

                # Get optional fields
                name = ticker
                if "name" in self.column_map:
                    name_val = row[self.column_map["name"]]
                    if not pd.isna(name_val):
                        name = str(name_val).strip()

                price = 0.0
                if "price" in self.column_map:
                    price_val = row[self.column_map["price"]]
                    if not pd.isna(price_val):
                        price = self._parse_number(price_val)

                cost_basis = None
                if "cost_basis" in self.column_map:
                    cost_val = row[self.column_map["cost_basis"]]
                    if not pd.isna(cost_val):
                        cost_basis = self._parse_number(cost_val)

                sector = None
                if "sector" in self.column_map:
                    sector_val = row[self.column_map["sector"]]
                    if not pd.isna(sector_val):
                        sector = str(sector_val).strip()

                # Track tickers that need price lookup
                if price <= 0:
                    prices_to_fetch.append(ticker)

                # Determine if it's a fund
                is_fund = self._is_likely_fund(ticker, name)

                positions.append(
                    Position(
                        ticker=ticker,
                        name=name,
                        shares=shares,
                        current_price=price,
                        cost_basis=cost_basis,
                        account_name=account_name,
                        brokerage=brokerage,
                        sector=sector,
                        is_fund=is_fund,
                    )
                )

            except Exception as e:
                errors.append(f"Row {idx + 2}: {e}")

        # Fetch missing prices if requested
        if fetch_prices and prices_to_fetch:
            console.print(f"\n[blue]Fetching prices for {len(prices_to_fetch)} positions from Yahoo Finance...[/blue]")
            price_map = self._fetch_prices(list(set(prices_to_fetch)))

            for position in positions:
                if position.current_price <= 0 and position.ticker in price_map:
                    position.current_price = price_map[position.ticker]

        # Filter out positions with no price
        valid_positions = [p for p in positions if p.current_price > 0]
        skipped = len(positions) - len(valid_positions)

        if errors:
            console.print(f"\n[yellow]Encountered {len(errors)} errors during import:[/yellow]")
            for error in errors[:5]:
                console.print(f"  [dim]{error}[/dim]")
            if len(errors) > 5:
                console.print(f"  [dim]... and {len(errors) - 5} more[/dim]")

        if skipped > 0:
            console.print(f"[yellow]Skipped {skipped} positions with no price data.[/yellow]")

        if not valid_positions:
            console.print("[red]No valid positions imported.[/red]")
            return None

        console.print(f"[green]Successfully imported {len(valid_positions)} positions into '{account_name}'[/green]")

        return Account(
            name=account_name,
            account_type=account_type,
            brokerage=brokerage,
            positions=valid_positions,
        )

    def _parse_number(self, value) -> float:
        """Parse a number from various formats."""
        if isinstance(value, (int, float)):
            return float(value)

        if isinstance(value, str):
            # Remove currency symbols, commas, and whitespace
            import re
            cleaned = re.sub(r"[^\d.\-]", "", value)
            try:
                return float(cleaned) if cleaned else 0.0
            except ValueError:
                return 0.0

        return 0.0

    def _is_likely_fund(self, ticker: str, name: str) -> bool:
        """Determine if a position is likely a fund/ETF."""
        fund_indicators = ["ETF", "FUND", "INDEX", "TRUST", "ADMIRAL"]
        name_upper = name.upper()

        if any(ind in name_upper for ind in fund_indicators):
            return True

        # Common ETF/fund tickers
        common_funds = [
            "VTI", "VOO", "VXUS", "VWO", "BND", "VNQ",
            "SPY", "QQQ", "IWM", "EFA", "EEM", "AGG",
            "FXAIX", "FSKAX", "FTIHX", "SWPPX", "SWTSX",
        ]
        if ticker in common_funds:
            return True

        return False

    def _fetch_prices(self, tickers: list[str]) -> dict[str, float]:
        """Fetch current prices from Yahoo Finance."""
        prices = {}

        try:
            import yfinance as yf

            for ticker in tickers:
                try:
                    stock = yf.Ticker(ticker)
                    info = stock.info
                    price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
                    if price:
                        prices[ticker] = float(price)
                        console.print(f"  [dim]{ticker}: ${price:.2f}[/dim]")
                except Exception:
                    console.print(f"  [dim]{ticker}: price not found[/dim]")

        except ImportError:
            console.print("[yellow]yfinance not available. Prices not fetched.[/yellow]")

        return prices
