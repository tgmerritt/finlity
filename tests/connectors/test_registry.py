"""Connector package basics: credential masking, the error catalog, limits,
the provider registry and its deployment gating (design 5.1, 5.3, 8.5, C8).

Everything here is offline and stateless.
"""

from __future__ import annotations

import ast
import dataclasses
import logging
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from src.connectors import errors as cerrors
from src.connectors import limits
from src.connectors import registry
from src.connectors.errors import CONNECTOR_ERRORS, ConnectorError
from src.connectors.types import (
    AccountRequest,
    bounded_amount,
    AkahuCredentials,
    Credentials,
    DemoCredentials,
    ProviderAccount,
    ProviderTxn,
    SimpleFinCredentials,
)
from src.smart_import import limits as si_limits
from src.smart_import import types as si_types
from src.smart_import.errors import SmartImportError

EM_DASH = "\u2014"
ROOT = Path(__file__).resolve().parents[2]
PASSWORD = "s3cr3t-Pa55word"
TOKEN = "user_token_abcdefghijklmnop"
APP_TOKEN = "app_token_qrstuvwxyz"


def _all_credentials() -> list[Credentials]:
    return [
        SimpleFinCredentials(
            base_url="https://beta-bridge.simplefin.org/simplefin",
            username="someuser",
            password=PASSWORD,
        ),
        AkahuCredentials(user_token=TOKEN, app_token=APP_TOKEN),
        DemoCredentials(),
    ]


# --- Credentials --------------------------------------------------------------


@pytest.mark.parametrize("creds", _all_credentials(), ids=lambda c: type(c).__name__)
def test_credentials_never_render_their_fields(creds, caplog):
    assert repr(creds) == "<credentials>"
    assert str(creds) == "<credentials>"
    assert f"{creds}" == "<credentials>"
    assert f"{creds!r}" == "<credentials>"
    assert "%s %r" % (creds, creds) == "<credentials> <credentials>"
    assert repr([creds]) == "[<credentials>]"
    assert repr({"c": creds}) == "{'c': <credentials>}"
    with caplog.at_level(logging.DEBUG):
        logging.getLogger("test.connectors").debug("creds %s %r", creds, creds)
    for secret in (PASSWORD, TOKEN, APP_TOKEN, "someuser"):
        assert secret not in caplog.text


def test_credentials_are_frozen():
    creds = _all_credentials()[0]
    assert isinstance(creds, Credentials)
    with pytest.raises(dataclasses.FrozenInstanceError):
        creds.password = "x"  # type: ignore[misc]


def test_credentials_in_an_exception_do_not_leak():
    creds = _all_credentials()[1]
    exc = ValueError(creds)
    assert TOKEN not in str(exc) and TOKEN not in repr(exc)


def test_provider_rows_hide_content_in_repr():
    acct = ProviderAccount(
        provider_account_id="ACT-1",
        name="Everyday Planted Name",
        institution="Planted Bank",
        currency="USD",
        balance=Decimal("1234.56"),
        balance_date=date(2026, 10, 1),
        kind_guess="checking",
        account_key="acct:abc",
    )
    txn = ProviderTxn(
        id="TX-1",
        posted=date(2026, 10, 1),
        amount=Decimal("-42.17"),
        description="PLANTED MERCHANT",
        payee="Planted Payee",
    )
    text = repr(acct) + repr(txn) + str(acct) + str(txn)
    for planted in ("Planted", "PLANTED", "1234.56", "42.17"):
        assert planted not in text


def _all_subclasses(cls: type) -> list[type]:
    out = []
    for sub in cls.__subclasses__():
        out.append(sub)
        out.extend(_all_subclasses(sub))
    return out


