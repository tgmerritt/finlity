"""
Entity API endpoints for owner/entity management.

Provides endpoints for:
- Entity CRUD operations
- Entity auto-detection from account names
- Entity assignment for accounts, income, expenses
"""

import logging
import re
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError

from src.database import get_database
from src.database.models import Account, BudgetIncomeSource

logger = logging.getLogger(__name__)

# Valid entity types
VALID_ENTITY_TYPES = ("individual", "household", "trust", "llc")

router = APIRouter(prefix="/api/entities", tags=["entities"])


# =============================================================================
# Request/Response Models
# =============================================================================


class EntityCreate(BaseModel):
    """Request model for creating an entity."""
    name: str
    entity_type: Literal["individual", "household", "trust", "llc"] = "individual"
    is_default: bool = False
    color: Optional[str] = None
    icon: Optional[str] = None


class EntityUpdate(BaseModel):
    """Request model for updating an entity."""
    name: Optional[str] = None
    entity_type: Optional[Literal["individual", "household", "trust", "llc"]] = None
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
    try:
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
    except SQLAlchemyError as e:
        logger.error(f"Database error in list_entities: {e}")
        raise HTTPException(status_code=500, detail="Unable to retrieve entities")


@router.post("/")
async def create_entity(data: EntityCreate) -> EntityResponse:
    """Create a new entity."""
    try:
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
    except SQLAlchemyError as e:
        logger.error(f"Database error in create_entity: {e}")
        raise HTTPException(status_code=500, detail="Unable to create entity")


@router.get("/{entity_id}")
async def get_entity(entity_id: str) -> EntityResponse:
    """Get entity details."""
    try:
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
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        logger.error(f"Database error in get_entity: {e}")
        raise HTTPException(status_code=500, detail="Unable to retrieve entity")


@router.put("/{entity_id}")
async def update_entity(entity_id: str, data: EntityUpdate) -> EntityResponse:
    """Update an entity."""
    try:
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
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        logger.error(f"Database error in update_entity: {e}")
        raise HTTPException(status_code=500, detail="Unable to update entity")


