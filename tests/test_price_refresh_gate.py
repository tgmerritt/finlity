"""Unit tests for the price-refresh decision gate.

The gate's market-clock calls are patched; the AppSettings persistence
layer is exercised against the real isolated test DB.
"""

from datetime import datetime, timedelta, timezone

from src.database.profile_manager import get_database
from src.services.price_refresh_gate import (
    ALLOWED,
    LAST_REFRESH_KEY,
    MARKET_CLOSED,
    TOO_SOON,
    evaluate_refresh_gate,
    record_refresh_pass,
)

TUE_OPEN = datetime(2026, 8, 11, 15, 0, tzinfo=timezone.utc)  # 11:00 ET


def _clear_last_pass(db) -> None:
    from src.database.models import AppSettings

    with db.get_session() as session:
        session.query(AppSettings).filter_by(key=LAST_REFRESH_KEY).delete()
        session.commit()


def _patched_open(monkeypatch):
    monkeypatch.setattr("src.services.price_refresh_gate.is_market_open", lambda dt=None: True)
    monkeypatch.setattr("src.services.price_refresh_gate.next_market_open", lambda dt=None: None)


def test_market_closed_blocks_refresh(monkeypatch):
    monkeypatch.setattr(
        "src.services.price_refresh_gate.is_market_open", lambda dt=None: False
    )
    monkeypatch.setattr(
        "src.services.price_refresh_gate.next_market_open",
        lambda dt=None: datetime(2026, 8, 17, 13, 30),
    )
    db = get_database()

    decision = evaluate_refresh_gate(db, now=TUE_OPEN)

    assert decision.allowed is False
    assert decision.reason == MARKET_CLOSED
    assert decision.next_refresh_at == datetime(2026, 8, 17, 13, 30)


def test_no_prior_pass_allows_refresh(monkeypatch):
    _patched_open(monkeypatch)
    db = get_database()
    _clear_last_pass(db)

    decision = evaluate_refresh_gate(db, now=TUE_OPEN)

    assert decision.allowed is True
    assert decision.reason == ALLOWED


def test_recent_pass_blocks_with_next_refresh(monkeypatch):
    _patched_open(monkeypatch)
    db = get_database()
    _clear_last_pass(db)
    record_refresh_pass(db, now=TUE_OPEN - timedelta(minutes=30))

    decision = evaluate_refresh_gate(db, now=TUE_OPEN)

    assert decision.allowed is False
    assert decision.reason == TOO_SOON
    # The gate reports naive UTC.
    assert decision.next_refresh_at == TUE_OPEN.replace(tzinfo=None) + timedelta(minutes=30)


def test_old_pass_allows_refresh(monkeypatch):
    _patched_open(monkeypatch)
    db = get_database()
    _clear_last_pass(db)
    record_refresh_pass(db, now=TUE_OPEN - timedelta(hours=2))

    decision = evaluate_refresh_gate(db, now=TUE_OPEN)

    assert decision.allowed is True
    assert decision.reason == ALLOWED


def test_force_bypasses_hourly_cap_not_market_closed(monkeypatch):
    _patched_open(monkeypatch)
    db = get_database()
    _clear_last_pass(db)
    record_refresh_pass(db, now=TUE_OPEN - timedelta(minutes=10))

    # force=True: the hourly cap is bypassed...
    assert evaluate_refresh_gate(db, now=TUE_OPEN, force=True).allowed is True

    # ...but the market-closed rule still applies.
    monkeypatch.setattr("src.services.price_refresh_gate.is_market_open", lambda dt=None: False)
    decision = evaluate_refresh_gate(db, now=TUE_OPEN, force=True)
    assert decision.allowed is False
    assert decision.reason == MARKET_CLOSED


def test_recorded_pass_persists(monkeypatch):
    _patched_open(monkeypatch)
    db = get_database()
    _clear_last_pass(db)
    record_refresh_pass(db, now=TUE_OPEN)

    # A pass recorded at TUE_OPEN blocks a refresh evaluated 1 second later.
    decision = evaluate_refresh_gate(db, now=TUE_OPEN + timedelta(seconds=1))
    assert decision.allowed is False
    assert decision.reason == TOO_SOON
