"""
Pytest configuration and fixtures for the test suite.

Database isolation happens at IMPORT time, not in a fixture: the app caches
its Database singleton on first use, so the isolation env vars must be in
place before ANY test module imports src.main or creates a TestClient.
Fixture-based isolation (the old test_env approach) silently leaked test
writes into the real data/databases/default/portfolio.db whenever a test
that didn't request the fixture ran first.
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# --- Import-time test isolation (must precede any src.* import) ---
_REPO_ROOT = Path(__file__).parent.parent
_TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="finlity-tests-"))
for _sub in ("imports", "databases/default", "cache", "demo"):
    (_TEST_DATA_DIR / _sub).mkdir(parents=True, exist_ok=True)

# Seed the isolated demo DB from the tracked copy so tests see the same
# demo data CI sees (CI runs from a fresh checkout with no PORTFOLIO_DATA_DIR).
_tracked_demo = _REPO_ROOT / "data" / "demo" / "demo.db"
if _tracked_demo.exists():
    shutil.copy2(_tracked_demo, _TEST_DATA_DIR / "demo" / "demo.db")

# setdefault: explicit env (e.g. CI) still wins.
os.environ.setdefault("PORTFOLIO_DATA_DIR", str(_TEST_DATA_DIR))
os.environ.setdefault("PORTFOLIO_DEMO_MODE", "true")
os.environ.setdefault("PORTFOLIO_TEST_MODE", "true")


@pytest.fixture(scope="session")
def temp_data_dir():
    """The session-wide isolated data directory (created at import time)."""
    yield str(_TEST_DATA_DIR)


@pytest.fixture(scope="session")
def test_env(temp_data_dir):
    """Kept for backward compatibility — isolation is now import-time."""
    yield


@pytest.fixture(scope="module")
def app(test_env):
    """Create FastAPI test application."""
    from src.main import app as fastapi_app
    return fastapi_app


@pytest.fixture(scope="module")
def client(app):
    """Create test client."""
    from fastapi.testclient import TestClient
    return TestClient(app)


@pytest.fixture
def sample_position():
    """Sample position data for testing."""
    return {
        "ticker": "VTI",
        "name": "Vanguard Total Stock Market ETF",
        "shares": 100,
        "cost_basis": 20000,
        "current_price": 220,
        "sector": "Broad Market",
        "is_fund": True,
        "asset_class": "US Equity"
    }


@pytest.fixture
def sample_account():
    """Sample account data for testing."""
    return {
        "name": "Test Roth IRA",
        "account_type": "roth_ira",
        "brokerage": "Vanguard"
    }


@pytest.fixture
def sample_income_source():
    """Sample income source for budget tests."""
    return {
        "name": "Test Job",
        "income_type": "employment",
        "gross_annual": 100000,
        "pay_frequency": "biweekly",
        "state": "CA"
    }


@pytest.fixture
def sample_expense():
    """Sample expense for budget tests."""
    return {
        "name": "Rent",
        "category_id": "1",
        "amount": 2000,
        "frequency": "monthly"
    }


@pytest.fixture
def sample_trigger():
    """Sample allocation trigger for testing."""
    return {
        "name": "Test Trigger",
        "condition_type": "ticker_percent",
        "ticker": "VTI",
        "operator": ">",
        "threshold": 10,
        "is_active": True
    }
