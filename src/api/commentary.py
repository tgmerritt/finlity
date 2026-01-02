"""Commentary API endpoints for AI-generated dashboard insights."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

from src.database import Database
from src.services.commentary_service import CommentaryService
from src.services.commentary_registry import (
    ELEMENT_REGISTRY,
    get_element_config,
    get_elements_by_tab,
)

router = APIRouter(prefix="/api/commentary", tags=["commentary"])


def get_db() -> Database:
    """Dependency to get database instance (profile-aware)."""
    from src.database import get_database
    return get_database()


def get_commentary_service(db: Database = Depends(get_db)) -> CommentaryService:
    """Dependency to get commentary service."""
    return CommentaryService(db)


# =============================================================================
# Response Models
# =============================================================================


class CommentaryResponse(BaseModel):
    """Response model for a single commentary."""
    element_id: str
    title: str
    tab: str
    element_type: str
    commentary: str
    comparison_data: Optional[dict] = None
    action_items: Optional[list] = None
    generated_at: Optional[datetime] = None
    is_cached: bool = False
    age_hours: float = 0
    error: Optional[str] = None


class BatchCommentaryResponse(BaseModel):
    """Response model for batch commentary request."""
    results: dict[str, CommentaryResponse]
    total_requested: int
    successful: int
    cached: int
    errors: int


class RefreshResponse(BaseModel):
    """Response model for refresh operation."""
    refreshed_count: int
    skipped_count: int
    error_count: int
    errors: list[str]


class CommentaryStatusResponse(BaseModel):
    """Response model for commentary status."""
    total_cached: int
    total_elements: int
    coverage_pct: float
    by_tab: dict[str, int]
    oldest_generated: Optional[str] = None
    newest_generated: Optional[str] = None


class ElementListResponse(BaseModel):
    """Response model for listing available elements."""
    elements: list[dict]
    total: int


# =============================================================================
# Endpoints
# =============================================================================


@router.get("/elements", response_model=ElementListResponse)
def list_available_elements(
    tab: Optional[str] = Query(None, description="Filter by tab"),
):
    """List all available elements that can receive AI commentary.

    Args:
        tab: Optional tab filter

    Returns:
        List of element configurations
    """
    if tab:
        elements = get_elements_by_tab(tab)
    else:
        elements = ELEMENT_REGISTRY

    element_list = []
    for element_id, config in elements.items():
        element_list.append({
            "element_id": element_id,
            "title": config.get("title", element_id),
            "type": config.get("type", "unknown"),
            "tab": config.get("tab", "unknown"),
            "data_dependencies": config.get("data_dependencies", []),
            "refresh_triggers": config.get("refresh_triggers", []),
        })

    return ElementListResponse(
        elements=element_list,
        total=len(element_list),
    )


@router.get("/status", response_model=CommentaryStatusResponse)
def get_commentary_status(
    service: CommentaryService = Depends(get_commentary_service),
):
    """Get status information about the commentary cache.

    Returns:
        Cache statistics and coverage information
    """
    status = service.get_commentary_status()

    return CommentaryStatusResponse(
        total_cached=status["total_cached"],
        total_elements=status["total_elements"],
        coverage_pct=status["coverage_pct"],
        by_tab=status["by_tab"],
        oldest_generated=status["oldest_generated"],
        newest_generated=status["newest_generated"],
    )


@router.get("/batch/", response_model=BatchCommentaryResponse)
def get_batch_commentary(
    ids: str = Query(..., description="Comma-separated list of element IDs"),
    force_refresh: bool = Query(False, description="Force regeneration"),
    service: CommentaryService = Depends(get_commentary_service),
):
    """Get AI commentary for multiple elements.

    Args:
        ids: Comma-separated list of element IDs
        force_refresh: If True, regenerate all commentary

    Returns:
        Dictionary of commentary results
    """
    element_ids = [eid.strip() for eid in ids.split(",") if eid.strip()]

    if not element_ids:
        raise HTTPException(status_code=400, detail="No element IDs provided")

    if len(element_ids) > 50:
        raise HTTPException(status_code=400, detail="Maximum 50 elements per request")

    results = service.get_batch_commentary(element_ids, force_refresh=force_refresh)

    response_results = {}
    cached_count = 0
    error_count = 0

    for element_id, result in results.items():
        config = get_element_config(element_id) or {}
        response_results[element_id] = CommentaryResponse(
            element_id=result.element_id,
            title=config.get("title", element_id),
            tab=config.get("tab", "unknown"),
            element_type=config.get("type", "unknown"),
            commentary=result.commentary,
            comparison_data=result.comparison_data,
            action_items=result.action_items,
            generated_at=result.generated_at,
            is_cached=result.is_cached,
            age_hours=result.age_hours,
            error=result.error,
        )
        if result.is_cached:
            cached_count += 1
        if result.error:
            error_count += 1

    return BatchCommentaryResponse(
        results=response_results,
        total_requested=len(element_ids),
        successful=len(results) - error_count,
        cached=cached_count,
        errors=error_count,
    )


@router.get("/tab/{tab_name}", response_model=BatchCommentaryResponse)
def get_tab_commentary(
    tab_name: str,
    force_refresh: bool = Query(False, description="Force regeneration"),
    service: CommentaryService = Depends(get_commentary_service),
):
    """Get all commentary for elements on a specific tab.

    Args:
        tab_name: Tab name (dashboard, holdings, analysis, projections, taxes, budget)
        force_refresh: If True, regenerate all commentary

    Returns:
        Dictionary of commentary results for all elements on the tab
    """
    valid_tabs = ["dashboard", "holdings", "analysis", "projections", "taxes", "budget"]
    if tab_name not in valid_tabs:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid tab: {tab_name}. Valid tabs: {', '.join(valid_tabs)}"
        )

    elements = get_elements_by_tab(tab_name)
    if not elements:
        return BatchCommentaryResponse(
            results={},
            total_requested=0,
            successful=0,
            cached=0,
            errors=0,
        )

    results = service.get_batch_commentary(list(elements.keys()), force_refresh=force_refresh)

    response_results = {}
    cached_count = 0
    error_count = 0

    for element_id, result in results.items():
        config = get_element_config(element_id) or {}
        response_results[element_id] = CommentaryResponse(
            element_id=result.element_id,
            title=config.get("title", element_id),
            tab=config.get("tab", "unknown"),
            element_type=config.get("type", "unknown"),
            commentary=result.commentary,
            comparison_data=result.comparison_data,
            action_items=result.action_items,
            generated_at=result.generated_at,
            is_cached=result.is_cached,
            age_hours=result.age_hours,
            error=result.error,
        )
        if result.is_cached:
            cached_count += 1
        if result.error:
            error_count += 1

    return BatchCommentaryResponse(
        results=response_results,
        total_requested=len(elements),
        successful=len(results) - error_count,
        cached=cached_count,
        errors=error_count,
    )


class RefreshRequest(BaseModel):
    """Request model for refresh operation."""
    element_ids: Optional[list[str]] = None
    tab: Optional[str] = None


@router.post("/refresh", response_model=RefreshResponse)
def refresh_commentary(
    request: RefreshRequest = None,
    service: CommentaryService = Depends(get_commentary_service),
):
    """Manually refresh commentary for specified elements or all.

    Args:
        request: Optional request body with element_ids or tab filter

    Returns:
        Refresh operation results
    """
    if request and request.element_ids:
        # Refresh specific elements
        results = service.get_batch_commentary(request.element_ids, force_refresh=True)
        errors = [r.error for r in results.values() if r.error]
        return RefreshResponse(
            refreshed_count=len(results) - len(errors),
            skipped_count=0,
            error_count=len(errors),
            errors=errors,
        )
    elif request and request.tab:
        # Refresh all elements on a tab
        result = service.refresh_stale_commentary(tab=request.tab)
    else:
        # Refresh all stale commentary
        result = service.refresh_stale_commentary()

    return RefreshResponse(
        refreshed_count=result.refreshed_count,
        skipped_count=result.skipped_count,
        error_count=result.error_count,
        errors=result.errors,
    )


class InvalidateRequest(BaseModel):
    """Request model for invalidate operation."""
    trigger: str


@router.post("/invalidate")
def invalidate_commentary(
    request: InvalidateRequest,
    service: CommentaryService = Depends(get_commentary_service),
):
    """Invalidate commentary based on a trigger event.

    This marks commentary as stale, forcing regeneration on next access.

    Args:
        request: The trigger event (position_change, price_update, settings_change, etc.)

    Returns:
        Number of commentaries invalidated
    """
    valid_triggers = ["position_change", "price_update", "settings_change", "budget_change", "daily"]
    if request.trigger not in valid_triggers:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid trigger: {request.trigger}. Valid triggers: {', '.join(valid_triggers)}"
        )

    count = service.invalidate_commentary(request.trigger)

    return {
        "trigger": request.trigger,
        "invalidated_count": count,
    }


# NOTE: This route MUST be last because it matches any path segment
@router.get("/{element_id}", response_model=CommentaryResponse)
def get_element_commentary(
    element_id: str,
    force_refresh: bool = Query(False, description="Force regeneration even if cached"),
    service: CommentaryService = Depends(get_commentary_service),
):
    """Get AI commentary for a specific dashboard element.

    Args:
        element_id: The element identifier (e.g., "dashboard.total_value")
        force_refresh: If True, regenerate commentary even if cached

    Returns:
        Commentary for the element
    """
    config = get_element_config(element_id)
    if not config:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown element: {element_id}. Use GET /api/commentary/elements to see available elements."
        )

    result = service.get_commentary(element_id, force_refresh=force_refresh)

    return CommentaryResponse(
        element_id=result.element_id,
        title=config.get("title", element_id),
        tab=config.get("tab", "unknown"),
        element_type=config.get("type", "unknown"),
        commentary=result.commentary,
        comparison_data=result.comparison_data,
        action_items=result.action_items,
        generated_at=result.generated_at,
        is_cached=result.is_cached,
        age_hours=result.age_hours,
        error=result.error,
    )
