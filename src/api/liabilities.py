"""Liabilities API: debts counted against net worth.

Static paths (added in later tasks, e.g. /convert-position) must be declared
before the /{liability_id} routes.
"""

import logging
import re
from datetime import date, datetime
from typing import Annotated, Any, Literal, Optional, Union

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from src.api.dependencies import get_db
from src.database import Database
from src.liabilities import service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/liabilities", tags=["liabilities"])

LiabilityType = Literal["mortgage", "auto_loan", "student_loan", "credit_card", "personal_loan", "heloc", "other"]
Frequency = Literal["weekly", "biweekly", "monthly", "quarterly", "annual"]
Money = Field(ge=0, le=1e10)
_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _strict_day(value: Any) -> date:
    """Calendar days only: a 'YYYY-MM-DD' string, never a datetime."""
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not _ISO_DAY.match(value):
        raise ValueError("expected a YYYY-MM-DD date")
    return date.fromisoformat(value)


CalendarDay = Annotated[date, BeforeValidator(_strict_day)]
NON_NULLABLE = ("name", "liability_type", "payment_frequency", "is_amortizing", "is_active")


def check_demo_mode_write() -> None:
    """Refuse writes on the protected hosted demo (centralised check)."""
    from src.services.demo_mode import check_demo_data_protection

    check_demo_data_protection()


# =============================================================================
# Request/Response models
# =============================================================================


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PropertyLink(StrictModel):
    mode: Literal["link"]
    position_id: str = Field(min_length=1, max_length=64)


class PropertyCreate(StrictModel):
    mode: Literal["create"]
    name: str = Field(min_length=1, max_length=120)
    value: float = Money
    cost_basis: Optional[float] = Field(default=None, ge=0, le=1e10)
    purchase_date: Optional[CalendarDay] = None


class CashFlowCreate(StrictModel):
    mode: Literal["create"]
    category_id: Optional[str] = Field(default=None, max_length=64)


class CashFlowLink(StrictModel):
    mode: Literal["link"]
    expense_id: str = Field(min_length=1, max_length=64)


class CashFlowNone(StrictModel):
    mode: Literal["none"]


class _DateOrder(StrictModel):
    origination_date: Optional[CalendarDay] = None
    maturity_date: Optional[CalendarDay] = None

    @model_validator(mode="after")
    def _maturity_after_origination(self) -> "_DateOrder":
        if self.origination_date and self.maturity_date and self.maturity_date < self.origination_date:
            raise ValueError("maturity_date must be on or after origination_date")
        return self


class LiabilityFields(_DateOrder):
    name: str = Field(min_length=1, max_length=120)
    liability_type: LiabilityType
    lender: Optional[str] = Field(default=None, max_length=120)
    interest_rate: Optional[float] = Field(default=None, ge=0, le=1)
    payment_amount: Optional[float] = Field(default=None, ge=0, le=1e10)
    payment_frequency: Frequency = "monthly"
    next_payment_date: Optional[CalendarDay] = None
    escrow_amount: Optional[float] = Field(default=None, ge=0, le=1e10)
    original_principal: Optional[float] = Field(default=None, ge=0, le=1e10)
    term_months: Optional[int] = Field(default=None, ge=1, le=600)
    credit_limit: Optional[float] = Field(default=None, ge=0, le=1e10)
    is_amortizing: Optional[bool] = None
    entity_id: Optional[str] = Field(default=None, max_length=64)
    linked_position_id: Optional[str] = Field(default=None, max_length=64)
    notes: Optional[str] = Field(default=None, max_length=2000)
    source: Literal["manual", "wizard"] = "manual"


class CreateLiability(LiabilityFields):
    current_balance: float = Money
    balance_as_of: Optional[CalendarDay] = None
    property: Optional[Union[PropertyLink, PropertyCreate]] = Field(default=None, discriminator="mode")
    cash_flow: Optional[Union[CashFlowCreate, CashFlowLink, CashFlowNone]] = Field(default=None, discriminator="mode")


