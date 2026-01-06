"""
Entity API endpoints for owner/entity management.

Provides endpoints for:
- Entity CRUD operations
- Entity auto-detection from account names
- Entity assignment for accounts, income, expenses
"""

import re
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.database import get_database
from src.database.models import Account, BudgetIncomeSource

router = APIRouter(prefix="/api/entities", tags=["entities"])


# =============================================================================
# Request/Response Models
# =============================================================================


class EntityCreate(BaseModel):
    """Request model for creating an entity."""
    name: str
    entity_type: str = "individual"
    is_default: bool = False
    color: Optional[str] = None
    icon: Optional[str] = None


class EntityUpdate(BaseModel):
    """Request model for updating an entity."""
    name: Optional[str] = None
    entity_type: Optional[str] = None
    is_default: Optional[bool] = None
    color: Optional[str] = None
    icon: Optional[str] = None


class EntityResponse(BaseModel):
    """Response model for an entity."""
    id: str
    name: str
    entity_type: str
    is_default: bool
    is_household: bool
    color: str
    icon: str
    account_count: int = 0
    income_count: int = 0
    expense_count: int = 0


class AssignEntityRequest(BaseModel):
    """Request model for assigning an entity to a record."""
    entity_id: Optional[str] = None  # None to unassign


# =============================================================================
# Entity CRUD Endpoints
# =============================================================================


@router.get("/")
async def list_entities() -> list[EntityResponse]:
    """List all entities with counts."""
    db = get_database()
    entities = db.get_all_entities()

    result = []
    for entity in entities:
        # Count associated records
        accounts = db.get_accounts_by_entity(entity.id)
        income_sources = db.get_income_sources_by_entity(entity.id)
        expenses = db.get_expenses_by_entity(entity.id)

        result.append(EntityResponse(
            id=entity.id,
            name=entity.name,
            entity_type=entity.entity_type,
            is_default=entity.is_default,
            is_household=entity.is_household,
            color=entity.color or "#4A90D9",
            icon=entity.icon or "user",
            account_count=len(accounts),
            income_count=len(income_sources),
            expense_count=len(expenses),
        ))

    return result


@router.post("/")
async def create_entity(data: EntityCreate) -> EntityResponse:
    """Create a new entity."""
    db = get_database()

    entity = db.create_entity(
        name=data.name,
        entity_type=data.entity_type,
        is_default=data.is_default,
        color=data.color,
        icon=data.icon,
    )

    return EntityResponse(
        id=entity.id,
        name=entity.name,
        entity_type=entity.entity_type,
        is_default=entity.is_default,
        is_household=entity.is_household,
        color=entity.color or "#4A90D9",
        icon=entity.icon or "user",
    )


@router.get("/{entity_id}")
async def get_entity(entity_id: str) -> EntityResponse:
    """Get entity details."""
    db = get_database()
    entity = db.get_entity_by_id(entity_id)

    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    accounts = db.get_accounts_by_entity(entity.id)
    income_sources = db.get_income_sources_by_entity(entity.id)
    expenses = db.get_expenses_by_entity(entity.id)

    return EntityResponse(
        id=entity.id,
        name=entity.name,
        entity_type=entity.entity_type,
        is_default=entity.is_default,
        is_household=entity.is_household,
        color=entity.color or "#4A90D9",
        icon=entity.icon or "user",
        account_count=len(accounts),
        income_count=len(income_sources),
        expense_count=len(expenses),
    )


@router.put("/{entity_id}")
async def update_entity(entity_id: str, data: EntityUpdate) -> EntityResponse:
    """Update an entity."""
    db = get_database()

    entity = db.update_entity(
        entity_id=entity_id,
        name=data.name,
        entity_type=data.entity_type,
        is_default=data.is_default,
        color=data.color,
        icon=data.icon,
    )

    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    accounts = db.get_accounts_by_entity(entity.id)
    income_sources = db.get_income_sources_by_entity(entity.id)
    expenses = db.get_expenses_by_entity(entity.id)

    return EntityResponse(
        id=entity.id,
        name=entity.name,
        entity_type=entity.entity_type,
        is_default=entity.is_default,
        is_household=entity.is_household,
        color=entity.color or "#4A90D9",
        icon=entity.icon or "user",
        account_count=len(accounts),
        income_count=len(income_sources),
        expense_count=len(expenses),
    )


