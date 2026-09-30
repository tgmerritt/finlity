"""The correlation widget must only request history for tradeable tickers.

yfinance is mocked; nothing touches the network.
"""

import pandas as pd

from tests.test_options import _load_widget


def _position(ticker, position_type, price=100.0, shares=10.0):
    return {
        "ticker": ticker,
        "position_type": position_type,
        "current_price": price,
        "shares": shares,
    }


def test_only_equities_are_sent_to_yfinance(monkeypatch):
    requested: list[list[str]] = []

    def fake_download(symbols, **kwargs):
        requested.append(list(symbols))
        return pd.DataFrame()  # empty -> widget falls back without network

    monkeypatch.setattr("yfinance.download", fake_download)
    widget = _load_widget("correlation-heatmap", "CorrelationHeatmapWidget")
    widget._price_service = object()  # any PriceService use would blow up

    positions = [
        _position("RE", "real_estate", price=500000.0, shares=1.0),
        _position("CASH", "cash", price=1.0, shares=9000.0),
        _position("CD-ALLY-1", "cd", price=1.0, shares=5000.0),
        _position("AAPL", "equity"),
        _position("MSFT", "equity"),
        _position("BOND-TREAS-1", "equity"),
        _position("MONEY", "equity"),
        _position("TBILL-9", "equity"),
        _position("IBOND-2", "equity"),
    ]

    widget.render(positions, [])

    assert len(requested) == 1
    assert sorted(requested[0]) == ["AAPL", "MSFT"]


def test_dead_column_does_not_blank_the_matrix(monkeypatch):
    import numpy as np

    idx = pd.date_range("2026-01-01", periods=60)
    rng = np.random.default_rng(0)
    base = rng.normal(size=60).cumsum() + 100
    frame = pd.DataFrame(
        {
            "AAA": base,
            "BBB": base * 1.1 + rng.normal(size=60),
            "DEAD": np.nan,
        },
        index=idx,
    )
    data = pd.concat({"Close": frame}, axis=1)
    monkeypatch.setattr("yfinance.download", lambda symbols, **kw: data)
    widget = _load_widget("correlation-heatmap", "CorrelationHeatmapWidget")

    matrix = widget._calculate_price_correlations(["AAA", "BBB", "DEAD"], {})

    assert matrix is not None
    assert matrix[0][1] != 0.5  # real correlation, not the filler