def test_every_credentials_subclass_hides_its_fields():
    # Import every connector module so subclasses defined anywhere are seen.
    import importlib
    import pkgutil

    import src.connectors as pkg

    for mod in pkgutil.iter_modules(pkg.__path__):
        importlib.import_module(f"src.connectors.{mod.name}")
    subclasses = [
        c for c in _all_subclasses(Credentials) if c.__module__.startswith("src.")
    ]
    assert {SimpleFinCredentials, AkahuCredentials, DemoCredentials} <= set(subclasses)
    for sub in subclasses:
        # A @dataclass without repr=False would generate its own __repr__.
        assert sub.__repr__ is Credentials.__repr__, sub.__name__
        assert sub.__str__ is Credentials.__str__, sub.__name__
        assert sub.__format__ is Credentials.__format__, sub.__name__


def test_the_subclass_guard_catches_a_generated_repr():
    @dataclasses.dataclass(frozen=True)
    class Leaky(Credentials):
        token: str

    try:
        assert Leaky.__repr__ is not Credentials.__repr__
        assert "tok" in repr(Leaky(token="tok"))
    finally:
        del Leaky


@pytest.mark.parametrize(
    "value, expected",
    [
        (Decimal("-12.30"), Decimal("-12.30")),
        ("-12.30", Decimal("-12.30")),
        (" 42 ", Decimal("42")),
        (7, Decimal("7")),
        (10_000_000_000, Decimal("10000000000")),
        ("1e10", Decimal("1e10")),
        (Decimal("-1e10"), Decimal("-1e10")),
    ],
)
def test_bounded_amount_accepts(value, expected):
    assert bounded_amount(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        None,
        True,
        1.5,
        "",
        "abc",
        "NaN",
        "-Infinity",
        "sNaN",
        Decimal("NaN"),
        Decimal("Infinity"),
        "1e11",
        "1E999999999",
        Decimal("-10000000000.01"),
        10_000_000_001,
        10**400,
        "1" * 41,
        [1],
    ],
)
def test_bounded_amount_refuses(value):
    assert bounded_amount(value) is None


def test_account_request_shape():
    req = AccountRequest(
        provider_account_id="ACT-1",
        since=date(2026, 9, 1),
        account_key="acct:abc",
        kind="credit_card",
        flip_balance=False,
    )
    assert req.kind == "credit_card" and req.flip_balance is False


# --- error catalog ------------------------------------------------------------

EXPECTED_STATUS = {
    "bad_setup_token": 422,
    "claim_refused": 422,
    "host_not_allowed": 422,
    "reconnect_needed": 409,
    "payment_required": 409,
    "provider_rate_limited": 429,
    "quota_reached": 429,
    "window_too_long": 422,
    "provider_timeout": 504,
    "response_too_large": 502,
    "provider_bad_response": 502,
    "provider_unavailable": 502,
    "connector_disabled": 503,
    "connections_unavailable": 403,
    "connection_not_found": 404,
    # Server-mode connection service (plan B2 review).
    "connection_limit": 422,
    "claim_not_saved": 500,
    "claim_timeout": 504,
    "request_time_short": 503,
}


def test_catalog_matches_design_5_3():
    assert {k: v[0] for k, v in CONNECTOR_ERRORS.items()} == EXPECTED_STATUS


@pytest.mark.parametrize("error_type", sorted(CONNECTOR_ERRORS))
def test_every_catalog_entry_has_a_fixed_detail(error_type):
    status, detail = CONNECTOR_ERRORS[error_type]
    assert detail and detail.strip() == detail
    for ch in ("{", "}", "%", "<", ">", EM_DASH):
        assert ch not in detail, (error_type, ch)
    exc = ConnectorError(error_type)
    assert isinstance(exc, SmartImportError)
    assert exc.status == status
    assert exc.detail == detail
    assert str(exc) == detail
    assert exc.body() == {"error_type": error_type, "detail": detail}


def test_connector_error_reuses_smart_import_codes():
    exc = ConnectorError("bad_request")
    assert exc.status == 422
    assert exc.body()["detail"] == SmartImportError("bad_request").detail


def test_connector_error_refuses_an_unknown_code():
    with pytest.raises(ValueError):
        ConnectorError("not_a_code")


def test_claim_refused_carries_the_protocol_advice():
    detail = CONNECTOR_ERRORS["claim_refused"][1]
    assert "already used" in detail and "SimpleFIN Bridge" in detail


