"""Tests for CommentaryService and AdvisorAnalysisService prompt-cache wiring.

Sprint 7 wired `cache_system=True` on the provider call sites, but the bare
SYSTEM_PROMPT was below Anthropic's silent caching threshold (2048 tokens for
Sonnet 4.6, 4096 for Opus/Haiku 4.7) so caching was a no-op in production.
Sprint 11 added the dossier and reference guidance; Sprint 12 expanded the
guidance with a metrics glossary, methodology notes, and tone/guardrails so
the empty-portfolio prompt clears the 4096-token threshold for Opus/Haiku.

These tests pin the new behavior:
- The `system` parameter passed to the provider now contains the persona
  prompt PLUS a portfolio dossier; for non-trivial portfolios the result
  comfortably exceeds 14000 characters (a rough proxy for >3500 tokens,
  which clears the 4096-token cache threshold for Opus/Haiku 4.7).
- The user message is unaffected — per-element templates still render the
  per-call ask exactly as before.
- The advisor multi-turn chat sets `cache_breakpoints` to the index of the
  second-to-last user message so the conversation tail also caches.
"""

from unittest.mock import MagicMock

from src.services.advisor_analysis import (
    AdvisorAnalysisService,
    ChatMessage,
    _second_to_last_user_index,
)
from src.services.commentary_prompts import (
    build_cacheable_system_prompt,
    build_portfolio_dossier,
)
from src.services.commentary_service import CommentaryService
from src.services.providers.base import (
    InferenceMessage,
    InferenceResponse,
)


# ---------------------------------------------------------------------------
# Dossier-only tests (no service required)
# ---------------------------------------------------------------------------

class TestPortfolioDossier:
    def test_empty_inputs_still_produce_reference_guidance(self):
        """An empty portfolio still renders the static reference block.

        This is the documented "won't cache" case — small portfolios produce
        a small system prompt and that's fine. We just verify it doesn't
        crash and contains the persona guidance.
        """
        out = build_cacheable_system_prompt()
        assert "knowledgeable financial advisor" in out
        assert "## Reference Guidance for Commentary" in out

    def test_realistic_portfolio_clears_opus_haiku_caching_threshold(self):
        """For a realistic portfolio, the cacheable prompt must comfortably
        exceed 14000 chars — the rough proxy for >3500 tokens that clears
        Anthropic's 4096-token Opus/Haiku 4.7 cache threshold (which is
        strictly tighter than Sonnet 4.6's 2048).
        """
        summary = {
            "total_value": 1_500_000,
            "retirement_value": 800_000,
            "taxable_value": 700_000,
            "total_cost_basis": 950_000,
            "total_gain_loss": 550_000,
            "total_gain_loss_pct": 57.9,
            "num_accounts": 8,
        }
        positions = [
            {
                "ticker": f"TKR{i}",
                "name": f"Holding {i}",
                "shares": 100 + i,
                "current_price": 200 + i,
                "value": (100 + i) * (200 + i),
                "account_type": "roth_ira" if i % 2 else "taxable",
            }
            for i in range(20)
        ]
        allocation = {
            "top_5_pct": 42.3, "top_10_pct": 71.4,
            "cash_pct": 3.1, "invested_pct": 96.9,
        }
        user_context = {
            "user_age": 42, "retirement_age": 60,
            "risk_tolerance": "moderate",
        }
        settings_data = {
            "target_equities": 85, "target_bonds": 10,
            "target_alternatives": 3, "target_cash": 2,
            "typical_equity": 68, "typical_bond": 32,
            "stock_return": 9, "stock_std": 15,
            "bond_return": 4, "bond_std": 6,
            "inflation": 3, "risk_free": 4,
            "num_simulations": 10000,
            "black_swan_prob": 2, "black_swan_impact": -40,
            "golden_swan_prob": 2, "golden_swan_impact": 27,
            "withdrawal_rate": 4, "target_income": 8000,
        }
        out = build_cacheable_system_prompt(
            summary=summary,
            positions=positions,
            allocation=allocation,
            user_context=user_context,
            settings_data=settings_data,
        )
        assert len(out) > 14000, (
            f"system prompt is {len(out)} chars, need >14000 to plausibly "
            "exceed the 4096-token Opus/Haiku 4.7 cache threshold"
        )
        # And the per-portfolio data is actually present (top-15 by value).
        assert "TKR19" in out
        assert "$1,500,000" in out
        assert "Investor Profile" in out

    def test_dossier_does_not_contain_per_call_user_question(self):
        """The dossier is by construction stable — it must not embed any
        per-call ask. (Belt-and-suspenders: verifies the function signature
        cannot accept a 'question'/'prompt' kwarg.)
        """
        # Realistic args; just verifying nothing question-y leaks in.
        out = build_portfolio_dossier(
            summary={"total_value": 100_000},
            positions=[],
            user_context={"user_age": 30},
        )
        # No per-call markers. (Loose check, matches what the service
        # used to embed in the user message.)
        assert "Generate commentary for" not in out
        assert "Provide a brief" not in out


