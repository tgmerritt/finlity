"""AI Commentary Service for generating and managing dashboard element insights.

This service:
- Generates AI commentary using Claude API
- Caches results in the database with change detection
- Enriches prompts with web search comparison data
- Provides efficient batch operations
"""

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from src.database import Database
from src.database.models import AICommentary
from src.services.ai_config import get_claude_model
from src.services.commentary_registry import (
    ELEMENT_REGISTRY,
    get_element_config,
    get_elements_by_tab,
    get_elements_by_trigger,
)
from src.services.commentary_prompts import SYSTEM_PROMPT, format_prompt

# Constants
MAX_CACHE_AGE_HOURS = 168  # 7 days
MAX_WEB_SEARCHES_PER_ELEMENT = 2

logger = logging.getLogger(__name__)


@dataclass
class CommentaryResult:
    """Result of a commentary request."""
    element_id: str
    commentary: str
    comparison_data: Optional[dict] = None
    action_items: Optional[list] = None
    generated_at: Optional[datetime] = None
    is_cached: bool = False
    age_hours: float = 0
    error: Optional[str] = None


@dataclass
class RefreshResult:
    """Result of a refresh operation."""
    refreshed_count: int
    skipped_count: int
    error_count: int
    errors: list[str]


class CommentaryService:
    """Service for generating and managing AI commentary on dashboard elements."""

    def __init__(self, db: Database):
        """Initialize the commentary service.

        Args:
            db: Database instance for storing/retrieving commentary
        """
        self.db = db
        self._client = None
        self._api_key = None

    def _get_client(self):
        """Lazily initialize the Anthropic client."""
        if self._client is None:
            try:
                from anthropic import Anthropic
                from src.services.secrets import SecretsManager

                secrets = SecretsManager(self.db)
                self._api_key = secrets.get_api_key("anthropic_api_key")

                if not self._api_key:
                    logger.warning("No Anthropic API key configured")
                    return None

                logger.info(f"Initializing Anthropic client with key: {self._api_key[:8]}...")
                self._client = Anthropic(api_key=self._api_key)
            except ImportError as e:
                logger.warning(f"anthropic package not installed: {e}")
                return None
            except Exception as e:
                logger.error(f"Failed to initialize Anthropic client: {e}")
                return None

        return self._client

    def get_commentary(
        self,
        element_id: str,
        force_refresh: bool = False,
        current_data: Optional[dict] = None,
    ) -> CommentaryResult:
        """Get commentary for a specific element.

        Args:
            element_id: The element identifier (e.g., "dashboard.total_value")
            force_refresh: If True, regenerate even if cached
            current_data: Optional pre-fetched data for the element

        Returns:
            CommentaryResult with the commentary or error
        """
        config = get_element_config(element_id)
        if not config:
            return CommentaryResult(
                element_id=element_id,
                commentary="",
                error=f"Unknown element: {element_id}"
            )

        # Get current data if not provided
        if current_data is None:
            current_data = self._collect_element_data(element_id)

        # Compute hash for change detection
        current_hash = self._compute_data_hash(element_id, current_data)

        # Check cache unless forced refresh
        if not force_refresh:
            cached = self._get_cached_commentary(element_id)
            if cached and not self._is_cache_stale(cached, current_hash):
                # Safely parse JSON fields with error handling
                comparison_data = None
                action_items = None
                try:
                    if cached["comparison_data"]:
                        comparison_data = json.loads(cached["comparison_data"])
                except (json.JSONDecodeError, TypeError):
                    logger.warning(f"Invalid JSON in comparison_data for {element_id}")
                try:
                    if cached["action_items"]:
                        action_items = json.loads(cached["action_items"])
                except (json.JSONDecodeError, TypeError):
                    logger.warning(f"Invalid JSON in action_items for {element_id}")

                return CommentaryResult(
                    element_id=element_id,
                    commentary=cached["commentary"],
                    comparison_data=comparison_data,
                    action_items=action_items,
                    generated_at=cached["generated_at"],
                    is_cached=True,
                    age_hours=cached["age_hours"],
                )

        # Generate new commentary
        return self._generate_and_cache_commentary(element_id, config, current_data, current_hash)

    def get_batch_commentary(
        self,
        element_ids: list[str],
        force_refresh: bool = False,
    ) -> dict[str, CommentaryResult]:
        """Get commentary for multiple elements efficiently.

        Args:
            element_ids: List of element identifiers
            force_refresh: If True, regenerate all even if cached

        Returns:
            Dictionary mapping element_id to CommentaryResult
        """
        results = {}

        # Collect all data at once for efficiency
        all_data = self._collect_all_element_data()

        for element_id in element_ids:
            element_data = all_data.get(element_id, {})
            results[element_id] = self.get_commentary(
                element_id,
                force_refresh=force_refresh,
                current_data=element_data,
            )

        return results

    def get_tab_commentary(self, tab: str) -> dict[str, CommentaryResult]:
        """Get all commentary for elements on a specific tab.

        Args:
            tab: Tab name (dashboard, holdings, analysis, projections, taxes, budget)

        Returns:
            Dictionary mapping element_id to CommentaryResult
        """
        elements = get_elements_by_tab(tab)
        return self.get_batch_commentary(list(elements.keys()))

    def refresh_stale_commentary(self, tab: Optional[str] = None) -> RefreshResult:
        """Refresh all stale commentary.

        Args:
            tab: Optional tab filter. If None, refresh all tabs.

        Returns:
            RefreshResult with counts and any errors
        """
        if tab:
            element_ids = list(get_elements_by_tab(tab).keys())
        else:
            element_ids = list(ELEMENT_REGISTRY.keys())

        all_data = self._collect_all_element_data()

        refreshed = 0
        skipped = 0
        errors = []

        for element_id in element_ids:
            config = get_element_config(element_id)
            if not config:
                continue

            element_data = all_data.get(element_id, {})
            current_hash = self._compute_data_hash(element_id, element_data)

            # Check if stale
            cached = self._get_cached_commentary(element_id)
            if cached and not self._is_cache_stale(cached, current_hash):
                skipped += 1
                continue

            # Refresh
            result = self._generate_and_cache_commentary(
                element_id, config, element_data, current_hash
            )

            if result.error:
                errors.append(f"{element_id}: {result.error}")
            else:
                refreshed += 1

        return RefreshResult(
            refreshed_count=refreshed,
            skipped_count=skipped,
            error_count=len(errors),
            errors=errors,
        )

    def invalidate_commentary(self, trigger: str) -> int:
        """Invalidate commentary based on a trigger event.

        This marks commentary as stale by updating the data_hash to a dummy value,
        forcing regeneration on next access.

        Args:
            trigger: The trigger event (position_change, price_update, settings_change, etc.)

        Returns:
            Number of commentaries invalidated
        """
        element_ids = get_elements_by_trigger(trigger)

        count = 0
        session = self.db.SessionLocal()
        try:
            for element_id in element_ids:
                commentary = session.query(AICommentary).filter(
                    AICommentary.element_id == element_id
                ).first()
                if commentary:
                    # Set hash to dummy value to force refresh
                    commentary.data_hash = f"invalidated_{trigger}_{datetime.utcnow().timestamp()}"
                    count += 1
            session.commit()
        except Exception as e:
            session.rollback()
            logger.error(f"Error invalidating commentary for trigger {trigger}: {e}")
        finally:
            session.close()

        return count

    def get_commentary_status(self) -> dict:
        """Get status information about the commentary cache.

        Returns:
            Dictionary with cache statistics
        """
        session = self.db.SessionLocal()
        try:
            total = session.query(AICommentary).count()

            # Count by tab
            by_tab = {}
            for tab in ["dashboard", "holdings", "analysis", "projections", "taxes", "budget"]:
                by_tab[tab] = session.query(AICommentary).filter(
                    AICommentary.element_tab == tab
                ).count()

            # Get oldest and newest
            oldest = session.query(AICommentary).order_by(
                AICommentary.generated_at.asc()
            ).first()
            newest = session.query(AICommentary).order_by(
                AICommentary.generated_at.desc()
            ).first()

            return {
                "total_cached": total,
                "total_elements": len(ELEMENT_REGISTRY),
                "coverage_pct": (total / len(ELEMENT_REGISTRY) * 100) if ELEMENT_REGISTRY else 0,
                "by_tab": by_tab,
                "oldest_generated": oldest.generated_at.isoformat() if oldest else None,
                "newest_generated": newest.generated_at.isoformat() if newest else None,
            }
        finally:
            session.close()

    def _get_cached_commentary(self, element_id: str) -> Optional[dict]:
        """Retrieve cached commentary from database.

        Returns a dictionary with all needed values to avoid detached object issues.
        """
        session = self.db.SessionLocal()
        try:
            result = session.query(AICommentary).filter(
                AICommentary.element_id == element_id
            ).first()

            if not result:
                return None

            # Extract all values while session is open to avoid detached object issues
            # Compute age_hours now while we have access to the object
            age_hours = result.age_hours()

            return {
                "element_id": result.element_id,
                "commentary": result.commentary,
                "comparison_data": result.comparison_data,
                "action_items": result.action_items,
                "data_hash": result.data_hash,
                "generated_at": result.generated_at,
                "age_hours": age_hours,
            }
        finally:
            session.close()

    def _is_cache_stale(self, cached: dict, current_hash: str) -> bool:
        """Check if cached commentary is stale.

        Args:
            cached: Dictionary from _get_cached_commentary
            current_hash: Hash of current data

        Returns:
            True if cache should be refreshed
        """
        # Hash mismatch = data changed
        if cached["data_hash"] != current_hash:
            return True
        # Age check
        return cached["age_hours"] > MAX_CACHE_AGE_HOURS

    def _generate_and_cache_commentary(
        self,
        element_id: str,
        config: dict,
        current_data: dict,
        current_hash: str,
    ) -> CommentaryResult:
        """Generate commentary using Claude API and cache it.

        Args:
            element_id: Element identifier
            config: Element configuration from registry
            current_data: Current data values
            current_hash: Hash of current data

        Returns:
            CommentaryResult with generated commentary
        """
        client = self._get_client()
        if not client:
            return CommentaryResult(
                element_id=element_id,
                commentary="AI commentary is not available. Please configure your Anthropic API key in Settings.",
                error="No API client available",
            )

        start_time = time.time()

        # Get web search comparison data
        comparison_data = {}
        web_search_used = False
        web_search_queries = config.get("web_search_queries", [])

        if web_search_queries:
            user_context = self._get_user_context()
            comparison_data = self._perform_web_searches(web_search_queries, user_context)
            web_search_used = bool(comparison_data)

        # Format the prompt
        prompt_key = config.get("prompt_key", element_id.split(".")[-1])
        prompt_data = {
            **current_data,
            **self._get_user_context(),
            "comparison_context": self._format_comparison_context(comparison_data),
            "current_year": datetime.now().year,
        }

        prompt = format_prompt(prompt_key, **prompt_data)
        if not prompt:
            # Fallback generic prompt
            prompt = f"""The user is viewing the "{config.get('title', element_id)}" element.

Current data: {json.dumps(current_data, indent=2, default=str)}

{self._format_comparison_context(comparison_data)}

Provide a brief 2-3 sentence explanation of what this data shows and any relevant context."""

        # Call Claude API
        try:
            response = client.messages.create(
                model=get_claude_model(),
                max_tokens=512,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )

            commentary = response.content[0].text
            token_count = response.usage.input_tokens + response.usage.output_tokens
            generation_time_ms = (time.time() - start_time) * 1000

            # Cache the result
            self._save_commentary(
                element_id=element_id,
                element_type=config.get("type", "unknown"),
                element_tab=config.get("tab", "unknown"),
                commentary=commentary,
                comparison_data=comparison_data,
                data_hash=current_hash,
                data_snapshot=current_data,
                model_version=get_claude_model(),
                generation_time_ms=generation_time_ms,
                token_count=token_count,
                web_search_used=web_search_used,
            )

            return CommentaryResult(
                element_id=element_id,
                commentary=commentary,
                comparison_data=comparison_data if comparison_data else None,
                generated_at=datetime.utcnow(),
                is_cached=False,
                age_hours=0,
            )

        except Exception as e:
            logger.error(f"Error generating commentary for {element_id}: {e}")
            return CommentaryResult(
                element_id=element_id,
                commentary="",
                error=str(e),
            )

    def _save_commentary(
        self,
        element_id: str,
        element_type: str,
        element_tab: str,
        commentary: str,
        comparison_data: dict,
        data_hash: str,
        data_snapshot: dict,
        model_version: str,
        generation_time_ms: float,
        token_count: float,
        web_search_used: bool,
    ):
        """Save or update commentary in the database."""
        session = self.db.SessionLocal()
        try:
            existing = session.query(AICommentary).filter(
                AICommentary.element_id == element_id
            ).first()

            if existing:
                existing.element_type = element_type
                existing.element_tab = element_tab
                existing.commentary = commentary
                existing.comparison_data = json.dumps(comparison_data) if comparison_data else None
                existing.data_hash = data_hash
                existing.data_snapshot = json.dumps(data_snapshot, default=str) if data_snapshot else None
                existing.generated_at = datetime.utcnow()
                existing.model_version = model_version
                existing.generation_time_ms = generation_time_ms
                existing.token_count = token_count
                existing.web_search_used = web_search_used
                existing.updated_at = datetime.utcnow()
            else:
                new_commentary = AICommentary(
                    element_id=element_id,
                    element_type=element_type,
                    element_tab=element_tab,
                    commentary=commentary,
                    comparison_data=json.dumps(comparison_data) if comparison_data else None,
                    data_hash=data_hash,
                    data_snapshot=json.dumps(data_snapshot, default=str) if data_snapshot else None,
                    model_version=model_version,
                    generation_time_ms=generation_time_ms,
                    token_count=token_count,
                    web_search_used=web_search_used,
                )
                session.add(new_commentary)

            session.commit()
        except Exception as e:
            session.rollback()
            logger.error(f"Error saving commentary for {element_id}: {e}")
            raise
        finally:
            session.close()

    def _compute_data_hash(self, element_id: str, data: dict) -> str:
        """Compute a hash of the relevant data for change detection.

        Args:
            element_id: Element identifier
            data: Current data values

        Returns:
            16-character hash string
        """
        config = get_element_config(element_id)
        if not config:
            return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()[:16]

        # Extract only the relevant data fields
        dependencies = config.get("data_dependencies", [])
        relevant_data = {}

        for dep in dependencies:
            value = self._get_nested_value(data, dep)
            relevant_data[dep] = value

        json_str = json.dumps(relevant_data, sort_keys=True, default=str)
        return hashlib.sha256(json_str.encode()).hexdigest()[:16]

    def _get_nested_value(self, data: dict, path: str):
        """Get a nested value from a dictionary using dot notation.

        Args:
            data: Source dictionary
            path: Dot-separated path (e.g., "summary.total_value")

        Returns:
            The value at the path, or None if not found
        """
        parts = path.split(".")
        value = data
        for part in parts:
            if isinstance(value, dict):
                value = value.get(part)
            else:
                return None
        return value

    def _collect_element_data(self, element_id: str) -> dict:
        """Collect current data for a specific element.

        Args:
            element_id: Element identifier

        Returns:
            Dictionary of current data values
        """
        # This will be called per-element - for efficiency, prefer _collect_all_element_data
        all_data = self._collect_all_element_data()
        return all_data.get(element_id, {})

    def _collect_all_element_data(self) -> dict:
        """Collect current data for all elements.

        Returns:
            Dictionary mapping element_id to its current data
        """
        data = {}

        # Get portfolio summary
        summary = self._get_portfolio_summary()
        positions = self._get_positions()

        # Get analysis metrics
        performance = self._get_performance_metrics()
        risk = self._get_risk_metrics()
        allocation = self._get_allocation_data()

        # Get retirement metrics
        retirement_metrics = self._get_retirement_metrics()

        # Build element-specific data
        for element_id in ELEMENT_REGISTRY.keys():
            element_data = {
                "summary": summary,
                "positions": positions,
                "performance": performance,
                "risk": risk,
                "allocation": allocation,
                "retirement_metrics": retirement_metrics,
            }

            # Add element-specific fields
            if element_id == "dashboard.total_value":
                element_data["total_value"] = summary.get("total_value", 0)
            elif element_id == "dashboard.total_gain_loss":
                element_data["total_gain_loss"] = summary.get("total_gain_loss", 0)
                element_data["total_gain_loss_pct"] = summary.get("total_gain_loss_pct", 0)
            elif element_id == "dashboard.retirement_value":
                element_data["retirement_value"] = summary.get("retirement_value", 0)
                total = summary.get("total_value", 1)
                element_data["retirement_pct"] = (summary.get("retirement_value", 0) / total * 100) if total else 0
            elif element_id == "dashboard.taxable_value":
                element_data["taxable_value"] = summary.get("taxable_value", 0)
                total = summary.get("total_value", 1)
                element_data["taxable_pct"] = (summary.get("taxable_value", 0) / total * 100) if total else 0

            # Performance metrics
            elif element_id.startswith("analysis.performance"):
                element_data.update(performance)

            # Risk metrics
            elif element_id.startswith("analysis.risk"):
                element_data.update(risk)

            data[element_id] = element_data

        return data

    def _get_portfolio_summary(self) -> dict:
        """Get portfolio summary data."""
        try:
            accounts = self.db.get_all_accounts()
            total_value = 0
            retirement_value = 0
            taxable_value = 0
            total_cost_basis = 0

            for account in accounts:
                positions = self.db.get_positions_by_account(account.id)
                account_value = sum(
                    (p.current_price or 0) * (p.shares or 0)
                    for p in positions
                )
                account_cost = sum(
                    p.cost_basis or 0
                    for p in positions
                )

                total_value += account_value
                total_cost_basis += account_cost

                if account.is_retirement:
                    retirement_value += account_value
                else:
                    taxable_value += account_value

            total_gain_loss = total_value - total_cost_basis
            total_gain_loss_pct = (total_gain_loss / total_cost_basis * 100) if total_cost_basis else 0

            return {
                "total_value": total_value,
                "retirement_value": retirement_value,
                "taxable_value": taxable_value,
                "total_cost_basis": total_cost_basis,
                "total_gain_loss": total_gain_loss,
                "total_gain_loss_pct": total_gain_loss_pct,
                "num_accounts": len(accounts),
            }
        except Exception as e:
            logger.error(f"Error getting portfolio summary: {e}")
            return {}

    def _get_positions(self) -> list:
        """Get all positions."""
        try:
            positions = []
            for account in self.db.get_all_accounts():
                for pos in self.db.get_positions_by_account(account.id):
                    positions.append({
                        "ticker": pos.ticker,
                        "name": pos.name,
                        "shares": pos.shares,
                        "current_price": pos.current_price,
                        "value": (pos.current_price or 0) * (pos.shares or 0),
                        "account_type": account.account_type,
                    })
            return positions
        except Exception as e:
            logger.error(f"Error getting positions: {e}")
            return []

    def _get_performance_metrics(self) -> dict:
        """Get performance metrics."""
        # This would typically call the analysis service
        # For now, return placeholder
        return {
            "ytd_return": 0,
            "one_year_return": 0,
            "alpha": 0,
            "benchmark_ytd": 0,
        }

    def _get_risk_metrics(self) -> dict:
        """Get risk metrics."""
        # This would typically call the analysis service
        return {
            "volatility": 0,
            "sharpe_ratio": 0,
            "max_drawdown": 0,
            "beta": 1.0,
            "var_95": 0,
        }

    def _get_allocation_data(self) -> dict:
        """Get allocation data."""
        positions = self._get_positions()
        total_value = sum(p.get("value", 0) for p in positions)

        if not total_value:
            return {}

        # Sort by value
        sorted_positions = sorted(positions, key=lambda p: p.get("value", 0), reverse=True)

        top_5_value = sum(p.get("value", 0) for p in sorted_positions[:5])
        top_10_value = sum(p.get("value", 0) for p in sorted_positions[:10])

        cash_value = sum(
            p.get("value", 0)
            for p in positions
            if p.get("ticker", "").upper() in ("CASH", "SPAXX", "SWVXX", "VMFXX")
        )

        return {
            "top_5_pct": (top_5_value / total_value * 100) if total_value else 0,
            "top_10_pct": (top_10_value / total_value * 100) if total_value else 0,
            "cash_pct": (cash_value / total_value * 100) if total_value else 0,
            "invested_pct": ((total_value - cash_value) / total_value * 100) if total_value else 0,
            "top_holdings": sorted_positions[:10],
        }

    def _get_retirement_metrics(self) -> dict:
        """Get retirement projection metrics."""
        # This would typically come from the Monte Carlo results
        return {
            "success_rate": 0,
            "monthly_income": 0,
            "earliest_retirement_age": 0,
            "fire_number": 0,
        }

    def _get_user_context(self) -> dict:
        """Get user context for personalization."""
        # Try to get from settings
        try:
            settings = self.db.get_settings()
            return {
                "user_age": settings.get("current_age", 35),
                "retirement_age": settings.get("retirement_age", 65),
                "risk_tolerance": settings.get("risk_tolerance", "moderate"),
            }
        except Exception:
            return {
                "user_age": 35,
                "retirement_age": 65,
                "risk_tolerance": "moderate",
            }

    def _sanitize_search_context(self, context: dict) -> dict:
        """Sanitize user context values for use in search queries.

        Prevents format string injection and removes potentially dangerous characters.

        Args:
            context: User context dictionary

        Returns:
            Sanitized context dictionary
        """
        sanitized = {}
        for key, value in context.items():
            if isinstance(value, (int, float)):
                sanitized[key] = value
            elif isinstance(value, str):
                # Remove potentially dangerous characters and limit length
                clean = re.sub(r'[{}\[\]<>|&;$`\\\'"]', '', str(value))[:100]
                sanitized[key] = clean
            else:
                sanitized[key] = str(value)[:100]
        return sanitized

    def _perform_web_searches(self, queries: list[str], user_context: dict) -> dict:
        """Perform web searches for comparison data.

        Args:
            queries: List of search query templates
            user_context: User context for substituting placeholders

        Returns:
            Dictionary of search results
        """
        results = {}

        # Sanitize user context to prevent format string injection
        safe_context = self._sanitize_search_context(user_context)

        # Format queries with sanitized user context
        formatted_queries = []
        for query in queries[:MAX_WEB_SEARCHES_PER_ELEMENT]:
            try:
                formatted = query.format(**safe_context, current_year=datetime.now().year)
                # Additional query sanitization - limit length
                formatted_queries.append(formatted[:200])
            except KeyError:
                formatted_queries.append(query[:200])

        # Try to use web search
        try:
            # Import here to avoid circular imports

            client = self._get_client()
            if not client:
                return results

            for query in formatted_queries:
                try:
                    # Use Claude to search and summarize
                    response = client.messages.create(
                        model=get_claude_model(),
                        max_tokens=256,
                        messages=[{
                            "role": "user",
                            "content": f"""Search for: {query}

Provide a brief factual summary (1-2 sentences) of the key statistic or data point. Include the source if known. If you don't have reliable data, say so."""
                        }],
                    )
                    results[query] = response.content[0].text
                except Exception as e:
                    logger.warning(f"Web search failed for '{query}': {e}")

        except Exception as e:
            logger.warning(f"Web search not available: {e}")

        return results

    def _format_comparison_context(self, comparison_data: dict) -> str:
        """Format comparison data into a context string for prompts.

        Args:
            comparison_data: Dictionary of search query -> result

        Returns:
            Formatted string for inclusion in prompts
        """
        if not comparison_data:
            return "No comparison data available."

        lines = ["**Comparison Data (from web search):**"]
        for query, result in comparison_data.items():
            lines.append(f"- {result}")

        return "\n".join(lines)