class UpdateLiability(_DateOrder):
    """Partial update. Balance changes go through POST /{id}/balance."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    liability_type: Optional[LiabilityType] = None
    lender: Optional[str] = Field(default=None, max_length=120)
    interest_rate: Optional[float] = Field(default=None, ge=0, le=1)
    payment_amount: Optional[float] = Field(default=None, ge=0, le=1e10)
    payment_frequency: Optional[Frequency] = None
    next_payment_date: Optional[CalendarDay] = None
    escrow_amount: Optional[float] = Field(default=None, ge=0, le=1e10)
    original_principal: Optional[float] = Field(default=None, ge=0, le=1e10)
    term_months: Optional[int] = Field(default=None, ge=1, le=600)
    credit_limit: Optional[float] = Field(default=None, ge=0, le=1e10)
    is_amortizing: Optional[bool] = None
    entity_id: Optional[str] = Field(default=None, max_length=64)
    linked_position_id: Optional[str] = Field(default=None, max_length=64)
    expense_id: Optional[str] = Field(default=None, max_length=64)
    notes: Optional[str] = Field(default=None, max_length=2000)
    is_active: Optional[bool] = None

    @model_validator(mode="after")
    def _no_null_required_fields(self) -> "UpdateLiability":
        for field in NON_NULLABLE:
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class RecordBalance(StrictModel):
    balance: float = Money
    as_of: Optional[CalendarDay] = None


class LiabilityResponse(BaseModel):
    """Resource plus computed fields (design D4). source_detail is never returned."""

    id: str
    entity_id: Optional[str]
    name: str
    liability_type: str
    lender: Optional[str]
    current_balance: float
    balance_as_of: str
    interest_rate: Optional[float]
    payment_amount: Optional[float]
    payment_frequency: str
    next_payment_date: Optional[str]
    escrow_amount: Optional[float]
    original_principal: Optional[float]
    origination_date: Optional[str]
    term_months: Optional[int]
    maturity_date: Optional[str]
    credit_limit: Optional[float]
    is_amortizing: bool
    linked_position_id: Optional[str]
    expense_id: Optional[str]
    source: str
    source_ref: Optional[str]
    is_active: bool
    closed_date: Optional[str]
    notes: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]
    estimated_balance: float
    payoff_date: Optional[str]
    periods_remaining: Optional[int]
    total_interest_remaining: Optional[float]
    monthly_payment: float
    monthly_cash_flow: float
    linked_position: Optional[dict[str, Any]]
    linked_position_missing: bool
    expense: Optional[dict[str, Any]]
    expense_missing: bool
    last_reported_date: Optional[str]


class DeleteLiabilityResponse(BaseModel):
    deleted: bool
    id: str
    expense_deleted: bool


class HistoryPoint(BaseModel):
    date: str
    balance: float
    source: Optional[str] = None


class LiabilityHistoryResponse(BaseModel):
    liability_id: str
    reported: list[HistoryPoint]
    series: list[HistoryPoint]


def _raise(exc: service.LiabilityError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.message)


# =============================================================================
# Endpoints
# =============================================================================


@router.get("", response_model=list[LiabilityResponse])
def list_liabilities(
    entity_id: Optional[str] = None, include_archived: bool = False, db: Database = Depends(get_db)
) -> list[dict[str, Any]]:
    return service.list_liabilities(db, entity_id, include_archived)


@router.post("", response_model=LiabilityResponse, status_code=201)
def create_liability(data: CreateLiability, db: Database = Depends(get_db)) -> dict[str, Any]:
    check_demo_mode_write()
    payload = data.model_dump()
    payload["property"] = data.property.model_dump() if data.property else None
    payload["cash_flow"] = data.cash_flow.model_dump() if data.cash_flow else None
    try:
        return service.create_liability(db, payload)
    except service.LiabilityError as exc:
        raise _raise(exc) from None


@router.get("/{liability_id}", response_model=LiabilityResponse)
def get_liability(liability_id: str, db: Database = Depends(get_db)) -> dict[str, Any]:
    try:
        return service.get_liability(db, liability_id)
    except service.LiabilityError as exc:
        raise _raise(exc) from None


@router.put("/{liability_id}", response_model=LiabilityResponse)
def update_liability(
    liability_id: str, data: UpdateLiability, sync_expense: bool = True, db: Database = Depends(get_db)
) -> dict[str, Any]:
    check_demo_mode_write()
    try:
        return service.update_liability(db, liability_id, data.model_dump(exclude_unset=True), sync_expense)
    except service.LiabilityError as exc:
        raise _raise(exc) from None


@router.delete("/{liability_id}", response_model=DeleteLiabilityResponse)
def delete_liability(liability_id: str, delete_expense: bool = False, db: Database = Depends(get_db)) -> dict[str, Any]:
    check_demo_mode_write()
    try:
        return service.delete_liability(db, liability_id, delete_expense)
    except service.LiabilityError as exc:
        raise _raise(exc) from None


@router.get("/{liability_id}/history", response_model=LiabilityHistoryResponse)
def get_liability_history(liability_id: str, db: Database = Depends(get_db)) -> dict[str, Any]:
    try:
        return service.get_history(db, liability_id)
    except service.LiabilityError as exc:
        raise _raise(exc) from None


@router.post("/{liability_id}/balance", response_model=LiabilityResponse)
def record_balance(liability_id: str, data: RecordBalance, db: Database = Depends(get_db)) -> dict[str, Any]:
    check_demo_mode_write()
    try:
        return service.record_balance(db, liability_id, data.balance, data.as_of)
    except service.LiabilityError as exc:
        raise _raise(exc) from None