@router.delete("/{entity_id}")
async def delete_entity(entity_id: str) -> dict:
    """Delete an entity."""
    try:
        db = get_database()
        success = db.delete_entity(entity_id)
        if not success:
            raise HTTPException(status_code=404, detail="Entity not found")
        return {"success": True, "message": "Entity deleted"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except SQLAlchemyError as e:
        logger.error(f"Database error in delete_entity: {e}")
        raise HTTPException(status_code=500, detail="Unable to delete entity")


@router.get("/{entity_id}/summary")
async def get_entity_summary(entity_id: str) -> dict:
    """Get portfolio summary for an entity."""
    try:
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
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        logger.error(f"Database error in get_entity_summary: {e}")
        raise HTTPException(status_code=500, detail="Unable to retrieve entity summary")


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
    try:
        db = get_database()

        # Ensure household entity exists
        household = db.ensure_household_entity()

        # Patterns to extract names from account/income names
        # Match patterns like:
        #   - "John's 401k" -> captures "John"
        #   - "Schwab Alex IRA" -> captures "Alex" (after optional brokerage prefix)
        #   - "Alex Roth IRA" -> captures "Alex"
        # Requires: Name must start with uppercase, followed by lowercase letters
        # Does NOT match: All-caps names like "JOHN", names without space/possessive after
        name_pattern = re.compile(r"^(?:[A-Za-z]+\s+)?([A-Z][a-z]+)(?:'s?\s|\s)")

        # Exclude common financial terms, account types, and company names
        excluded_names = {
            # Account types
            "Roth", "Traditional", "Rollover", "Inherited", "Beneficiary",
            "Individual", "Joint", "Custodial", "Trust", "Estate",
            # Financial institutions and providers
            "Schwab", "Fidelity", "Vanguard", "Marcus", "Optum", "Human",
            "Principal", "Merrill", "Morgan", "Chase", "Wells", "Citi",
            "Ally", "Capital", "American", "United", "First", "National",
            # Account descriptors
            "High", "Yield", "Savings", "Checking", "Money", "Market",
            "Health", "College", "Education", "Retirement", "Brokerage",
            "Taxable", "Investment", "Personal", "Business", "Corporate",
        }

        detected_names: set[str] = set()
        associations: dict[str, list[str]] = {}  # entity_name -> [record_ids]

        # Scan account names
        with db.get_session() as session:
            accounts = session.query(Account).all()
            for account in accounts:
                match = name_pattern.match(account.name)
                if match:
                    name = match.group(1)
                    if name not in excluded_names:
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
                    if name not in excluded_names:
                        detected_names.add(name)
                        if name not in associations:
                            associations[name] = []
                        associations[name].append(f"income:{income.id}")

        # Create entities for detected names
        created_entities = []
        assigned_accounts = 0
        assigned_income = 0
        failed_assignments: list[str] = []

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

            # Assign records to entity, tracking failures
            for record_ref in associations.get(name, []):
                record_type, record_id = record_ref.split(":", 1)
                try:
                    if record_type == "account":
                        if db.assign_account_to_entity(record_id, entity.id):
                            assigned_accounts += 1
                        else:
                            failed_assignments.append(f"{record_ref} (not found)")
                    elif record_type == "income":
                        if db.assign_income_source_to_entity(record_id, entity.id):
                            assigned_income += 1
                        else:
                            failed_assignments.append(f"{record_ref} (not found)")
                except Exception as e:
                    failed_assignments.append(f"{record_ref} ({str(e)})")

        return {
            "success": len(failed_assignments) == 0,
            "entities_created": created_entities,
            "entities_created_count": len(created_entities),
            "accounts_assigned": assigned_accounts,
            "income_sources_assigned": assigned_income,
            "household_entity_id": household.id,
            "detected_names": list(sorted(detected_names)),
            "failed_assignments": failed_assignments,
            "warnings": f"{len(failed_assignments)} assignment(s) failed" if failed_assignments else None,
        }
    except SQLAlchemyError as e:
        logger.error(f"Database error in auto_detect_entities: {e}")
        raise HTTPException(status_code=500, detail="Unable to auto-detect entities")


# =============================================================================
# Assignment Endpoints
# =============================================================================


@router.post("/accounts/{account_id}/assign")
async def assign_account_entity(account_id: str, data: AssignEntityRequest) -> dict:
    """Assign an entity to an account."""
    try:
        db = get_database()

        # Validate entity exists if an ID is provided
        if data.entity_id:
            entity = db.get_entity_by_id(data.entity_id)
            if not entity:
                raise HTTPException(status_code=400, detail="Entity not found")

        success = db.assign_account_to_entity(account_id, data.entity_id)
        if not success:
            raise HTTPException(status_code=404, detail="Account not found")

        return {"success": True, "account_id": account_id, "entity_id": data.entity_id}
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        logger.error(f"Database error in assign_account_entity: {e}")
        raise HTTPException(status_code=500, detail="Unable to assign entity to account")


@router.post("/income/{income_id}/assign")
async def assign_income_entity(income_id: str, data: AssignEntityRequest) -> dict:
    """Assign an entity to an income source."""
    try:
        db = get_database()

        # Validate entity exists if an ID is provided
        if data.entity_id:
            entity = db.get_entity_by_id(data.entity_id)
            if not entity:
                raise HTTPException(status_code=400, detail="Entity not found")

        success = db.assign_income_source_to_entity(income_id, data.entity_id)
        if not success:
            raise HTTPException(status_code=404, detail="Income source not found")

        return {"success": True, "income_id": income_id, "entity_id": data.entity_id}
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        logger.error(f"Database error in assign_income_entity: {e}")
        raise HTTPException(status_code=500, detail="Unable to assign entity to income source")


@router.post("/expenses/{expense_id}/assign")
async def assign_expense_entity(expense_id: str, data: AssignEntityRequest) -> dict:
    """Assign an entity to an expense."""
    try:
        db = get_database()

        # Validate entity exists if an ID is provided
        if data.entity_id:
            entity = db.get_entity_by_id(data.entity_id)
            if not entity:
                raise HTTPException(status_code=400, detail="Entity not found")

        success = db.assign_expense_to_entity(expense_id, data.entity_id)
        if not success:
            raise HTTPException(status_code=404, detail="Expense not found")

        return {"success": True, "expense_id": expense_id, "entity_id": data.entity_id}
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        logger.error(f"Database error in assign_expense_entity: {e}")
        raise HTTPException(status_code=500, detail="Unable to assign entity to expense")
