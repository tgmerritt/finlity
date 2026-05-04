"""Profile API endpoints for multi-database support.

Allows managing multiple separate portfolio databases for different
clients, families, or use cases.
"""

from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from src.database import get_profile_manager, Profile

router = APIRouter(prefix="/api/profiles", tags=["profiles"])


class ProfileCreate(BaseModel):
    """Request model for creating a profile."""
    name: str = Field(..., min_length=1, max_length=100, description="Profile display name")
    description: str = Field("", max_length=500, description="Optional description")
    icon: str = Field("user", description="Icon identifier")
    color: Optional[str] = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$', description="Hex color code")
    db_guid: Optional[str] = Field(None, description="Optional database GUID (auto-generated if not provided)")


class ProfileUpdate(BaseModel):
    """Request model for updating a profile."""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    icon: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r'^#[0-9A-Fa-f]{6}$')


class ProfileResponse(BaseModel):
    """Response model for a profile."""
    id: str
    name: str
    description: str
    created_at: str
    last_accessed: str
    icon: str
    color: str
    db_guid: str
    is_active: bool = False


class ProfileStatsResponse(BaseModel):
    """Response model for profile statistics."""
    total_size_mb: float
    db_size_mb: float
    account_count: int
    position_count: int


def _profile_to_response(profile: Profile, active_id: str) -> ProfileResponse:
    """Convert Profile to ProfileResponse."""
    return ProfileResponse(
        id=profile.id,
        name=profile.name,
        description=profile.description,
        created_at=profile.created_at,
        last_accessed=profile.last_accessed,
        icon=profile.icon,
        color=profile.color,
        db_guid=profile.db_guid,
        is_active=profile.id == active_id,
    )


@router.get("", response_model=list[ProfileResponse])
def list_profiles() -> list[ProfileResponse]:
    """List all available profiles."""
    manager = get_profile_manager()
    profiles = manager.list_profiles()
    active_id = manager.get_active_profile_id()

    return [_profile_to_response(p, active_id) for p in profiles]


@router.get("/active", response_model=ProfileResponse)
def get_active_profile() -> ProfileResponse:
    """Get the currently active profile."""
    manager = get_profile_manager()
    profile = manager.get_active_profile()

    if not profile:
        raise HTTPException(status_code=404, detail="No active profile")

    return _profile_to_response(profile, profile.id)


@router.get("/icons")
def get_available_icons() -> dict[str, Any]:
    """Get list of available profile icons."""
    from src.database.profile_manager import ProfileManager
    return {"icons": ProfileManager.PROFILE_ICONS}


@router.get("/colors")
def get_available_colors() -> dict[str, Any]:
    """Get list of suggested profile colors."""
    from src.database.profile_manager import ProfileManager
    return {"colors": ProfileManager.PROFILE_COLORS}


@router.post("", response_model=ProfileResponse)
def create_profile(request: ProfileCreate) -> ProfileResponse:
    """Create a new profile."""
    manager = get_profile_manager()

    try:
        profile = manager.create_profile(
            name=request.name,
            description=request.description,
            icon=request.icon,
            color=request.color,
            db_guid=request.db_guid,
        )
        return _profile_to_response(profile, manager.get_active_profile_id())

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{profile_id}", response_model=ProfileResponse)
def get_profile(profile_id: str) -> ProfileResponse:
    """Get a profile by ID."""
    manager = get_profile_manager()
    profile = manager.get_profile(profile_id)

    if not profile:
        raise HTTPException(status_code=404, detail=f"Profile not found: {profile_id}")

    return _profile_to_response(profile, manager.get_active_profile_id())


@router.put("/{profile_id}", response_model=ProfileResponse)
def update_profile(profile_id: str, request: ProfileUpdate) -> ProfileResponse:
    """Update a profile's metadata."""
    manager = get_profile_manager()

    profile = manager.update_profile(
        profile_id=profile_id,
        name=request.name,
        description=request.description,
        icon=request.icon,
        color=request.color,
    )

    if not profile:
        raise HTTPException(status_code=404, detail=f"Profile not found: {profile_id}")

    return _profile_to_response(profile, manager.get_active_profile_id())


@router.delete("/{profile_id}")
def delete_profile(profile_id: str) -> dict[str, Any]:
    """Delete a profile and all its data.

    Cannot delete the active profile or the default profile.
    """
    from src.services.demo_mode import check_demo_data_protection
    check_demo_data_protection()

    manager = get_profile_manager()

    try:
        success = manager.delete_profile(profile_id)
        if not success:
            raise HTTPException(status_code=404, detail=f"Profile not found: {profile_id}")
        return {"message": f"Profile '{profile_id}' deleted successfully"}

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{profile_id}/activate", response_model=ProfileResponse)
def activate_profile(profile_id: str) -> ProfileResponse:
    """Switch to a different profile."""
    manager = get_profile_manager()

    try:
        manager.activate_profile(profile_id)
        profile = manager.get_profile(profile_id)
        return _profile_to_response(profile, profile_id)

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/{profile_id}/duplicate", response_model=ProfileResponse)
def duplicate_profile(profile_id: str, new_name: str) -> ProfileResponse:
    """Create a copy of an existing profile."""
    manager = get_profile_manager()

    try:
        new_profile = manager.duplicate_profile(profile_id, new_name)
        return _profile_to_response(new_profile, manager.get_active_profile_id())

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{profile_id}/stats", response_model=ProfileStatsResponse)
def get_profile_stats(profile_id: str) -> ProfileStatsResponse:
    """Get statistics for a profile."""
    manager = get_profile_manager()

    profile = manager.get_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail=f"Profile not found: {profile_id}")

    stats = manager.get_profile_stats(profile_id)

    return ProfileStatsResponse(
        total_size_mb=stats["total_size_mb"],
        db_size_mb=stats["db_size_mb"],
        account_count=stats["account_count"],
        position_count=stats["position_count"],
    )


@router.post("/{profile_id}/export")
def export_profile(profile_id: str) -> FileResponse:
    """Export a profile to a ZIP file for backup or transfer."""
    manager = get_profile_manager()

    try:
        zip_path = manager.export_profile(profile_id)
        return FileResponse(
            path=str(zip_path),
            media_type="application/zip",
            filename=zip_path.name,
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/import")
async def import_profile(
    file: UploadFile = File(...),
    name: Optional[str] = None,
) -> ProfileResponse:
    """Import a profile from a ZIP file."""
    manager = get_profile_manager()

    # Save uploaded file temporarily
    temp_path = Path(f"data/temp/{file.filename}")
    temp_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        # Write uploaded file
        with open(temp_path, "wb") as f:
            content = await file.read()
            f.write(content)

        # Import the profile
        profile = manager.import_profile(str(temp_path), new_name=name)

        return _profile_to_response(profile, manager.get_active_profile_id())

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")

    finally:
        # Clean up temp file
        if temp_path.exists():
            temp_path.unlink()