# --- limits -------------------------------------------------------------------


def test_limits_match_design_8_5():
    assert limits.MAX_WINDOW_DAYS == 90
    assert limits.MAX_WINDOWS_PER_SYNC == 4
    assert limits.MAX_RESPONSE_BYTES == si_limits.MAX_FILE_BYTES
    assert limits.MAX_ACCOUNTS == 50
    assert limits.MAX_TXNS_PER_ACCOUNT == si_limits.MAX_TRANSACTIONS_PER_STATEMENT
    assert limits.MAX_AKAHU_PAGES == 20
    assert limits.CALL_WALL_CLOCK_SECONDS == 20.0
    assert limits.CONNECT_TIMEOUT_SECONDS == 5.0
    assert limits.READ_TIMEOUT_SECONDS == 15.0
    assert limits.POOL_TIMEOUT_SECONDS == 5.0
    assert limits.MAX_CONNECTIONS == 10
    assert limits.DAILY_BUDGET == {"simplefin": 20, "akahu": 48}
    assert "demo" not in limits.DAILY_BUDGET


# --- warnings -----------------------------------------------------------------


def test_connector_warning_codes_are_in_the_vocabulary():
    assert {
        "connector_account_error",
        "connector_partial",
        "connector_balance_only",
        "currency_unsupported",
        "connector_sign_check",
    } <= set(si_types.WARNINGS)


# --- registry -----------------------------------------------------------------


