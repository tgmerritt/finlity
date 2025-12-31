"""Historical tracking for portfolio snapshots and performance."""

import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import numpy as np

from src.data import PriceService
from src.models import Portfolio


@dataclass
class HistorySnapshot:
    """A point-in-time snapshot of portfolio value."""

    date: date
    total_value: float
    retirement_value: float
    taxable_value: float
    account_values: dict[str, float]
    position_count: int


@dataclass
class HistoricalPerformance:
    """Performance metrics calculated from historical snapshots."""

    start_date: date
    end_date: date
    start_value: float
    end_value: float
    total_return: float
    total_return_pct: float
    annualized_return: float
    vs_benchmark_return: float
    vs_benchmark_alpha: float
    max_value: float
    min_value: float
    max_drawdown: float


class HistoryTracker:
    """Tracks and analyzes historical portfolio data."""

    def __init__(
        self,
        history_dir: str = "data/history",
        price_service: Optional[PriceService] = None,
    ):
        self.history_dir = Path(history_dir)
        self.history_dir.mkdir(parents=True, exist_ok=True)
        self.price_service = price_service or PriceService()

    def save_snapshot(self, portfolio: Portfolio) -> Path:
        """Save a snapshot of the current portfolio state."""
        snapshot_data = {
            "date": portfolio.snapshot_date.isoformat(),
            "timestamp": datetime.now().isoformat(),
            "total_value": portfolio.total_value,
            "retirement_value": portfolio.retirement_value,
            "taxable_value": portfolio.taxable_value,
            "accounts": {a.name: a.total_value for a in portfolio.accounts},
            "positions": [
                {
                    "ticker": p.ticker,
                    "shares": p.shares,
                    "price": p.current_price,
                    "value": p.market_value,
                    "account": p.account_name,
                }
                for p in portfolio.all_positions
            ],
        }

        snapshot_path = self.history_dir / f"{portfolio.snapshot_date.isoformat()}.json"

        with open(snapshot_path, "w") as f:
            json.dump(snapshot_data, f, indent=2)

        return snapshot_path

    def load_snapshot(self, snapshot_date: date) -> Optional[HistorySnapshot]:
        """Load a specific snapshot by date."""
        snapshot_path = self.history_dir / f"{snapshot_date.isoformat()}.json"

        if not snapshot_path.exists():
            return None

        try:
            with open(snapshot_path) as f:
                data = json.load(f)

            return HistorySnapshot(
                date=date.fromisoformat(data["date"]),
                total_value=data["total_value"],
                retirement_value=data.get("retirement_value", 0),
                taxable_value=data.get("taxable_value", 0),
                account_values=data.get("accounts", {}),
                position_count=len(data.get("positions", [])),
            )
        except Exception:
            return None

    def get_all_snapshots(self) -> list[HistorySnapshot]:
        """Load all available snapshots."""
        snapshots = []

        for path in sorted(self.history_dir.glob("*.json")):
            try:
                snapshot_date = date.fromisoformat(path.stem)
                snapshot = self.load_snapshot(snapshot_date)
                if snapshot:
                    snapshots.append(snapshot)
            except Exception:
                continue

        return snapshots

    def get_value_history(
        self,
        days: Optional[int] = None,
    ) -> list[tuple[date, float]]:
        """Get a time series of portfolio values."""
        snapshots = self.get_all_snapshots()

        if days:
            cutoff = date.today() - timedelta(days=days)
            snapshots = [s for s in snapshots if s.date >= cutoff]

        return [(s.date, s.total_value) for s in snapshots]

    def calculate_performance(
        self,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
        benchmark: str = "SPY",
    ) -> Optional[HistoricalPerformance]:
        """Calculate performance metrics over a date range."""
        snapshots = self.get_all_snapshots()

        if not snapshots:
            return None

        # Filter by date range
        if start_date:
            snapshots = [s for s in snapshots if s.date >= start_date]
        if end_date:
            snapshots = [s for s in snapshots if s.date <= end_date]

        if len(snapshots) < 2:
            return None

        first = snapshots[0]
        last = snapshots[-1]
        values = [s.total_value for s in snapshots]

        # Calculate returns
        total_return = last.total_value - first.total_value
        total_return_pct = (total_return / first.total_value) * 100 if first.total_value > 0 else 0

        # Annualized return
        days = (last.date - first.date).days
        years = days / 365.25
        annualized = ((last.total_value / first.total_value) ** (1 / years) - 1) * 100 if years > 0 else 0

        # Max drawdown
        max_drawdown = self._calculate_max_drawdown(values)

        # Benchmark comparison
        bench_history = self.price_service.get_price_history(benchmark, period="1y")
        bench_return = 0.0
        if bench_history and len(bench_history.prices) >= 2:
            bench_return = (
                (bench_history.prices[-1] - bench_history.prices[0]) / bench_history.prices[0] * 100
            )

        return HistoricalPerformance(
            start_date=first.date,
            end_date=last.date,
            start_value=first.total_value,
            end_value=last.total_value,
            total_return=total_return,
            total_return_pct=total_return_pct,
            annualized_return=annualized,
            vs_benchmark_return=bench_return,
            vs_benchmark_alpha=total_return_pct - bench_return,
            max_value=max(values),
            min_value=min(values),
            max_drawdown=max_drawdown,
        )

    def _calculate_max_drawdown(self, values: list[float]) -> float:
        """Calculate maximum drawdown from a series of values."""
        if len(values) < 2:
            return 0.0

        max_drawdown = 0.0
        peak = values[0]

        for value in values[1:]:
            if value > peak:
                peak = value
            else:
                drawdown = (peak - value) / peak * 100
                max_drawdown = max(max_drawdown, drawdown)

        return max_drawdown

    def get_monthly_returns(self) -> list[tuple[str, float]]:
        """Calculate monthly returns from snapshots."""
        snapshots = self.get_all_snapshots()

        if len(snapshots) < 2:
            return []

        # Group by month
        monthly: dict[str, list[float]] = {}
        for snapshot in snapshots:
            month_key = snapshot.date.strftime("%Y-%m")
            if month_key not in monthly:
                monthly[month_key] = []
            monthly[month_key].append(snapshot.total_value)

        # Calculate return for each month
        results = []
        sorted_months = sorted(monthly.keys())

        for i, month in enumerate(sorted_months[1:], 1):
            prev_month = sorted_months[i - 1]
            start_value = monthly[prev_month][-1]
            end_value = monthly[month][-1]

            if start_value > 0:
                month_return = (end_value - start_value) / start_value * 100
                results.append((month, month_return))

        return results
