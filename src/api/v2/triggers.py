"""Stateless v2 trigger-evaluation endpoint."""

from pydantic import BaseModel

from fastapi import APIRouter

from src.api.v2.payload import PortfolioPayload, TriggerPayload, payload_to_raw_positions
from src.services.triggers import build_portfolio_data_from_payload, TriggerEvaluator

router = APIRouter(prefix="/api/v2/triggers", tags=["v2-triggers"])


class TriggerResultResponse(BaseModel):
    """Response model for trigger evaluation result. Mirrors v1's shape."""

    trigger_id: str
    trigger_name: str
    triggered: bool
    current_value: float
    threshold: float
    operator: str
    condition_description: str
    message: str


class TriggerEvaluateRequest(BaseModel):
    triggers: list[TriggerPayload]
    portfolio: PortfolioPayload


class _TriggerLike:
    """Adapts a TriggerPayload to the attribute access `evaluate_trigger` expects."""

    def __init__(self, t: TriggerPayload):
        self.id = t.id or ""
        self.name = t.name
        self.condition_type = t.condition_type
        self.ticker = t.ticker
        self.account_type = t.account_type
        self.sector = t.sector
        self.operator = t.operator
        self.threshold = t.threshold
        self.is_active = t.is_active


@router.post("/evaluate", response_model=list[TriggerResultResponse])
def evaluate_triggers(request: TriggerEvaluateRequest) -> list["TriggerResultResponse"]:
    """Evaluate client-supplied triggers against a client-supplied portfolio.

    No DB access: `evaluate_trigger` (src/services/triggers.py) is pure and
    duck-typed on the trigger's attributes, so it runs unchanged here.
    """
    raw_positions = payload_to_raw_positions(request.portfolio)
    portfolio_data = build_portfolio_data_from_payload(raw_positions)

    # db=None is safe: evaluate_trigger() never touches self.db, only
    # evaluate_all()/_get_portfolio_data() (which v2 doesn't call) do.
    evaluator = TriggerEvaluator(db=None)  # type: ignore[arg-type]

    results = [
        evaluator.evaluate_trigger(_TriggerLike(t), portfolio_data)
        for t in request.triggers
    ]

    return [
        TriggerResultResponse(
            trigger_id=r.trigger_id,
            trigger_name=r.trigger_name,
            triggered=r.triggered,
            current_value=r.current_value,
            threshold=r.threshold,
            operator=r.operator,
            condition_description=r.condition_description,
            message=r.message,
        )
        for r in results
    ]
