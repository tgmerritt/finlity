"""Per-process quota backstop for the v2 connector routes (design 8.4, E7)."""

from __future__ import annotations

import pytest

from src.connectors import quota
from src.connectors.errors import ConnectorError
from src.connectors.types import (
    AkahuCredentials,
    DemoCredentials,
    SimpleFinCredentials,
)

DAY = 24 * 60 * 60


class Clock:
    def __init__(self, start: float = 1_000_000.0):
        self.t = start

    def __call__(self) -> float:
        return self.t


def _sf(
    user: str = "u1", password: str = "p1", host: str = "beta-bridge"
) -> SimpleFinCredentials:
    return SimpleFinCredentials(
        base_url=f"https://{host}.simplefin.org/simplefin",
        username=user,
        password=password,
    )


def test_simplefin_allows_20_then_refuses_the_21st():
    clock = Clock()
    q = quota.ProcessQuota(now=clock)
    fp = quota.fingerprint(_sf())
    for _ in range(20):
        q.check_and_record("simplefin", fp)
    with pytest.raises(ConnectorError) as info:
        q.check_and_record("simplefin", fp)
    assert info.value.error_type == "quota_reached"
    assert info.value.status == 429


def test_a_different_credential_has_its_own_budget():
    q = quota.ProcessQuota(now=Clock())
    first = quota.fingerprint(_sf("u1", "p1"))
    other = quota.fingerprint(_sf("u2", "p2"))
    for _ in range(20):
        q.check_and_record("simplefin", first)
    q.check_and_record("simplefin", other)


def test_the_window_is_rolling_24_hours():
    clock = Clock()
    q = quota.ProcessQuota(now=clock)
    fp = quota.fingerprint(_sf())
    for _ in range(20):
        q.check_and_record("simplefin", fp)
        clock.t += 60
    clock.t += DAY - 20 * 60  # the first call is exactly 24 hours old
    q.check_and_record("simplefin", fp)
    with pytest.raises(ConnectorError):
        q.check_and_record("simplefin", fp)


def test_akahu_budget_is_48_and_demo_is_unlimited():
    q = quota.ProcessQuota(now=Clock())
    fp = quota.fingerprint(
        AkahuCredentials(user_token="user_token_a", app_token="app_token_b")
    )
    for _ in range(48):
        q.check_and_record("akahu", fp)
    with pytest.raises(ConnectorError):
        q.check_and_record("akahu", fp)
    for _ in range(500):
        q.check_and_record("demo", None)
    assert quota.fingerprint(DemoCredentials()) is None


def test_record_never_raises_but_counts():
    q = quota.ProcessQuota(now=Clock())
    fp = quota.fingerprint(_sf())
    for _ in range(25):
        q.record("simplefin", fp)
    with pytest.raises(ConnectorError):
        q.check_and_record("simplefin", fp)


def test_both_bridge_hosts_share_one_budget():
    # bridge and beta-bridge are one service; switching host must not double it.
    assert quota.fingerprint(_sf(host="bridge")) == quota.fingerprint(
        _sf(host="beta-bridge")
    )


def test_fingerprint_is_keyed_and_holds_no_credential():
    creds = _sf("planteduser", "Pl4nted-Pa55word")
    fp = quota.fingerprint(creds)
    assert isinstance(fp, str) and len(fp) == 64
    assert "planteduser" not in fp and "Pl4nted" not in fp
    # A keyed hash: the bare SHA-256 of the same material differs.
    import hashlib

    assert fp != hashlib.sha256(b"planteduser").hexdigest()
    assert quota.fingerprint(_sf("planteduser", "other")) != fp


def test_the_key_is_random_per_process_and_32_bytes():
    assert isinstance(quota._KEY, bytes) and len(quota._KEY) == 32


def test_the_counter_stores_no_credential_and_is_bounded():
    clock = Clock()
    q = quota.ProcessQuota(now=clock, max_keys=5)
    for i in range(12):
        q.check_and_record("simplefin", quota.fingerprint(_sf(f"user{i}", "secretpw")))
    assert q.tracked() <= 5
    assert "secretpw" not in repr(q.__dict__)


def test_expired_entries_are_pruned():
    clock = Clock()
    q = quota.ProcessQuota(now=clock, max_keys=3)
    for i in range(3):
        q.check_and_record("simplefin", quota.fingerprint(_sf(f"u{i}")))
    clock.t += DAY + 1
    q.check_and_record("simplefin", quota.fingerprint(_sf("fresh")))
    assert q.tracked() == 1


def test_unknown_or_missing_fingerprint_for_a_budgeted_provider_is_bad_request():
    q = quota.ProcessQuota(now=Clock())
    with pytest.raises(ConnectorError) as info:
        q.check_and_record("simplefin", None)
    assert info.value.error_type == "bad_request"
