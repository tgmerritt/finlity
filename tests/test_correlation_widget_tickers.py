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
    ]

    widget.render(positions, [])

    assert len(requested) == 1
    assert sorted(requested[0]) == ["AAPL", "MSFT"]
