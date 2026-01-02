"""
Pytest configuration and fixtures for the test suite.
"""

import os
import sys
import tempfile
import pytest
from pathlib import Path

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))


@pytest.fixture(scope="session")
def temp_data_dir():
    """Create a temporary data directory for tests."""
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create subdirectories
        os.makedirs(os.path.join(tmpdir, "imports"), exist_ok=True)
        os.makedirs(os.path.join(tmpdir, "databases", "default"), exist_ok=True)
        os.makedirs(os.path.join(tmpdir, "cache"), exist_ok=True)
        yield tmpdir


@pytest.fixture(scope="session")
def test_env(temp_data_dir):
    """Set up test environment variables."""
    original_env = os.environ.copy()

    # Set test environment
    os.environ["PORTFOLIO_DATA_DIR"] = temp_data_dir
    os.environ["PORTFOLIO_DEMO_MODE"] = "true"
    os.environ["PORTFOLIO_TEST_MODE"] = "true"

    yield

    # Restore original environment
    os.environ.clear()
    os.environ.update(original_env)


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
