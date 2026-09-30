"""Startup bootstrap must bypass the PriceService file cache on catch-up."""

import asyncio
from datetime import datetime
from unittest.mock import Mock

import src.main as main
from src.services.price_refresh_gate import ALLOWED, GateDecision


def _run(monkeypatch, decision):
    scanner = Mock()
    db = Mock()
    monkeypatch.setattr(main, "get_database", lambda: db)
    monkeypatch.setattr(main, "FolderScanner", lambda d: scanner)
    monkeypatch.setattr(main, "evaluate_refresh_gate", lambda d: decision)
    monkeypatch.setattr(main, "catch_up_tickers", lambda d, dec: ["VTI"])
    monkeypatch.setattr(main, "record_refresh_pass", lambda d: None)
    db.get_stale_tickers.return_value = ["VTI"]
    asyncio.run(main._background_bootstrap(True))
    return scanner


def test_catch_up_forces_live_quotes(monkeypatch):
    decision = GateDecision(True, ALLOWED, None, catch_up_cutoff=datetime(2026, 9, 30, 20))
    scanner = _run(monkeypatch, decision)

    scanner._fetch_and_update_prices.assert_called_once()
    assert scanner._fetch_and_update_prices.call_args.kwargs.get("force") is True


def test_open_market_pass_keeps_default_caching(monkeypatch):
    decision = GateDecision(True, ALLOWED, None)
    scanner = _run(monkeypatch, decision)

    scanner._fetch_and_update_prices.assert_called_once()
    assert not scanner._fetch_and_update_prices.call_args.kwargs.get("force")
