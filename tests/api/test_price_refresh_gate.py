"""Endpoint tests for the market-gated price refresh flow.

The gate and the fetcher are monkeypatched so nothing touches the network
or upstream APIs. DB state is seeded directly on the isolated test DB.
"""

from datetime import datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from src.api.imports import FolderScanner
from src.database.profile_manager import get_database
from src.database.models import Account, AppSettings, Position, PriceCache
from src.main import app
from src.services.price_refresh_gate import (
    ALLOWED,
    LAST_REFRESH_KEY,
    MARKET_CLOSED,
    TOO_SOON,
    GateDecision,
)

TUE_OPEN = datetime(2026, 8, 11, 15, 0)  # naive UTC, 11:00 ET


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _fake_fetch(result: dict | None = None):
    """A Mock standing in for FolderScanner._fetch_and_update_prices."""
    result = result or {"success": [], "skipped": [], "failed": []}
    return Mock(return_value=result)


def _clear_last_pass(db) -> None:
    with db.get_session() as session:
        session.query(AppSettings).filter_by(key=LAST_REFRESH_KEY).delete()
        session.commit()


def _seed_stale_position(db, ticker: str = "VTI") -> None:
    """One updatable equity position whose price cache is 30h old."""
    with db.get_session() as session:
        account = Account(name="Gate Test", account_type="taxable")
        session.add(account)
        session.flush()
        session.add(
            Position(
                account_id=account.id,
                ticker=ticker,
                name="Vanguard Total Market",
                shares=10.0,
                current_price=250.0,
                cost_basis=2000.0,
                position_type="equity",
            )
        )
        session.commit()

    db.update_price_cache(ticker, 250.0, previous_close=248.0)
    with db.get_session() as session:
        cache = session.query(PriceCache).filter_by(ticker=ticker).first()
        cache.last_updated = datetime.utcnow() - timedelta(hours=30)  # type: ignore[assignment]
        session.commit()


def _seed_position_without_price(db, ticker: str) -> None:
    """One updatable equity position with NO price_cache row (just imported)."""
    with db.get_session() as session:
        account = Account(name="Missing Test", account_type="taxable")
        session.add(account)
        session.flush()
        session.add(
            Position(
                account_id=account.id,
                ticker=ticker,
                name="Fresh Import",
                shares=5.0,
                current_price=100.0,
                cost_basis=500.0,
                position_type="equity",
            )
        )
        session.commit()
    # Deliberately no update_price_cache() call.


def _gate(market_open: bool):
    if market_open:
        return GateDecision(True, ALLOWED, TUE_OPEN + timedelta(hours=1))
    return GateDecision(False, MARKET_CLOSED, datetime(2026, 8, 17, 13, 30))


class TestRefreshPricesGate:
    def test_market_closed_is_a_noop(self, client, monkeypatch):
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate", lambda db, force=False: _gate(False)
        )
        fetch = _fake_fetch()
        monkeypatch.setattr(FolderScanner, "_fetch_and_update_prices", fetch)
        _clear_last_pass(get_database())

        response = client.post("/api/imports/refresh-prices")

        assert response.status_code == 200
        data = response.json()
        assert data["updated"] == 0
        assert data["market_open"] is False
        assert data["all_fresh"] is True
        assert "Markets closed" in data["message"]
        assert data["next_refresh_at"] == "2026-08-17T13:30:00"
        fetch.assert_not_called()

    def test_recent_pass_is_a_noop(self, client, monkeypatch):
        too_soon = GateDecision(False, TOO_SOON, TUE_OPEN + timedelta(hours=1))
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate", lambda db, force=False: too_soon
        )
        fetch = _fake_fetch()
        monkeypatch.setattr(FolderScanner, "_fetch_and_update_prices", fetch)
        _clear_last_pass(get_database())

        response = client.post("/api/imports/refresh-prices")

        assert response.status_code == 200
        data = response.json()
        assert data["updated"] == 0
        assert data["market_open"] is True
        assert data["next_refresh_at"] == "2026-08-11T16:00:00"
        fetch.assert_not_called()

    def test_allowed_refresh_fetches_and_records_pass(self, client, monkeypatch):
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate", lambda db, force=False: _gate(True)
        )
        monkeypatch.setattr(
            FolderScanner,
            "_fetch_and_update_prices",
            _fake_fetch({"success": ["VTI"], "skipped": [], "failed": []}),
        )
        db = get_database()
        _clear_last_pass(db)
        _seed_stale_position(db, "VTI")

        response = client.post("/api/imports/refresh-prices")

        assert response.status_code == 200
        data = response.json()
        assert data["updated"] == 1
        assert data["market_open"] is True
        assert data["next_refresh_at"] == "2026-08-11T16:00:00"
        # The pass was recorded so a second request within the hour is gated.
        assert db.get_setting(LAST_REFRESH_KEY) is not None

    def test_force_bypasses_cap_but_not_market_closed(self, client, monkeypatch):
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate",
            lambda db, force=False: _gate(False) if not force else _gate(True),
        )
        fetch = _fake_fetch({"success": ["VTI"], "skipped": [], "failed": []})
        monkeypatch.setattr(FolderScanner, "_fetch_and_update_prices", fetch)
        db = get_database()
        _clear_last_pass(db)
        _seed_stale_position(db, "VTI")

        # force with market open runs the fetch.
        response = client.post("/api/imports/refresh-prices?force=true")
        assert response.json()["updated"] == 1
        fetch.assert_called()

        # force with market closed and a cached (stale) ticker is still a no-op.
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate", lambda db, force=False: _gate(False)
        )
        response = client.post("/api/imports/refresh-prices?force=true")
        assert response.json()["updated"] == 0
        assert response.json()["market_open"] is False