@pytest.fixture
def clean_env(monkeypatch):
    for name in ("DYNO", "MULTI_USER_MODE", "CONNECTORS_ENABLED", "PROTECT_DEMO_DATA"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_server_mode_enables_every_provider(clean_env):
    assert registry.enabled_providers() == list(registry.PROVIDER_IDS)
    assert set(registry.PROVIDER_IDS) == {"simplefin", "akahu", "demo"}


def test_heroku_without_flag_enables_only_demo(clean_env):
    clean_env.setenv("DYNO", "web.1")
    assert registry.enabled_providers() == ["demo"]


@pytest.mark.parametrize("value", ["true", "1", "YES", " true "])
def test_heroku_with_flag_enables_real_providers(clean_env, value):
    clean_env.setenv("DYNO", "web.1")
    clean_env.setenv("CONNECTORS_ENABLED", value)
    assert registry.enabled_providers() == list(registry.PROVIDER_IDS)


@pytest.mark.parametrize("value", ["false", "0", "", "on"])
def test_heroku_flag_must_be_explicitly_true(clean_env, value):
    clean_env.setenv("DYNO", "web.1")
    clean_env.setenv("CONNECTORS_ENABLED", value)
    assert registry.enabled_providers() == ["demo"]


@pytest.mark.parametrize(
    "env",
    [
        {"MULTI_USER_MODE": "true"},
        {"DYNO": "web.1"},
        {"PROTECT_DEMO_DATA": "1"},
        {"DYNO": "web.1", "MULTI_USER_MODE": "true"},
    ],
)
def test_any_shared_deployment_needs_the_opt_in(clean_env, env):
    # E8 as revised after review: the opt-in applies to every shared
    # deployment, not only Heroku.
    for k, v in env.items():
        clean_env.setenv(k, v)
    assert registry.enabled_providers() == ["demo"]
    clean_env.setenv("CONNECTORS_ENABLED", "true")
    assert registry.enabled_providers() == list(registry.PROVIDER_IDS)


def test_demo_is_always_enabled(clean_env):
    for env in ({}, {"DYNO": "web.1"}, {"MULTI_USER_MODE": "true"}):
        for k, v in env.items():
            clean_env.setenv(k, v)
        assert "demo" in registry.enabled_providers()


def test_is_enabled(clean_env):
    assert registry.is_enabled("simplefin")
    clean_env.setenv("DYNO", "web.1")
    assert not registry.is_enabled("simplefin")
    assert registry.is_enabled("demo")
    assert not registry.is_enabled("nope")


@pytest.mark.parametrize("bad", ["nope", "", "SIMPLEFIN", "demo ", "../demo", None, 3])
def test_unknown_provider_is_bad_request(bad):
    with pytest.raises(ConnectorError) as info:
        registry.get_provider(bad)  # type: ignore[arg-type]
    assert info.value.error_type == "bad_request"


def test_get_provider_returns_the_registered_factory_result(monkeypatch):
    class Fake:
        id = "demo"
        display_name = "Demo"
        max_window_days = 90
        daily_request_budget = None

    monkeypatch.setitem(registry._FACTORIES, "demo", Fake)
    assert isinstance(registry.get_provider("demo"), Fake)


def test_shared_deployment_mirrors_is_multi_user_mode(clean_env):
    from src.connectors.env import shared_deployment

    assert shared_deployment() is False
    for name, value in (
        ("MULTI_USER_MODE", "true"),
        ("DYNO", "web.1"),
        ("PROTECT_DEMO_DATA", "yes"),
    ):
        clean_env.setenv(name, value)
        assert shared_deployment() is True
        clean_env.delenv(name)
    assert shared_deployment() is False


# --- source hygiene -----------------------------------------------------------

_BANNED_OS_PREFIXES = ("fork", "exec", "spawn", "posix_spawn", "system", "popen")
# Module names are listed as one string so the list reads as data.
_BANNED_TOP = frozenset(
    (
        "xml lxml sqlalchemy subprocess importlib multiprocessing requests "
        "curl_cffi urllib3 yfinance shelve marshal pick" + "le"
    ).split()
)
_BANNED_FULL = ("urllib.request", "src.database", "src.services", "http.client")
# The server data layer (plan B1) lives in this package but is not part of the
# stateless core: only these modules may reach the database and the secrets
# manager, and only through these exact imports. Nothing in the core or the
# v2 routes imports them (test_store.py checks that).
_DATA_LAYER_IMPORTS = {
    "store.py": frozenset({"src.database", "src.services.secrets"}),
}


def test_connector_core_imports_nothing_stateful_or_dangerous():
    root = ROOT / "src" / "connectors"
    # http.py pins connections to a vetted address, so it alone resolves names.
    allowed = {("http.py", "socket")}
    seen = 0
    for path in root.rglob("*.py"):
        seen += 1
        rel = path.relative_to(root).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names = [node.module]
            elif isinstance(node, ast.ImportFrom) and node.level > 1:
                names = ["src." + (node.module or "")]
            for n in names:
                if n in _DATA_LAYER_IMPORTS.get(rel, ()):
                    continue
                top = n.split(".")[0]
                assert top not in _BANNED_TOP, f"{rel} imports {n}"
                assert not any(n == b or n.startswith(b + ".") for b in _BANNED_FULL), (
                    f"{rel} imports {n}"
                )
                if top == "socket":
                    assert (rel, top) in allowed, f"{rel} imports socket"
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                if node.value.id == "os":
                    assert not node.attr.startswith(_BANNED_OS_PREFIXES), rel
            if isinstance(node, ast.Name):
                assert node.id != "__import__", rel
            if isinstance(node, ast.Call):
                assert not any(k.arg == "shell" for k in node.keywords), rel
                func = node.func
                name = getattr(func, "attr", getattr(func, "id", ""))
                assert name not in ("system", "popen", "Popen", "eval", "exec"), rel
    assert seen >= 6


def test_no_em_dash_in_connector_sources_or_tests():
    files = list((ROOT / "src" / "connectors").rglob("*.py")) + list(
        (ROOT / "tests" / "connectors").rglob("*.py")
    )
    assert files
    for path in files:
        assert EM_DASH not in path.read_text(encoding="utf-8"), path.name


def test_errors_module_has_no_dynamic_detail():
    # Details are literals: no f-strings or format calls in the catalog module.
    tree = ast.parse(Path(cerrors.__file__).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        assert not isinstance(node, ast.JoinedStr)
        if isinstance(node, ast.Call):
            assert getattr(node.func, "attr", "") != "format"
