"""
Tests for Analysis API endpoints.
"""

import pytest

from src.api.analysis import _compute_expense_drag, BENCHMARK_ER


class TestAnalysisAPI:
    """Test analysis API endpoints."""

    def test_get_allocation(self, client):
        """Test getting basic allocation breakdown."""
        response = client.get("/api/analysis/allocation")
        assert response.status_code == 200
        data = response.json()
        assert "by_account_type" in data or "total" in data or isinstance(data, dict)

    def test_get_detailed_allocation(self, client):
        """Test getting detailed allocation breakdown."""
        response = client.get("/api/analysis/allocation/detailed")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)

    def test_get_performance_metrics(self, client):
        """Test getting performance metrics."""
        response = client.get("/api/analysis/performance")
        assert response.status_code == 200
        data = response.json()
        # Should return performance data or empty structure
        assert isinstance(data, dict)

    def test_get_risk_metrics(self, client):
        """Test getting risk metrics."""
        response = client.get("/api/analysis/risk")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)


class TestTriggersAPI:
    """Test allocation triggers API."""

    def test_list_triggers(self, client):
        """Test listing triggers."""
        response = client.get("/api/analysis/triggers")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_create_trigger(self, client, sample_trigger):
        """Test creating a trigger."""
        response = client.post("/api/analysis/triggers", json=sample_trigger)
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == sample_trigger["name"]
        assert data["condition_type"] == sample_trigger["condition_type"]
        assert "id" in data

    def test_evaluate_triggers(self, client):
        """Test evaluating triggers."""
        response = client.get("/api/analysis/triggers/evaluate")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_get_triggered_alerts(self, client):
        """Test getting triggered alerts."""
        response = client.get("/api/analysis/triggers/triggered")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)


class TestWidgetsAPI:
    """Test widget endpoints."""

    def test_list_widgets(self, client):
        """Test listing available widgets."""
        response = client.get("/api/analysis/widgets")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, (list, dict))


class TestExpenseDrag:
    """Test expense ratio drag calculation and endpoint."""

    def test_compute_expense_drag_happy_path(self):
        """Synthetic portfolio: weighted ER, dollar drag, top holdings."""
        # 3 funds, 1 stock with no ER
        positions = [
            ("VTI", 50000.0, 0.0003),    # cheap fund (3 bps)
            ("ARKK", 30000.0, 0.0075),   # expensive fund (75 bps)
            ("VXUS", 20000.0, 0.0008),   # mid fund (8 bps)
            ("AAPL", 12000.0, None),     # stock - uncovered
        ]
        result = _compute_expense_drag(positions, benchmark_er=0.0004, top_n=5)

        # covered = 100k; uncovered = 12k
        assert result["covered_value"] == pytest.approx(100000.0)
        assert result["uncovered_value"] == pytest.approx(12000.0)

        # Weighted ER = (50000*.0003 + 30000*.0075 + 20000*.0008) / 100000
        # = (15 + 225 + 16) / 100000 = 256 / 100000 = 0.00256
        assert result["portfolio_expense_ratio"] == pytest.approx(0.00256)

        # benchmark = 0.0004 → drag rate = 0.00256 - 0.0004 = 0.00216
        # annual drag $ = 100000 * 0.00216 = $216
        assert result["annual_drag_dollars"] == pytest.approx(216.0)

        # bps = (0.00256 - 0.0004) * 10000 = 21.6
        assert result["annual_drag_basis_points"] == pytest.approx(21.6)

        # ARKK has highest per-holding drag (30000 * (0.0075 - 0.0004) = 213).
        top = result["top_drag_holdings"]
        assert len(top) == 3  # AAPL excluded (no ER)
        assert top[0]["ticker"] == "ARKK"
        assert top[0]["annual_drag_dollars"] == pytest.approx(30000 * (0.0075 - 0.0004))
        # Sorted descending
        for prev, nxt in zip(top, top[1:]):
            assert prev["annual_drag_dollars"] >= nxt["annual_drag_dollars"]

    def test_compute_expense_drag_no_funds(self):
        """All positions are individual stocks → covered=0, drag=0."""
        positions = [
            ("AAPL", 5000.0, None),
            ("MSFT", 3000.0, None),
        ]
        result = _compute_expense_drag(positions, benchmark_er=BENCHMARK_ER)
        assert result["covered_value"] == 0
        assert result["uncovered_value"] == pytest.approx(8000.0)
        assert result["portfolio_expense_ratio"] == 0
        assert result["annual_drag_dollars"] == 0
        assert result["top_drag_holdings"] == []

    def test_compute_expense_drag_below_benchmark(self):
        """Portfolio cheaper than benchmark → no negative drag reported."""
        positions = [
            ("VOO", 100000.0, 0.0003),  # 3 bps, cheaper than 4 bps benchmark
        ]
        result = _compute_expense_drag(positions, benchmark_er=0.0004)
        # Drag dollars clamped at 0 (we don't credit a "negative drag")
        assert result["annual_drag_dollars"] == 0
        # bps may go slightly negative — that's informational
        assert result["annual_drag_basis_points"] == pytest.approx(-1.0)

    def test_get_expense_drag_endpoint(self, client):
        """Endpoint returns 200 with the expected shape."""
        response = client.get("/api/analysis/expense-drag")
        assert response.status_code == 200
        data = response.json()

        # Required keys present
        for key in [
            "portfolio_expense_ratio",
            "benchmark_expense_ratio",
            "annual_drag_dollars",
            "annual_drag_basis_points",
            "covered_value",
            "uncovered_value",
            "top_drag_holdings",
        ]:
            assert key in data, f"missing key: {key}"

        # Benchmark constant exposed correctly
        assert data["benchmark_expense_ratio"] == pytest.approx(BENCHMARK_ER)
        assert isinstance(data["top_drag_holdings"], list)