class TestForceFetchesMissingPrices:
    """force + market closed must still fetch tickers with NO cached price."""

    @pytest.fixture(autouse=True)
    def _cleanup_seeded_positions(self):
        """Remove seeded positions so later status tests see a clean DB."""
        def _purge():
            db = get_database()
            with db.get_session() as session:
                session.query(Position).filter_by(
                    name="Fresh Import"
                ).delete(synchronize_session=False)
                session.query(Account).filter_by(name="Missing Test").delete(
                    synchronize_session=False
                )
                session.commit()

        _purge()
        yield
        _purge()

    def test_force_closed_market_fetches_never_cached_ticker(self, client, monkeypatch):
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate", lambda db, force=False: _gate(False)
        )
        db = get_database()
        _clear_last_pass(db)
        _seed_position_without_price(db, "NEWC")
        fetch = _fake_fetch({"success": ["NEWC"], "skipped": [], "failed": []})
        monkeypatch.setattr(FolderScanner, "_fetch_and_update_prices", fetch)

        response = client.post("/api/imports/refresh-prices?force=true")

        assert response.status_code == 200
        data = response.json()
        assert data["updated"] == 1
        assert data["tickers"] == ["NEWC"]
        assert data["all_fresh"] is True
        assert data["market_open"] is False
        fetch.assert_called_once()
        # Only missing tickers were attempted (the shared test DB may carry
        # other demo tickers without caches — NEWC must be among them, and
        # stale-but-cached VTI must NOT be).
        attempted = fetch.call_args[0][0]
        assert "NEWC" in attempted
        assert "VTI" not in attempted

    def test_no_force_no_fetch_when_closed(self, client, monkeypatch):
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate", lambda db, force=False: _gate(False)
        )
        db = get_database()
        _clear_last_pass(db)
        _seed_position_without_price(db, "NEWC2")
        fetch = _fake_fetch()
        monkeypatch.setattr(FolderScanner, "_fetch_and_update_prices", fetch)

        response = client.post("/api/imports/refresh-prices")

        assert response.json()["updated"] == 0
        fetch.assert_not_called()

    def test_price_status_flags_missing_tickers(self, client, monkeypatch):
        monkeypatch.setattr("src.api.imports.is_market_open", lambda dt=None: False)
        monkeypatch.setattr(
            "src.api.imports.last_market_close", lambda dt=None: datetime(2000, 1, 1)
        )
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate",
            lambda db, now=None, force=False: GateDecision(
                False, MARKET_CLOSED, datetime(2026, 8, 17, 13, 30)
            ),
        )
        _seed_position_without_price(get_database(), "NEWC3")

        response = client.get("/api/imports/price-status")

        assert response.status_code == 200
        data = response.json()
        assert data["market_open"] is False
        assert data["stale_tickers"] == 0
        # A never-fetched ticker must not let the API claim all_fresh.
        assert data["all_fresh"] is False
        assert data["missing_price_tickers"] >= 1
        assert "NEWC3" in data["missing_tickers"]


