"""
Session middleware for request-scoped isolation.

This middleware:
- Creates session cookies for new visitors
- Validates existing session cookies
- Validates HMAC signatures on mutating requests (when enforced)
- Injects session_id into request.state for downstream use

Security features:
- HttpOnly cookies prevent XSS access
- SameSite=Lax prevents most CSRF attacks
- Secure flag set for HTTPS connections
- HMAC signature validation prevents request tampering
"""

import hashlib
import hmac
import logging
from typing import Callable

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

from src.services.session import (
    Session,
    get_session_manager,
    is_signing_enforced,
)


logger = logging.getLogger(__name__)

# Cookie configuration
SESSION_COOKIE_NAME = "finlity_session"
SESSION_COOKIE_MAX_AGE = 7200  # 2 hours, matches session TTL

# Paths that don't require session (static files, health checks)
SKIP_SESSION_PATHS = frozenset(["/health", "/static", "/favicon.ico"])


class SessionMiddleware(BaseHTTPMiddleware):
    """
    Middleware that manages session lifecycle and request signing.

    Creates sessions for new visitors, validates existing sessions,
    and optionally validates HMAC signatures on mutating requests.
    """

    def __init__(self, app: ASGIApp, enforce_signing: bool = False):
        """
        Initialize session middleware.

        Args:
            app: The ASGI application
            enforce_signing: If True, require valid HMAC signature on
                             POST/PUT/DELETE requests. If False (or not set),
                             falls back to is_signing_enforced() which checks
                             environment variables.
        """
        super().__init__(app)
        self._enforce_signing = enforce_signing
        self.session_manager = get_session_manager()

    async def dispatch(self, request: Request, call_next: Callable):
        """Process request with session management."""
        path = request.url.path

        # Skip session handling for static files and health checks
        if any(path.startswith(skip) for skip in SKIP_SESSION_PATHS):
            return await call_next(request)

        # Get or create session
        session_id = request.cookies.get(SESSION_COOKIE_NAME)
        session, is_new_session = self.session_manager.get_or_create_session(session_id)

        # Validate HMAC signature if enforcement is enabled
        should_enforce = self._enforce_signing or is_signing_enforced()
        if should_enforce and request.method in ("POST", "PUT", "DELETE"):
            # Skip signing check for session init endpoint (chicken-and-egg)
            if path != "/api/session/init":
                validation_error = await self._validate_signature(request, session)
                if validation_error:
                    return validation_error

        # Inject session into request state for downstream use
        request.state.session = session
        request.state.session_id = session.id

        # Process request
        response = await call_next(request)

        # Set session cookie if new or needs refresh
        if is_new_session:
            response.set_cookie(
                key=SESSION_COOKIE_NAME,
                value=session.id,
                max_age=SESSION_COOKIE_MAX_AGE,
                httponly=True,
                samesite="lax",
                secure=request.url.scheme == "https",
                path="/",
            )

        return response

    async def _validate_signature(
        self, request: Request, session: Session
    ) -> JSONResponse | None:
        """
        Validate HMAC signature on mutating requests.

        Returns:
            JSONResponse with 401 if validation fails, None if valid
        """
        signature = request.headers.get("X-Request-Signature")
        timestamp = request.headers.get("X-Request-Timestamp")
        nonce = request.headers.get("X-Request-Nonce")
        body_hash = request.headers.get("X-Request-Body-Hash", "")

        # All three headers required
        if not all([signature, timestamp, nonce]):
            logger.warning(
                f"Missing signature headers for {request.method} {request.url.path}"
            )
            return JSONResponse(
                status_code=401,
                content={
                    "detail": "Request signature required",
                    "error_type": "signature_required",
                },
            )

        # Validate body hash if provided - prevents request body tampering
        if body_hash:
            body = await request.body()
            computed_hash = hashlib.sha256(body).hexdigest()
            if not hmac.compare_digest(body_hash, computed_hash):
                logger.warning(
                    f"Body hash mismatch for {request.method} {request.url.path}: "
                    f"claimed={body_hash[:16]}..., computed={computed_hash[:16]}..."
                )
                return JSONResponse(
                    status_code=401,
                    content={
                        "detail": "Request body hash mismatch",
                        "error_type": "body_hash_invalid",
                    },
                )

        # Validate signature
        if not self.session_manager.validate_signature(
            session=session,
            timestamp=timestamp,
            nonce=nonce,
            method=request.method,
            path=request.url.path,
            signature=signature,
            body_hash=body_hash,
        ):
            logger.warning(
                f"Invalid signature for {request.method} {request.url.path}"
            )
            return JSONResponse(
                status_code=401,
                content={
                    "detail": "Invalid request signature",
                    "error_type": "signature_invalid",
                },
            )

        return None


def get_session_id_from_request(request: Request) -> str | None:
    """
    Helper to get session_id from request state.

    Use this in API endpoints to get the current session.

    Example:
        @router.get("/tasks/{task_id}")
        async def get_task(task_id: str, request: Request):
            session_id = get_session_id_from_request(request)
            task = task_manager.get_task(task_id, session_id=session_id)
    """
    return getattr(request.state, "session_id", None)