class _FakeRequestState:
    def __init__(self, session_id):
        self.session_id = session_id


class _FakeRequest:
    """Minimal stand-in for fastapi.Request — clear_chat_history only reads
    `request.state.session_id` via get_session_id()."""

    def __init__(self, session_id):
        self.state = _FakeRequestState(session_id)


class TestAdvisorChatClearCrossTenant:
    """F4 regression: /advisor/chat/clear used to unconditionally reset the
    entire module-level `_chat_services` dict (`_chat_services = {}}`),
    destroying every other session's in-progress chat state — a cross-tenant
    bug in multi-user deployments (see is_multi_user_mode() in
    src/services/session.py). It must now remove only the caller's own
    session key.

    SessionMiddleware (and therefore a real per-request session_id) is only
    wired up when running in multi-user mode, which is decided at app
    startup — not toggleable per-test against the already-constructed test
    app. So this test drives `clear_chat_history` directly with fake
    Request-like objects carrying distinct `state.session_id` values,
    exactly mirroring what SessionMiddleware would set in production.
    """

    def setup_method(self):
        from src.api import analysis as analysis_module

        analysis_module._chat_services.clear()
        analysis_module._chat_api_keys.clear()

    def teardown_method(self):
        from src.api import analysis as analysis_module

        analysis_module._chat_services.clear()
        analysis_module._chat_api_keys.clear()

    def test_clear_only_removes_callers_own_session(self):
        from src.api import analysis as analysis_module

        # Seed two independent "tenant" sessions directly (no network call
        # needed — clear_chat_history only cares about dict keys).
        analysis_module._chat_services["session-a"] = object()
        analysis_module._chat_services["session-b"] = object()
        analysis_module._chat_api_keys["session-a"] = "key-a"
        analysis_module._chat_api_keys["session-b"] = "key-b"

        result = analysis_module.clear_chat_history(_FakeRequest("session-a"))

        assert result["success"] is True
        assert "session-a" not in analysis_module._chat_services
        assert "session-a" not in analysis_module._chat_api_keys
        # Tenant B's session must survive tenant A's clear.
        assert "session-b" in analysis_module._chat_services
        assert "session-b" in analysis_module._chat_api_keys

    def test_clearing_nonexistent_session_is_a_harmless_noop(self):
        from src.api import analysis as analysis_module

        analysis_module._chat_services["session-b"] = object()

        result = analysis_module.clear_chat_history(_FakeRequest("session-does-not-exist"))

        assert result["success"] is True
        # Nothing else was touched.
        assert "session-b" in analysis_module._chat_services

    def test_no_session_id_falls_back_to_default_key(self):
        """Single-user/local mode: SessionMiddleware isn't active, so
        request.state.session_id is None/absent and every caller shares the
        "default" key — matches pre-fix local behavior exactly."""
        from src.api import analysis as analysis_module

        analysis_module._chat_services["default"] = object()

        result = analysis_module.clear_chat_history(_FakeRequest(None))

        assert result["success"] is True
        assert "default" not in analysis_module._chat_services