class TestPriceStatusGate:
    def test_closed_market_reports_zero_stale(self, client, monkeypatch):
        monkeypatch.setattr("src.api.imports.is_market_open", lambda dt=None: False)
        monkeypatch.setattr(
            "src.api.imports.last_market_close", lambda dt=None: datetime(2000, 1, 1)
        )
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate",
            lambda db, now=None, force=False: GateDecision(
                False, MARKET_CLOSED, datetime(2026, 8, 17, 13, 30)
            ),
        )

        response = client.get("/api/imports/price-status")

        assert response.status_code == 200
        data = response.json()
        assert data["market_open"] is False
        assert data["stale_tickers"] == 0
        assert data["all_fresh"] is True
        assert data["next_refresh_at"] == "2026-08-17T13:30:00"

    def test_open_market_uses_hour_threshold(self, client, monkeypatch):
        monkeypatch.setattr("src.api.imports.is_market_open", lambda dt=None: True)
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate",
            lambda db, now=None, force=False: GateDecision(
                True, ALLOWED, TUE_OPEN + timedelta(hours=1)
            ),
        )
        db = get_database()
        _clear_last_pass(db)
        # One ticker 2h old (due), one 30min old (not due).
        _seed_stale_position(db, "VTI")
        db.update_price_cache("VOO", 500.0, previous_close=495.0)  # fresh (just stamped)

        response = client.get("/api/imports/price-status")

        assert response.status_code == 200
        data = response.json()
        assert data["market_open"] is True
        # VTI (30h old) is due; VOO (just stamped) is not. The shared test DB
        # also carries demo-data tickers, so assert relative to the seed.
        assert data["stale_tickers"] >= 1
        assert "VTI" in db.get_stale_tickers(max_age_hours=1)
        assert "VOO" not in db.get_stale_tickers(max_age_hours=1)


class TestStaleTickersSemantics:
    def test_get_stale_tickers_hour_threshold(self):
        db = get_database()
        _seed_stale_position(db, "VTI")
        db.update_price_cache("VOO", 500.0, previous_close=495.0)  # just stamped fresh

        stale = db.get_stale_tickers(max_age_hours=1)

        assert "VTI" in stale  # 30h old -> due under the 1h rule
        assert "VOO" not in stale  # fresh under the 1h rule


class TestClosedMarketCatchUp:
    """Market closed but the cache predates the last close (NZ user scenario)."""

    LAST_CLOSE = datetime(2026, 9, 30, 20, 0)

    @pytest.fixture(autouse=True)
    def _cleanup(self):
        def _purge():
            db = get_database()
            with db.get_session() as session:
                session.query(Position).filter_by(name="Vanguard Total Market").delete(
                    synchronize_session=False
                )
                session.query(Account).filter_by(name="Gate Test").delete(
                    synchronize_session=False
                )
                session.commit()

        _purge()
        yield
        _purge()

    def _closed(self, monkeypatch):
        monkeypatch.setattr("src.api.imports.is_market_open", lambda dt=None: False)
        monkeypatch.setattr(
            "src.api.imports.last_market_close", lambda dt=None: self.LAST_CLOSE
        )

    def test_status_reports_pre_close_cache_as_stale(self, client, monkeypatch):
        self._closed(monkeypatch)
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate",
            lambda db, now=None, force=False: GateDecision(
                True, ALLOWED, None, catch_up_cutoff=self.LAST_CLOSE
            ),
        )
        db = get_database()
        _seed_stale_position(db, "VTI")  # cached 30h ago, before the fixed close
        with db.get_session() as session:
            cache = session.query(PriceCache).filter_by(ticker="VTI").first()
            cache.last_updated = self.LAST_CLOSE - timedelta(days=12)  # type: ignore[assignment]
            session.commit()

        data = client.get("/api/imports/price-status").json()

        assert data["market_open"] is False
        assert data["stale_tickers"] >= 1
        assert data["all_fresh"] is False

    def test_refresh_catch_up_fetches_only_pre_close_tickers(self, client, monkeypatch):
        self._closed(monkeypatch)
        monkeypatch.setattr(
            "src.api.imports.evaluate_refresh_gate",
            lambda db, now=None, force=False: GateDecision(
                True, ALLOWED, None, catch_up_cutoff=self.LAST_CLOSE
            ),
        )
        db = get_database()
        _seed_stale_position(db, "VTI")
        with db.get_session() as session:
            cache = session.query(PriceCache).filter_by(ticker="VTI").first()
            cache.last_updated = self.LAST_CLOSE - timedelta(days=12)  # type: ignore[assignment]
            session.commit()
        db.update_price_cache("VOO", 500.0)
        with db.get_session() as session:
            voo = session.query(PriceCache).filter_by(ticker="VOO").first()
            voo.last_updated = self.LAST_CLOSE + timedelta(hours=1)  # type: ignore[assignment]
            session.commit()
        fetch = _fake_fetch({"success": ["VTI"], "skipped": [], "failed": []})
        monkeypatch.setattr(FolderScanner, "_fetch_and_update_prices", fetch)

        data = client.post("/api/imports/refresh-prices?force=true").json()

        fetch.assert_called_once()
        attempted = fetch.call_args[0][0]
        assert "VTI" in attempted
        assert "VOO" not in attempted
        assert data["updated"] == 1
        assert data["market_open"] is False
        assert data["attempted"] == len(attempted)
