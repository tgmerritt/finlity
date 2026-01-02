"""Financial advisor-style analysis using Claude API."""

import json
import logging
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime

from src.services.ai_config import get_claude_model

logger = logging.getLogger(__name__)


@dataclass
class AdvisorAnalysis:
    """Advisor-style fund analysis result."""

    ticker: str
    name: str = ""
    summary: str = ""  # Brief 1-2 sentence summary
    advisor_commentary: str = ""  # Detailed advisor perspective
    portfolio_fit: str = ""  # How this fits in the portfolio
    overlaps: list[dict] = field(default_factory=list)  # Overlap with other holdings
    tax_considerations: str = ""  # Tax efficiency notes
    risk_notes: str = ""  # Risk considerations
    recommendations: list[str] = field(default_factory=list)  # Action items
    data_source: str = "claude"


@dataclass
class ChatMessage:
    """A message in the advisor chat."""

    role: str  # "user" or "assistant"
    content: str
    timestamp: datetime = field(default_factory=datetime.utcnow)


class AdvisorAnalysisService:
    """Provides financial advisor-style analysis using Claude API.

    This service analyzes funds and positions from the perspective of a
    financial advisor, considering:
    - Portfolio context (existing holdings, allocations)
    - Tax efficiency and account placement
    - Overlap and diversification
    - Risk factors
    - Investor profile
    """

    def __init__(self, claude_api_key: str, db=None):
        """Initialize advisor analysis service.

        Args:
            claude_api_key: Anthropic API key
            db: Database instance for accessing portfolio data
        """
        self.claude_api_key = claude_api_key
        self.db = db
        self._client = None
        self._chat_history: list[ChatMessage] = []

    def _get_client(self):
        """Get or create Anthropic client."""
        if self._client is None and self.claude_api_key:
            try:
                from anthropic import Anthropic

                self._client = Anthropic(api_key=self.claude_api_key)
            except ImportError:
                logger.warning("anthropic package not installed")
                return None
        return self._client

    def _get_portfolio_context(self) -> dict:
        """Get current portfolio context for analysis."""
        if not self.db:
            return {}

        positions = self.db.get_all_positions()
        accounts = {a.id: a for a in self.db.get_all_accounts()}

        # Aggregate holdings
        holdings = {}
        total_value = 0
        account_holdings = {}

        for pos in positions:
            if not pos.current_price:
                continue

            value = pos.shares * pos.current_price
            total_value += value

            ticker = pos.ticker.upper()
            if ticker not in holdings:
                holdings[ticker] = {
                    "ticker": ticker,
                    "name": pos.name or ticker,
                    "value": 0,
                    "is_fund": pos.is_fund,
                    "accounts": [],
                }
            holdings[ticker]["value"] += value

            # Track which accounts hold this
            account = accounts.get(pos.account_id)
            if account:
                acc_info = {
                    "name": account.name,
                    "type": account.account_type,
                    "is_retirement": account.is_retirement,
                }
                if acc_info not in holdings[ticker]["accounts"]:
                    holdings[ticker]["accounts"].append(acc_info)

                # Track by account
                if account.name not in account_holdings:
                    account_holdings[account.name] = {
                        "type": account.account_type,
                        "is_retirement": account.is_retirement,
                        "positions": [],
                    }
                account_holdings[account.name]["positions"].append({
                    "ticker": ticker,
                    "value": value,
                })

        # Calculate percentages
        for ticker, data in holdings.items():
            data["pct"] = round(data["value"] / total_value * 100, 2) if total_value > 0 else 0

        return {
            "total_value": total_value,
            "holdings": list(holdings.values()),
            "accounts": account_holdings,
            "holding_count": len(holdings),
        }

    def analyze_fund(
        self,
        ticker: str,
        fund_name: str = "",
        investor_age: int = None,
        risk_tolerance: str = None,
    ) -> Optional[AdvisorAnalysis]:
        """Analyze a fund from a financial advisor's perspective.

        Args:
            ticker: Fund ticker symbol
            fund_name: Fund name (optional)
            investor_age: Investor's age for context
            risk_tolerance: "conservative", "moderate", or "aggressive"

        Returns:
            AdvisorAnalysis with detailed commentary
        """
        client = self._get_client()
        if not client:
            return None

        # Get portfolio context
        portfolio = self._get_portfolio_context()

        # Build context for Claude
        context_parts = []

        if portfolio:
            context_parts.append(f"Portfolio total value: ${portfolio['total_value']:,.0f}")
            context_parts.append(f"Number of holdings: {portfolio['holding_count']}")

            # Top holdings
            top_holdings = sorted(
                portfolio["holdings"], key=lambda x: x["value"], reverse=True
            )[:10]
            holdings_str = "\n".join(
                f"  - {h['ticker']}: ${h['value']:,.0f} ({h['pct']}%)"
                for h in top_holdings
            )
            context_parts.append(f"Top holdings:\n{holdings_str}")

        if investor_age:
            context_parts.append(f"Investor age: {investor_age}")
        if risk_tolerance:
            context_parts.append(f"Risk tolerance: {risk_tolerance}")

        portfolio_context = "\n".join(context_parts) if context_parts else "No portfolio data available."

        prompt = f"""You are a certified financial planner analyzing an investment fund for a client.
Provide thoughtful, professional advice as you would in a real advisory session.

FUND TO ANALYZE:
Ticker: {ticker}
Name: {fund_name or 'Unknown'}

CLIENT'S CURRENT PORTFOLIO:
{portfolio_context}

Please analyze this fund and provide your professional assessment. Return a JSON object with these fields:

{{
    "summary": "1-2 sentence summary of the fund",
    "advisor_commentary": "2-3 paragraphs of detailed analysis from an advisor's perspective - discuss what this fund does, its role in a portfolio, who it's suitable for, recent performance context",
    "portfolio_fit": "Assessment of how this fund fits with the client's existing portfolio - is it complementary or redundant?",
    "overlaps": [
        {{"ticker": "XXX", "overlap_pct": 30, "description": "Both hold large cap US stocks"}}
    ],
    "tax_considerations": "Notes on tax efficiency - is this better in taxable or retirement accounts?",
    "risk_notes": "Key risk factors to be aware of",
    "recommendations": ["Specific actionable recommendation 1", "Recommendation 2"]
}}

Be specific, practical, and reference the client's actual holdings when discussing overlap.
Return ONLY valid JSON, no markdown or explanation."""

        try:
            message = client.messages.create(
                model=get_claude_model(),
                max_tokens=2048,
                messages=[{"role": "user", "content": prompt}],
            )

            response_text = message.content[0].text.strip()

            # Clean up response
            if response_text.startswith("```"):
                lines = response_text.split("\n")
                response_text = "\n".join(lines[1:-1])

            data = json.loads(response_text)

            return AdvisorAnalysis(
                ticker=ticker.upper(),
                name=fund_name,
                summary=data.get("summary", ""),
                advisor_commentary=data.get("advisor_commentary", ""),
                portfolio_fit=data.get("portfolio_fit", ""),
                overlaps=data.get("overlaps", []),
                tax_considerations=data.get("tax_considerations", ""),
                risk_notes=data.get("risk_notes", ""),
                recommendations=data.get("recommendations", []),
                data_source="claude",
            )

        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse Claude response for {ticker}: {e}")
            return None
        except Exception as e:
            logger.warning(f"Claude API error for {ticker}: {e}")
            return None

    def _build_chat_context(
        self,
        ticker: str = None,
        include_portfolio: bool = True,
    ) -> tuple[str, list[dict]]:
        """Build the system prompt and messages for chat.

        Returns:
            Tuple of (system_prompt, messages)
        """
        # Build system context
        system_parts = [
            "You are a knowledgeable and helpful financial advisor assistant.",
            "Provide thoughtful, balanced advice based on general financial principles.",
            "Always remind users that this is educational information and they should consult a qualified financial advisor for personalized advice.",
            "Be conversational but professional.",
            "Format your responses using markdown for better readability - use **bold** for emphasis, bullet points for lists, and headers (##) for sections when appropriate.",
        ]

        if include_portfolio:
            portfolio = self._get_portfolio_context()
            if portfolio:
                system_parts.append(f"\nClient's portfolio value: ${portfolio['total_value']:,.0f}")
                top_holdings = sorted(
                    portfolio["holdings"], key=lambda x: x["value"], reverse=True
                )[:5]
                holdings_str = ", ".join(
                    f"{h['ticker']} (${h['value']:,.0f})" for h in top_holdings
                )
                system_parts.append(f"Top holdings: {holdings_str}")

        if ticker:
            system_parts.append(f"\nCurrently discussing: {ticker}")

        system_prompt = "\n".join(system_parts)

        # Build messages from chat history
        messages = []
        for msg in self._chat_history[-10:]:  # Last 10 messages for context
            messages.append({"role": msg.role, "content": msg.content})

        return system_prompt, messages

    def chat(
        self,
        user_message: str,
        ticker: str = None,
        include_portfolio: bool = True,
    ) -> str:
        """Have a conversation with the AI advisor about investments.

        Args:
            user_message: User's question or message
            ticker: Optional ticker for context
            include_portfolio: Whether to include portfolio context

        Returns:
            AI advisor's response
        """
        client = self._get_client()
        if not client:
            return "Claude API is not available. Please configure your API key in Settings."

        system_prompt, messages = self._build_chat_context(ticker, include_portfolio)
        messages.append({"role": "user", "content": user_message})

        try:
            response = client.messages.create(
                model=get_claude_model(),
                max_tokens=1024,
                system=system_prompt,
                messages=messages,
            )

            assistant_message = response.content[0].text

            # Store in chat history
            self._chat_history.append(ChatMessage(role="user", content=user_message))
            self._chat_history.append(
                ChatMessage(role="assistant", content=assistant_message)
            )

            return assistant_message

        except Exception as e:
            logger.error(f"Chat error: {e}")
            return f"I encountered an error: {str(e)}. Please try again."

    def chat_stream(
        self,
        user_message: str,
        ticker: str = None,
        include_portfolio: bool = True,
    ):
        """Stream a conversation with the AI advisor.

        Args:
            user_message: User's question or message
            ticker: Optional ticker for context
            include_portfolio: Whether to include portfolio context

        Yields:
            Text chunks as they arrive from the API
        """
        client = self._get_client()
        if not client:
            yield "Claude API is not available. Please configure your API key in Settings."
            return

        system_prompt, messages = self._build_chat_context(ticker, include_portfolio)
        messages.append({"role": "user", "content": user_message})

        # Store user message immediately
        self._chat_history.append(ChatMessage(role="user", content=user_message))

        full_response = ""

        try:
            with client.messages.stream(
                model=get_claude_model(),
                max_tokens=1024,
                system=system_prompt,
                messages=messages,
            ) as stream:
                for text in stream.text_stream:
                    full_response += text
                    yield text

            # Store complete assistant message in history
            self._chat_history.append(
                ChatMessage(role="assistant", content=full_response)
            )

        except Exception as e:
            logger.error(f"Chat stream error: {e}")
            error_msg = f"I encountered an error: {str(e)}. Please try again."
            yield error_msg
            self._chat_history.append(
                ChatMessage(role="assistant", content=error_msg)
            )

    def clear_chat_history(self):
        """Clear the chat history."""
        self._chat_history = []

    def get_chat_history(self) -> list[dict]:
        """Get chat history as list of dicts."""
        return [
            {"role": msg.role, "content": msg.content, "timestamp": msg.timestamp.isoformat()}
            for msg in self._chat_history
        ]

    def _build_enhanced_system_prompt(
        self,
        page_context: dict = None,
        ticker: str = None,
    ) -> str:
        """Build context-aware system prompt based on current page and visible data.

        Args:
            page_context: Dictionary with active_tab, visible_data, selected_ticker
            ticker: Optional specific ticker being discussed

        Returns:
            System prompt string
        """
        parts = [
            "You are a knowledgeable financial advisor assistant for a portfolio analysis application.",
            "Provide helpful, accurate advice based on the user's actual portfolio data.",
            "Always remind users this is educational and they should consult a qualified advisor for personalized advice.",
            "Use markdown for formatting: **bold** for emphasis, bullet points for lists, and ## headers where appropriate.",
            "",
            "You have access to tools to query the portfolio database for detailed information.",
            "Use tools when the user asks for specific data not already provided in the context below.",
            "Prefer using provided context over making tool calls when the information is already available.",
        ]

        # Add page-specific context
        if page_context:
            active_tab = page_context.get("active_tab", "unknown")
            parts.append("\n## Current Context")
            parts.append(f"User is viewing: **{active_tab.upper()}** tab")

            visible_data = page_context.get("visible_data", {})

            # Portfolio summary (always useful)
            portfolio_summary = visible_data.get("portfolio_summary")
            if portfolio_summary:
                total = portfolio_summary.get("total_value", 0)
                retirement = portfolio_summary.get("retirement_value", 0)
                taxable = portfolio_summary.get("taxable_value", 0)
                parts.append("\n**Portfolio Overview:**")
                parts.append(f"- Total Value: ${total:,.0f}")
                if retirement:
                    parts.append(f"- Retirement Accounts: ${retirement:,.0f}")
                if taxable:
                    parts.append(f"- Taxable Accounts: ${taxable:,.0f}")

            # Tab-specific context (keep concise)
            if active_tab == "analysis":
                allocation = visible_data.get("allocation")
                if allocation:
                    cash = allocation.get("cash_allocation", 0)
                    top5 = allocation.get("concentration_top5", 0)
                    parts.append("\n**Allocation Summary:**")
                    parts.append(f"- Cash: {cash:.1f}%")
                    if top5:
                        parts.append(f"- Top 5 Concentration: {top5:.1f}%")
                    by_sector = allocation.get("by_sector", {})
                    if by_sector:
                        top_sectors = sorted(by_sector.items(), key=lambda x: x[1], reverse=True)[:3]
                        if top_sectors:
                            parts.append(f"- Top Sectors: {', '.join(f'{s}: {p:.0f}%' for s, p in top_sectors)}")

                performance = visible_data.get("performance")
                if performance:
                    ytd = performance.get("ytd_return")
                    alpha = performance.get("alpha_ytd")
                    if ytd is not None:
                        parts.append("\n**Performance:**")
                        parts.append(f"- YTD Return: {ytd:+.2f}%")
                        if alpha is not None:
                            parts.append(f"- Alpha vs S&P: {alpha:+.2f}%")

                risk = visible_data.get("risk")
                if risk:
                    parts.append("\n**Risk Metrics:**")
                    if risk.get("volatility") is not None:
                        parts.append(f"- Volatility: {risk['volatility']:.1f}%")
                    if risk.get("sharpe_ratio") is not None:
                        parts.append(f"- Sharpe Ratio: {risk['sharpe_ratio']:.2f}")
                    if risk.get("beta") is not None:
                        parts.append(f"- Beta: {risk['beta']:.2f}")

            elif active_tab == "projections":
                mc_results = visible_data.get("monte_carlo_results")
                if mc_results:
                    parts.append("\n**Retirement Projection:**")
                    success_rate = mc_results.get("success_rate")
                    if success_rate is not None:
                        parts.append(f"- Success Rate: {success_rate:.0f}%")
                    median = mc_results.get("median_final_value")
                    if median is not None:
                        parts.append(f"- Median Final Value: ${median:,.0f}")

                mc_params = visible_data.get("monte_carlo_params")
                if mc_params:
                    parts.append("\n**Projection Parameters:**")
                    if mc_params.get("current_age"):
                        parts.append(f"- Current Age: {mc_params['current_age']}")
                    if mc_params.get("retirement_age"):
                        parts.append(f"- Retirement Age: {mc_params['retirement_age']}")
                    if mc_params.get("monthly_withdrawal"):
                        parts.append(f"- Monthly Withdrawal: ${mc_params['monthly_withdrawal']:,.0f}")

            elif active_tab == "taxes":
                tax_projection = visible_data.get("tax_projection")
                if tax_projection:
                    parts.append("\n**Tax Projection:**")
                    if tax_projection.get("average_effective_rate") is not None:
                        parts.append(f"- Avg Effective Rate: {tax_projection['average_effective_rate']:.1f}%")
                    if tax_projection.get("total_tax") is not None:
                        parts.append(f"- Total Lifetime Tax: ${tax_projection['total_tax']:,.0f}")
                    if tax_projection.get("depletion_age") is not None:
                        parts.append(f"- Depletion Age: {tax_projection['depletion_age']}")

            elif active_tab == "holdings":
                positions = visible_data.get("positions", [])
                if positions:
                    parts.append(f"\n**Holdings:** {len(positions)} positions visible")
                    # Show top 5 by value
                    top_positions = sorted(positions, key=lambda x: x.get("value", 0), reverse=True)[:5]
                    for p in top_positions:
                        parts.append(f"- {p.get('ticker', 'N/A')}: ${p.get('value', 0):,.0f}")

            # Triggered alerts (always relevant)
            alerts = visible_data.get("triggered_alerts", [])
            if alerts:
                parts.append(f"\n**Active Alerts:** {len(alerts)} triggered")
                for alert in alerts[:3]:  # Limit to 3
                    parts.append(f"- {alert.get('name', 'Alert')}: {alert.get('message', '')}")

        # Add ticker focus
        focus_ticker = ticker or (page_context.get("selected_ticker") if page_context else None)
        if focus_ticker:
            parts.append(f"\n**Currently discussing:** {focus_ticker}")

        return "\n".join(parts)

    def chat_stream_with_tools(
        self,
        user_message: str,
        ticker: str = None,
        include_portfolio: bool = True,
        page_context: dict = None,
    ):
        """Stream a conversation with tool support.

        Args:
            user_message: User's question or message
            ticker: Optional ticker for context
            include_portfolio: Whether to include portfolio context
            page_context: Dictionary with active_tab, visible_data, selected_ticker

        Yields:
            Events in the format:
            {"type": "text", "content": "..."} - Text chunks
            {"type": "tool_start", "name": "...", "id": "..."} - Tool call starting
            {"type": "tool_result", "name": "...", "result": {...}} - Tool result
            {"type": "done"} - Stream complete
            {"type": "error", "message": "..."} - Error occurred
        """
        from src.services.chat_tools import CHAT_TOOLS, ChatToolExecutor

        client = self._get_client()
        if not client:
            yield {"type": "error", "message": "Claude API is not available. Please configure your API key in Settings."}
            return

        # Build enhanced system prompt
        system_prompt = self._build_enhanced_system_prompt(page_context, ticker)

        # Build messages from chat history
        messages = []
        for msg in self._chat_history[-10:]:
            messages.append({"role": msg.role, "content": msg.content})
        messages.append({"role": "user", "content": user_message})

        # Store user message immediately
        self._chat_history.append(ChatMessage(role="user", content=user_message))

        tool_executor = ChatToolExecutor(self.db)
        full_response = ""
        max_tool_iterations = 5  # Prevent infinite tool loops

        for iteration in range(max_tool_iterations):
            try:
                # Make streaming request with tools
                with client.messages.stream(
                    model=get_claude_model(),
                    max_tokens=2048,
                    system=system_prompt,
                    messages=messages,
                    tools=CHAT_TOOLS,
                ) as stream:
                    current_tool_use = None
                    tool_input_json = ""

                    for event in stream:
                        if event.type == "content_block_start":
                            if hasattr(event.content_block, "type") and event.content_block.type == "tool_use":
                                current_tool_use = {
                                    "id": event.content_block.id,
                                    "name": event.content_block.name,
                                }
                                tool_input_json = ""
                                yield {"type": "tool_start", "name": current_tool_use["name"], "id": current_tool_use["id"]}

                        elif event.type == "content_block_delta":
                            if hasattr(event.delta, "type"):
                                if event.delta.type == "text_delta":
                                    full_response += event.delta.text
                                    yield {"type": "text", "content": event.delta.text}
                                elif event.delta.type == "input_json_delta":
                                    tool_input_json += event.delta.partial_json

                        elif event.type == "content_block_stop":
                            if current_tool_use:
                                # Parse and execute tool
                                try:
                                    tool_input = json.loads(tool_input_json) if tool_input_json else {}
                                except json.JSONDecodeError:
                                    tool_input = {}

                                result = tool_executor.execute_tool(current_tool_use["name"], tool_input)
                                yield {"type": "tool_result", "name": current_tool_use["name"], "result": result}

                                # Add tool use and result to messages for continuation
                                messages.append({
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "tool_use",
                                            "id": current_tool_use["id"],
                                            "name": current_tool_use["name"],
                                            "input": tool_input
                                        }
                                    ]
                                })
                                messages.append({
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "tool_result",
                                            "tool_use_id": current_tool_use["id"],
                                            "content": json.dumps(result)
                                        }
                                    ]
                                })

                                current_tool_use = None
                                tool_input_json = ""

                    # Get final message to check stop reason
                    final_message = stream.get_final_message()

                    if final_message.stop_reason == "end_turn":
                        # No more tool calls, we're done
                        break
                    elif final_message.stop_reason != "tool_use":
                        # Unexpected stop reason, but still done
                        break
                    # If stop_reason is "tool_use", continue the loop to process tool results

            except Exception as e:
                logger.error(f"Chat stream with tools error: {e}")
                yield {"type": "error", "message": str(e)}
                return

        # Store complete response
        if full_response:
            self._chat_history.append(ChatMessage(role="assistant", content=full_response))

        yield {"type": "done"}
