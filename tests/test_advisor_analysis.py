"""Tests for src/services/advisor_analysis.py.

F7 regression: analyze_fund's catch-all `except Exception` used to log at
WARNING with no traceback (`logger.warning(f"AI API error for {ticker}: {e}")`),
making unexpected provider failures hard to diagnose. It must now use
`logger.exception(...)` so the traceback is captured, while returning the
same None result to the caller.
"""

import logging

from src.services.advisor_analysis import AdvisorAnalysisService


class _BoomProvider:
    """Stub provider whose .complete() raises a generic (non-JSON,
    non-InferenceProviderError) exception, exercising the bare
    `except Exception` branch in analyze_fund."""

    def complete(self, *args, **kwargs):
        raise RuntimeError("boom: unexpected provider failure")


class TestAnalyzeFundDiagnosability:
    def test_generic_provider_error_is_logged_with_traceback(self, caplog):
        service = AdvisorAnalysisService(claude_api_key="fake-key-not-used")
        service._provider = _BoomProvider()  # bypass real provider construction

        with caplog.at_level(logging.ERROR, logger="src.services.advisor_analysis"):
            result = service.analyze_fund(ticker="VTI", fund_name="Vanguard Total Market")

        # Same observable behavior as before: caller gets None back.
        assert result is None

        # But now a traceback is captured (logger.exception), not a bare
        # warning with only the stringified exception.
        error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert error_records, "expected an ERROR-level log record from logger.exception"
        assert any(r.exc_info for r in error_records), (
            "expected at least one log record to carry exc_info (traceback), "
            "confirming logger.exception was used instead of logger.warning"
        )
        assert any("VTI" in r.getMessage() for r in error_records)
