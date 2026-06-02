"""
Tax-Loss Harvester Analysis Plugin

Identifies lots with unrealized losses that could be sold to offset capital
gains and reduce tax liability. Implements:

  - Lot-level tracking (multiple PositionLot rows per Position) with a
    synthetic-single-lot fallback for positions that have not yet been
    decomposed into lots.
  - IRS wash-sale rule: a loss is disallowed if substantially identical
    securities were purchased within 30 days before OR 30 days after the
    loss-realizing sale (61-day total window). The rule is symmetric, so
    recent RealizedSale rows of the same ticker also flag risk.
  - Short-term (<= 365 holding days, taxed as ordinary income) vs long-term
    distinction for both ranking and estimated tax savings.
  - Retirement-account replacement warning per IRS Rev. Rul. 2008-5: a
    replacement buy in an IRA still triggers a wash-sale on a taxable-account
    loss.

Backward compatibility notes:
  - The old per-candidate keys (`name`, `account_name`, `loss_percent`) and
    the positive-magnitude `unrealized_loss` are preserved alongside the new
    fields. The signed value is exposed as `unrealized_gain_loss`.
  - The old top-level metric keys (total_unrealized_losses,
    estimated_tax_savings, harvesting_opportunities, largest_loss_position,
    candidates, largest_loss_amount, tax_rate_used) all remain.

Scope limitations (documented for reviewers):
  - "Substantially identical" is currently same-ticker only. Cross-fund-family
    equivalents (e.g., VTI <-> ITOT) are out of scope for this sprint.
  - Wash-sale window is computed against `today` as the simulated sale date.
    This is conservative — it flags more risk than would actually trigger.
  - The pipeline only passes `positions` and `accounts` dicts, with no
    entity boundary, so wash-sale checks treat all passed accounts as one
    scope. Adding entity-scoping is a future refinement.
  - Lots & realized-sales are not yet populated by importers; the new code
    paths are exercised by tests and by users who hand-populate. The fallback
    path covers production until the importer is updated.
"""

import logging
from datetime import datetime
from typing import Any, Optional

from src.plugins.base import AnalysisPlugin, AnalysisResult

logger = logging.getLogger(__name__)


# Default marginal rates used for estimated_tax_savings.
# TODO: read marginal rates from BudgetTaxConfig once integrated.
DEFAULT_ST_RATE = 0.24   # ordinary-income marginal (proxy)
DEFAULT_LT_RATE = 0.15   # long-term capital-gains rate
WASH_SALE_WINDOW_DAYS = 30
LONG_TERM_HOLDING_DAYS = 365  # > 365 days qualifies as long-term

RETIREMENT_ACCOUNT_TYPES = {
    "traditional_401k", "roth_401k", "traditional_ira", "roth_ira",
    "hsa", "pension", "sep_ira", "simple_ira",
}