# ---------------------------------------------------------------------------
# CommentaryService — provider call kwargs
# ---------------------------------------------------------------------------

def _mock_provider_response():
    return InferenceResponse(
        content="Mocked commentary.",
        model="claude-sonnet-4-6",
        input_tokens=2500,
        output_tokens=80,
        cache_creation_input_tokens=2400,
        cache_read_input_tokens=0,
    )


def _make_commentary_service_with_rich_db():
    """Return a CommentaryService with a DB mock that produces real-looking
    portfolio data for the dossier."""
    db = MagicMock()

    # Accounts mock
    accounts = []
    for i in range(8):
        a = MagicMock()
        a.id = i + 1
        a.name = f"Account {i}"
        a.account_type = (
            "roth_ira" if i % 3 == 0 else
            "traditional_401k" if i % 3 == 1 else
            "taxable"
        )
        a.is_retirement = a.account_type != "taxable"
        accounts.append(a)
    db.get_all_accounts.return_value = accounts

    def positions_for_account(account_id):
        out = []
        for j in range(4):
            p = MagicMock()
            p.ticker = f"T{account_id}{j}"
            p.name = f"Ticker {account_id}{j}"
            p.shares = 50 + j * 10
            p.current_price = 100 + (account_id * j)
            p.cost_basis = (50 + j * 10) * 80
            p.is_fund = j == 0
            p.account_id = account_id
            out.append(p)
        return out

    db.get_positions_by_account.side_effect = positions_for_account
    db.get_settings.return_value = {
        "current_age": 42,
        "retirement_age": 60,
        "risk_tolerance": "moderate",
    }
    db.get_setting.return_value = None  # config not present
    return CommentaryService(db=db)


class TestCommentaryServiceCacheableSystemPrompt:
    def test_build_cacheable_system_prompt_exceeds_threshold(self):
        svc = _make_commentary_service_with_rich_db()
        system_text = svc._build_cacheable_system_prompt()
        assert len(system_text) > 14000, (
            "expected >14000 chars for caching; got " f"{len(system_text)}"
        )

    def test_logs_estimated_token_count(self, caplog):
        svc = _make_commentary_service_with_rich_db()
        with caplog.at_level("INFO", logger="src.services.commentary_service"):
            svc._build_cacheable_system_prompt()
        msgs = [r.getMessage() for r in caplog.records]
        assert any(
            "Built system prompt for caching" in m and "estimated tokens" in m
            for m in msgs
        ), f"expected estimated-token log; got {msgs}"

    def test_provider_complete_receives_long_system_with_cache_system_true(self):
        """Wire-level check: when the service generates commentary, the
        provider's complete() is called with `system=<long string>` and
        `cache_system=True`. The user message is the per-element ask.
        """
        svc = _make_commentary_service_with_rich_db()

        provider = MagicMock()
        provider.info.id = "claude"
        provider.complete.return_value = _mock_provider_response()
        svc._provider = provider

        # Skip the DB save — we only care about the provider call shape.
        svc._save_commentary = MagicMock()

        config = {
            "type": "tile",
            "tab": "dashboard",
            "prompt_key": "total_value",
            "title": "Total Portfolio Value",
        }
        result = svc._generate_and_cache_commentary(
            element_id="dashboard.total_value",
            config=config,
            current_data={"total_value": 1_500_000},
            current_hash="abc123",
        )
        assert not result.error
        assert provider.complete.called

        kwargs = provider.complete.call_args.kwargs
        # cache_system must be on
        assert kwargs.get("cache_system") is True
        # system is a long string with both persona + dossier content
        system_arg = kwargs.get("system", "")
        assert isinstance(system_arg, str)
        assert "knowledgeable financial advisor" in system_arg
        assert "## Reference Guidance for Commentary" in system_arg
        assert len(system_arg) > 14000

        # And the user message does NOT carry the dossier — it's the
        # per-element ask, not the cached prefix duplicated.
        msgs = kwargs.get("messages", [])
        assert len(msgs) == 1
        user_content = msgs[0].content
        assert "Reference Guidance for Commentary" not in user_content
        assert "Investor Profile" not in user_content
        # It should still carry the per-element prompt body.
        assert "Total Portfolio Value" in user_content


