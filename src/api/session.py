"""
Session API endpoints.

Provides endpoints for:
- Initializing a session and retrieving the HMAC signing key
- Getting session information
"""

from fastapi import APIRouter, Request

from src.services.session import (
    get_session_manager,
    is_multi_user_mode,
    is_signing_enforced,
)


router = APIRouter(prefix="/api/session", tags=["session"])


@router.get("/init")
async def init_session(request: Request) -> dict:
    """
    Initialize session and return HMAC key for request signing.

    This endpoint should be called by the frontend on page load to:
    1. Get/create a session (sets cookie if new)
    2. Retrieve the HMAC key for signing mutating requests

    The HMAC key is used to sign POST/PUT/DELETE requests to prevent tampering.
    The signature is computed as:
        HMAC-SHA256(hmac_key, "{timestamp}:{nonce}:{method}:{path}")

    Response:
        {
            "session_id": "uuid",
            "hmac_key": "hex-encoded-key",
            "expires_in": 7200,
            "signing_required": true
        }
    """
    # Session should already be set by middleware
    session = getattr(request.state, "session", None)

    if not session:
        # Fallback: create session if middleware didn't run
        manager = get_session_manager()
        session = manager.create_session()

    return {
        "session_id": session.id,
        "hmac_key": session.hmac_key,
        "expires_in": 7200,  # 2 hours
        "signing_required": is_signing_enforced(),
        "multi_user_mode": is_multi_user_mode(),
    }


@router.get("/info")
async def session_info(request: Request) -> dict:
    """
    Get current session information.

    Returns session metadata without exposing the HMAC key.
    Useful for debugging and monitoring.
    """
    session = getattr(request.state, "session", None)

    if not session:
        return {
            "has_session": False,
            "multi_user_mode": is_multi_user_mode(),
            "signing_required": is_signing_enforced(),
        }

    return {
        "has_session": True,
        "session_id": session.id,
        "created_at": session.created_at.isoformat(),
        "last_accessed": session.last_accessed.isoformat(),
        "multi_user_mode": is_multi_user_mode(),
        "signing_required": is_signing_enforced(),
    }


@router.get("/stats")
async def session_stats() -> dict:
    """
    Get session manager statistics.

    Returns aggregate stats, not individual session data.
    Useful for monitoring server health.
    """
    manager = get_session_manager()

    return {
        "active_sessions": manager.session_count(),
        "multi_user_mode": is_multi_user_mode(),
        "signing_required": is_signing_enforced(),
    }