class TaxLossHarvester(AnalysisPlugin):
    """Lot-aware tax-loss harvester with IRS wash-sale awareness."""

    def analyze(self, positions: list[dict], accounts: list[dict]) -> AnalysisResult:
        """
        Args:
            positions: List of position dictionaries. May include an optional
                ``lots`` key (list of dicts with id/purchase_date/shares/
                cost_basis), and the analyzer will use those for lot-level
                tracking. If absent or empty, falls back to a synthetic
                single-lot view using cost_basis/purchase_date/shares.
            accounts: List of account dictionaries. May include an optional
                ``realized_sales`` key (list of dicts with ticker/sale_date)
                used by the wash-sale lookback.
        """
        try:
            min_loss = float(self.get_setting("min_loss_threshold", 100) or 0)
            warn_wash_sales = bool(self.get_setting("include_wash_sale_warning", True))

            # The legacy `tax_rate` setting acts as an override for the
            # short-term (ordinary-income) rate when the user has set it.
            configured_rate = self.get_setting("tax_rate", None)
            if configured_rate is not None:
                st_rate = float(configured_rate) / 100.0
            else:
                st_rate = DEFAULT_ST_RATE
            lt_rate = DEFAULT_LT_RATE

            today = datetime.utcnow()

            # Build account lookups
            accounts_by_id = {a.get("id"): a for a in accounts}
            retirement_account_ids = {
                a.get("id")
                for a in accounts
                if a.get("is_retirement") or self._is_retirement_type(
                    a.get("account_type", "")
                )
            }

            # Index recent purchases (lots) by ticker, partitioned by whether
            # the holding account is taxable or retirement. A retirement-side
            # purchase still counts (Rev. Rul. 2008-5) but we surface it as
            # a separate reason for clarity.
            recent_purchases_taxable: dict[str, list[dict]] = {}
            recent_purchases_retirement: dict[str, list[dict]] = {}
            for pos in positions:
                acct_id = pos.get("account_id")
                ticker = (pos.get("ticker") or "").upper()
                if not ticker:
                    continue
                bucket = (
                    recent_purchases_retirement
                    if acct_id in retirement_account_ids
                    else recent_purchases_taxable
                )
                for lot in self._iter_lots(pos):
                    pdate = lot.get("purchase_date")
                    if pdate is None:
                        continue
                    pdate = self._coerce_dt(pdate)
                    if pdate is None:
                        continue
                    if abs((today - pdate).days) <= WASH_SALE_WINDOW_DAYS:
                        bucket.setdefault(ticker, []).append({
                            "purchase_date": pdate,
                            "account_id": acct_id,
                            "account_name": (accounts_by_id.get(acct_id) or {}).get(
                                "name", "Unknown"
                            ),
                            # Track the originating lot id so a loss lot
                            # doesn't flag itself as its own replacement.
                            "lot_id": str(lot.get("id") or "synthetic"),
                        })

            # Index recent realized sales by ticker (the rule is symmetric,
            # so a recent sale + today's harvest = wash-sale risk too).
            recent_sales: dict[str, list[dict]] = {}
            for acct in accounts:
                for sale in (acct.get("realized_sales") or []):
                    ticker = (sale.get("ticker") or "").upper()
                    sdate = self._coerce_dt(sale.get("sale_date"))
                    if not ticker or sdate is None:
                        continue
                    if (today - sdate).days <= WASH_SALE_WINDOW_DAYS and (today - sdate).days >= 0:
                        recent_sales.setdefault(ticker, []).append({
                            "sale_date": sdate,
                            "account_id": acct.get("id"),
                        })

            # Walk every lot of every loss-eligible position
            recommendations: list[dict] = []
            skipped_no_purchase_date = 0
            total_unrealized_losses = 0.0  # positive magnitude (legacy contract)

            for pos in positions:
                acct_id = pos.get("account_id")
                # Skip retirement accounts entirely as harvest targets
                # (no taxable benefit).
                if acct_id in retirement_account_ids:
                    continue

                ticker = (pos.get("ticker") or "").upper()
                current_price = pos.get("current_price") or 0
                if not ticker or current_price <= 0:
                    continue

                acct = accounts_by_id.get(acct_id) or {}
                acct_name = acct.get("name", "Unknown")

                for lot in self._iter_lots(pos):
                    lot_shares = lot.get("shares") or 0
                    lot_cost = lot.get("cost_basis")
                    if lot_shares <= 0 or lot_cost is None or lot_cost <= 0:
                        continue

                    pdate_raw = lot.get("purchase_date")
                    pdate = self._coerce_dt(pdate_raw) if pdate_raw is not None else None
                    if pdate is None:
                        # Can't determine ST/LT — skip with a note logged.
                        logger.info(
                            "Skipping lot for %s in account %s: no purchase_date "
                            "(cannot determine short-term vs long-term).",
                            ticker, acct_name,
                        )
                        skipped_no_purchase_date += 1
                        continue

                    holding_days = max((today - pdate).days, 0)
                    is_short_term = holding_days <= LONG_TERM_HOLDING_DAYS

                    contract_mult = float(pos.get("contract_multiplier") or 1)
                    current_value = lot_shares * current_price * contract_mult
                    unrealized = current_value - lot_cost  # signed; loss = negative

                    if unrealized >= 0:
                        continue
                    if abs(unrealized) < min_loss:
                        continue

                    # Wash-sale risk
                    risk, reason = self._classify_wash_sale(
                        ticker=ticker,
                        sale_account_id=acct_id,
                        sale_lot_id=str(lot.get("id") or "synthetic"),
                        recent_purchases_taxable=recent_purchases_taxable,
                        recent_purchases_retirement=recent_purchases_retirement,
                        recent_sales=recent_sales,
                        warn=warn_wash_sales,
                    )

                    rate = st_rate if is_short_term else lt_rate
                    estimated_tax_savings = abs(unrealized) * rate

                    notes: list[str] = []
                    if is_short_term:
                        notes.append(
                            "ST losses offset ordinary income (more valuable than LT)."
                        )
                    else:
                        notes.append(
                            "LT loss offsets long-term capital gains first."
                        )
                    if risk == "blocked":
                        notes.append(
                            "Wash-sale risk: replacement shares within 61-day window."
                        )
                    elif risk == "potential":
                        notes.append(
                            "Potential wash-sale risk; review before selling."
                        )

                    loss_pct = (unrealized / lot_cost) * 100 if lot_cost else 0.0

                    rec = {
                        # New (preferred) shape
                        "ticker": ticker,
                        "account": acct_name,
                        "lot_id": str(lot.get("id") or "synthetic"),
                        "purchase_date": pdate.isoformat(),
                        "holding_days": holding_days,
                        "is_short_term": is_short_term,
                        "shares": float(lot_shares),
                        "cost_basis": float(lot_cost),
                        "current_value": float(current_value),
                        "unrealized_gain_loss": float(unrealized),  # signed (negative)
                        "estimated_tax_savings": float(estimated_tax_savings),
                        "wash_sale_risk": risk,
                        "wash_sale_reason": reason,
                        "notes": notes,

                        # --- Backward-compat aliases (do not remove) ---
                        # The old analyzer emitted these and frontend/other
                        # plugins may consume them. `unrealized_loss` is kept
                        # as a positive magnitude (the old contract).
                        "name": pos.get("name", ticker),
                        "account_name": acct_name,
                        "unrealized_loss": float(abs(unrealized)),
                        "loss_percent": float(loss_pct),
                    }
                    recommendations.append(rec)
                    total_unrealized_losses += abs(unrealized)

            # Ranking: clean wash-sale first, then largest dollar loss,
            # ST tie-breaker (more valuable than LT).
            risk_order = {"none": 0, "potential": 1, "blocked": 2}
            recommendations.sort(key=lambda r: (
                risk_order.get(r["wash_sale_risk"], 99),
                -r["unrealized_loss"],
                0 if r["is_short_term"] else 1,
            ))

            # Aggregate tax savings using per-lot rates (more accurate than
            # the old single-rate calc); also expose the legacy single-rate
            # estimate so callers that read `tax_rate_used` still make sense.
            estimated_tax_savings_total = sum(
                r["estimated_tax_savings"] for r in recommendations
            )

            largest_loss_ticker = ""
            largest_loss_amount = 0.0
            if recommendations:
                top = recommendations[0]
                largest_loss_ticker = top["ticker"]
                largest_loss_amount = top["unrealized_loss"]

            insights = self._generate_insights(
                recommendations,
                total_unrealized_losses,
                estimated_tax_savings_total,
                st_rate,
                lt_rate,
                skipped_no_purchase_date,
            )

            metrics = {
                # --- Legacy keys (preserved) ---
                "total_unrealized_losses": total_unrealized_losses,
                "estimated_tax_savings": estimated_tax_savings_total,
                "harvesting_opportunities": len(recommendations),
                "largest_loss_position": largest_loss_ticker,
                "candidates": recommendations[:10],
                "largest_loss_amount": largest_loss_amount,
                "tax_rate_used": st_rate * 100,
                # --- New keys ---
                "recommendations": recommendations,
                "short_term_rate": st_rate,
                "long_term_rate": lt_rate,
                "skipped_no_purchase_date": skipped_no_purchase_date,
            }

            return AnalysisResult(
                success=True,
                metrics=metrics,
                insights=insights,
            )

        except Exception as e:
            logger.exception(f"Error in tax-loss harvesting analysis: {e}")
            return AnalysisResult(success=False, errors=[str(e)])

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _iter_lots(self, pos: dict) -> list[dict]:
        """Return the list of lots for a position.

        If the position dict carries a non-empty ``lots`` list, those are
        returned. Otherwise we synthesise a single lot from the legacy
        Position-level fields (cost_basis, shares, purchase_date). The
        synthetic lot is marked with ``id == "synthetic"``.
        """
        lots = pos.get("lots")
        if lots:
            return list(lots)
        return [{
            "id": "synthetic",
            "purchase_date": pos.get("purchase_date"),
            "shares": pos.get("shares", 0),
            "cost_basis": pos.get("cost_basis"),
        }]

    def _classify_wash_sale(
        self,
        ticker: str,
        sale_account_id: Optional[str],
        sale_lot_id: str,
        recent_purchases_taxable: dict[str, list[dict]],
        recent_purchases_retirement: dict[str, list[dict]],
        recent_sales: dict[str, list[dict]],
        warn: bool,
    ) -> tuple[str, Optional[str]]:
        """Return (risk_level, reason).

        Risk levels:
          - "blocked": replacement-share purchase exists in a taxable account
            within the 61-day window (the IRS rule fires here).
          - "potential": only retirement-account replacement shares OR a
            recent realized sale of the same ticker (still risky;
            Rev. Rul. 2008-5 makes IRA buys count, and a recent same-ticker
            sale means a buy-back today would re-trigger the rule).
          - "none": no replacement-share activity in the window.
        """
        if not warn:
            return "none", None

        # Exclude the loss lot itself from "replacement shares" — selling
        # the lot you just bought isn't a wash-sale; only OTHER lots count.
        taxable_hits = [
            h for h in recent_purchases_taxable.get(ticker, [])
            if h.get("lot_id") != sale_lot_id
        ]
        retirement_hits = recent_purchases_retirement.get(ticker, [])
        sale_hits = recent_sales.get(ticker, [])

        # A taxable purchase in the window — the canonical trigger.
        if taxable_hits:
            other_account = next(
                (h["account_name"] for h in taxable_hits
                 if h.get("account_id") != sale_account_id),
                None,
            )
            if other_account:
                reason = (
                    f"Same ticker purchased in another taxable account "
                    f"({other_account}) within {WASH_SALE_WINDOW_DAYS} days."
                )
            else:
                reason = (
                    f"Same ticker recently purchased in this account "
                    f"within {WASH_SALE_WINDOW_DAYS} days."
                )
            return "blocked", reason

        # IRA/401k replacement: per IRS Rev. Rul. 2008-5, a replacement
        # purchase in a retirement account also triggers the wash-sale rule
        # on the taxable-account loss.
        if retirement_hits:
            acct = retirement_hits[0]["account_name"]
            return (
                "potential",
                f"Same ticker held/purchased in retirement account ({acct}); "
                f"per IRS Rev. Rul. 2008-5, an IRA buy-back can trigger wash-sale.",
            )

        # Recent realized sale of the same ticker — symmetric rule.
        if sale_hits:
            return (
                "potential",
                f"Same ticker sold within the last {WASH_SALE_WINDOW_DAYS} days; "
                f"buying replacement shares would trigger wash-sale.",
            )

        return "none", None

    @staticmethod
    def _coerce_dt(value: Any) -> Optional[datetime]:
        """Coerce a date-like value (datetime or ISO string) into datetime."""
        if value is None:
            return None
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return None
        return None

    def _is_retirement_type(self, account_type: str) -> bool:
        return (account_type or "").lower() in RETIREMENT_ACCOUNT_TYPES

    def _generate_insights(
        self,
        recommendations: list[dict],
        total_losses: float,
        estimated_savings: float,
        st_rate: float,
        lt_rate: float,
        skipped_no_purchase_date: int,
    ) -> list[str]:
        insights: list[str] = []

        if not recommendations:
            insights.append(
                "No tax-loss harvesting opportunities found. "
                "Your taxable lots are all at or above cost."
            )
            if skipped_no_purchase_date:
                insights.append(
                    f"Skipped {skipped_no_purchase_date} lot(s) with no purchase "
                    "date — cannot determine short-term vs long-term."
                )
            return insights

        st_count = sum(1 for r in recommendations if r["is_short_term"])
        lt_count = len(recommendations) - st_count

        insights.append(
            f"Found {len(recommendations)} loss lot(s) "
            f"({st_count} short-term, {lt_count} long-term) "
            f"totaling ${total_losses:,.2f}. Estimated tax savings: "
            f"${estimated_savings:,.2f} (ST {st_rate*100:.0f}%, "
            f"LT {lt_rate*100:.0f}%)."
        )

        top = recommendations[0]
        insights.append(
            f"Top opportunity: {top['ticker']} "
            f"({'ST' if top['is_short_term'] else 'LT'}) — "
            f"${top['unrealized_loss']:,.2f} loss "
            f"({abs(top['loss_percent']):.1f}% down), wash-sale risk: "
            f"{top['wash_sale_risk']}."
        )

        blocked = [r for r in recommendations if r["wash_sale_risk"] == "blocked"]
        potential = [r for r in recommendations if r["wash_sale_risk"] == "potential"]
        if blocked:
            tickers = ", ".join(sorted({r["ticker"] for r in blocked})[:3])
            insights.append(
                f"Wash-sale BLOCKED for: {tickers}. Replacement shares "
                f"purchased within the 61-day window."
            )
        if potential:
            tickers = ", ".join(sorted({r["ticker"] for r in potential})[:3])
            insights.append(
                f"Wash-sale POTENTIAL for: {tickers}. Review IRA holdings "
                f"and recent sales before harvesting."
            )

        if skipped_no_purchase_date:
            insights.append(
                f"Skipped {skipped_no_purchase_date} lot(s) with no purchase "
                "date — cannot determine short-term vs long-term."
            )

        insights.append(
            "Remember: tax-loss harvesting must be completed by December 31 "
            "to apply to the current tax year."
        )
        return insights

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "analysis",
            "description": "Identify tax-loss harvesting opportunities (lot-level, wash-sale aware)",
            "metrics": [
                "total_unrealized_losses",
                "estimated_tax_savings",
                "harvesting_opportunities",
                "recommendations",
            ],
        }