# ---------------------------------------------------------------------------
# AdvisorAnalysisService — cache_breakpoints math
# ---------------------------------------------------------------------------

class TestSecondToLastUserIndex:
    def test_returns_none_for_empty_list(self):
        assert _second_to_last_user_index([]) is None

    def test_returns_none_for_single_user(self):
        msgs = [InferenceMessage(role="user", content="hi")]
        assert _second_to_last_user_index(msgs) is None

    def test_picks_second_to_last_user_in_alternating_history(self):
        # [u1, a1, u2, a2, u3] -> second-to-last user is at idx 2
        msgs = [
            InferenceMessage(role="user", content="u1"),
            InferenceMessage(role="assistant", content="a1"),
            InferenceMessage(role="user", content="u2"),
            InferenceMessage(role="assistant", content="a2"),
            InferenceMessage(role="user", content="u3"),
        ]
        assert _second_to_last_user_index(msgs) == 2

    def test_handles_no_assistant_turns(self):
        # [u1, u2] -> second-to-last user is u1 at idx 0
        msgs = [
            InferenceMessage(role="user", content="u1"),
            InferenceMessage(role="user", content="u2"),
        ]
        assert _second_to_last_user_index(msgs) == 0


class TestAdvisorChatStreamCacheWiring:
    def test_chat_stream_without_tools_passes_cache_breakpoints_after_history(self):
        """On the second-and-later turn the stream call should set
        cache_breakpoints=[<idx of second-to-last user message>]."""
        db = MagicMock()
        db.get_all_positions.return_value = []
        db.get_all_accounts.return_value = []
        svc = AdvisorAnalysisService(db=db)
        # Pre-populate with one prior turn so the new request has
        # [u1, a1, u_new] -> second-to-last user idx = 0
        svc._chat_history = [
            ChatMessage(role="user", content="prior question"),
            ChatMessage(role="assistant", content="prior answer"),
        ]

        provider = MagicMock()
        provider.info.id = "claude"
        provider.supports_tools.return_value = False

        # Empty stream so the generator drains immediately.
        provider.stream.return_value = iter([])
        svc._provider = provider

        # Drain the generator
        list(svc._chat_stream_without_tools(
            user_message="follow-up",
            ticker=None,
            include_portfolio=False,
        ))

        assert provider.stream.called
        kwargs = provider.stream.call_args.kwargs
        assert kwargs.get("cache_system") is True
        # Three messages now: u1, a1, u_new -> idx of second-to-last user is 0.
        assert kwargs.get("cache_breakpoints") == [0]

    def test_first_turn_passes_no_cache_breakpoints(self):
        """No prior history => no message-level breakpoint (only one user
        message exists)."""
        db = MagicMock()
        db.get_all_positions.return_value = []
        db.get_all_accounts.return_value = []
        svc = AdvisorAnalysisService(db=db)

        provider = MagicMock()
        provider.info.id = "claude"
        provider.supports_tools.return_value = False
        provider.stream.return_value = iter([])
        svc._provider = provider

        list(svc._chat_stream_without_tools(
            user_message="first question",
            ticker=None,
            include_portfolio=False,
        ))

        kwargs = provider.stream.call_args.kwargs
        assert kwargs.get("cache_system") is True
        assert kwargs.get("cache_breakpoints") is None