@router.delete("/{entity_id}")
async def delete_entity(entity_id: str) -> dict:
    """Delete an entity."""
    db = get_database()

    try:
        success = db.delete_entity(entity_id)
        if not success:
            raise HTTPException(status_code=404, detail="Entity not found")
        return {"success": True, "message": "Entity deleted"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{entity_id}/summary")
async def get_entity_summary(entity_id: str) -> dict:
    """Get portfolio summary for an entity."""
    db = get_database()

    entity = db.get_entity_by_id(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    summary = db.get_portfolio_summary_by_entity(entity_id)
    return {
        "entity_id": entity_id,
        "entity_name": entity.name,
        **summary,
    }


# =============================================================================
# Auto-Detection Endpoint
# =============================================================================


@router.post("/auto-detect")
async def auto_detect_entities() -> dict:
    """Auto-create entities from existing account and income source names.

    Scans account names for patterns like:
    - "John's 401k" -> Creates "John" entity
    - "Schwab Alex IRA" -> Creates "Alex" entity
    - Names starting with a person's name followed by space or possessive
    """
    db = get_database()

    # Ensure household entity exists
    household = db.ensure_household_entity()

    # Patterns to extract names from
    # Match: "Name's ..." or "Name ..." at start of string
    name_pattern = re.compile(r"^(?:[A-Za-z]+\s+)?([A-Z][a-z]+)(?:'s?\s|\s)")

    detected_names: set[str] = set()
    associations: dict[str, list[str]] = {}  # entity_name -> [record_ids]

    # Scan account names
    with db.get_session() as session:
        accounts = session.query(Account).all()
        for account in accounts:
            match = name_pattern.match(account.name)
            if match:
                name = match.group(1)
                detected_names.add(name)
                if name not in associations:
                    associations[name] = []
                associations[name].append(f"account:{account.id}")

        # Scan income source names
        income_sources = session.query(BudgetIncomeSource).all()
        for income in income_sources:
            match = name_pattern.match(income.name)
            if match:
                name = match.group(1)
                detected_names.add(name)
                if name not in associations:
                    associations[name] = []
                associations[name].append(f"income:{income.id}")

    # Create entities for detected names
    created_entities = []
    assigned_accounts = 0
    assigned_income = 0

    # Define colors for entities
    colors = ["#4A90D9", "#E74C3C", "#2ECC71", "#9B59B6", "#F39C12", "#1ABC9C"]

    for idx, name in enumerate(sorted(detected_names)):
        # Check if entity already exists
        existing = None
        for entity in db.get_all_entities():
            if entity.name.lower() == name.lower():
                existing = entity
                break

        if not existing:
            color = colors[idx % len(colors)]
            entity = db.create_entity(
                name=name,
                entity_type="individual",
                color=color,
            )
            created_entities.append(name)
        else:
            entity = existing

        # Assign records to entity
        for record_ref in associations.get(name, []):
            record_type, record_id = record_ref.split(":", 1)
            if record_type == "account":
                if db.assign_account_to_entity(record_id, entity.id):
                    assigned_accounts += 1
            elif record_type == "income":
                if db.assign_income_source_to_entity(record_id, entity.id):
                    assigned_income += 1

    return {
        "success": True,
        "entities_created": created_entities,
        "entities_created_count": len(created_entities),
        "accounts_assigned": assigned_accounts,
        "income_sources_assigned": assigned_income,
        "household_entity_id": household.id,
        "detected_names": list(sorted(detected_names)),
    }


# =============================================================================
# Assignment Endpoints
# =============================================================================


@router.post("/accounts/{account_id}/assign")
async def assign_account_entity(account_id: str, data: AssignEntityRequest) -> dict:
    """Assign an entity to an account."""
    db = get_database()

    success = db.assign_account_to_entity(account_id, data.entity_id)
    if not success:
        raise HTTPException(status_code=404, detail="Account not found")

    return {"success": True, "account_id": account_id, "entity_id": data.entity_id}


@router.post("/income/{income_id}/assign")
async def assign_income_entity(income_id: str, data: AssignEntityRequest) -> dict:
    """Assign an entity to an income source."""
    db = get_database()

    success = db.assign_income_source_to_entity(income_id, data.entity_id)
    if not success:
        raise HTTPException(status_code=404, detail="Income source not found")

    return {"success": True, "income_id": income_id, "entity_id": data.entity_id}


@router.post("/expenses/{expense_id}/assign")
async def assign_expense_entity(expense_id: str, data: AssignEntityRequest) -> dict:
    """Assign an entity to an expense."""
    db = get_database()

    success = db.assign_expense_to_entity(expense_id, data.entity_id)
    if not success:
        raise HTTPException(status_code=404, detail="Expense not found")

    return {"success": True, "expense_id": expense_id, "entity_id": data.entity_id}
