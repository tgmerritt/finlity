"""
Session management for multi-user deployments.

Sessions provide isolation for:
- Background task results (Monte Carlo, performance analysis, etc.)
- Request signing validation (HMAC)
- Temporary state that should not leak between users

Sessions do NOT provide:
- User authentication (users remain anonymous)
- Database isolation (handled separately by demo mode / profiles)

Usage:
    # Get or create session in middleware
    session = get_session_manager().get_or_create_session(session_id)

    # Check if multi-user mode is enabled
    if is_multi_user_mode():
        # Enforce session isolation
"""

import hashlib
import hmac
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Optional
from uuid import uuid4


@dataclass
class Session:
    """Represents a browser session."""

    id: str
    created_at: datetime
    last_accessed: datetime
    hmac_key: str  # Per-session key for request signing
    metadata: dict = field(default_factory=dict)
    used_nonces: set = field(default_factory=set)  # Track nonces to prevent replay


class SessionManager:
    """
    In-memory session manager with automatic cleanup.

    Design decisions:
    - In-memory for simplicity (no Redis needed for demo/small scale)
    - Automatic cleanup of expired sessions
    - Thread-safe operations
    - Configurable TTL (default 2 hours)
    """

    DEFAULT_TTL_SECONDS = 7200  # 2 hours
    CLEANUP_INTERVAL_SECONDS = 300  # 5 minutes
    MAX_SESSIONS = 10000  # Prevent memory exhaustion

    def __init__(self, ttl_seconds: Optional[int] = None):
        self._sessions: Dict[str, Session] = {}
        self._lock = threading.Lock()
        self._ttl = ttl_seconds or int(
            os.environ.get("SESSION_TTL_SECONDS", self.DEFAULT_TTL_SECONDS)
        )
        self._last_cleanup = time.time()

    def create_session(self) -> Session:
        """Create a new session with unique ID and HMAC key."""
        session = Session(
            id=str(uuid4()),
            created_at=datetime.utcnow(),
            last_accessed=datetime.utcnow(),
            hmac_key=secrets.token_hex(32),  # 256-bit key
        )

        with self._lock:
            self._cleanup_if_needed()
            self._sessions[session.id] = session

        return session

    def get_session(self, session_id: str) -> Optional[Session]:
        """Get session by ID, updating last_accessed if found."""
        if not session_id:
            return None

        with self._lock:
            session = self._sessions.get(session_id)
            if session:
                # Check expiration
                if self._is_expired(session):
                    del self._sessions[session_id]
                    return None
                session.last_accessed = datetime.utcnow()
            return session

    def get_or_create_session(self, session_id: Optional[str]) -> tuple[Session, bool]:
        """
        Get existing session or create a new one.

        Returns:
            tuple of (session, is_new) where is_new indicates if session was created
        """
        if session_id:
            session = self.get_session(session_id)
            if session:
                return session, False

        return self.create_session(), True

    def _is_expired(self, session: Session) -> bool:
        """Check if session has expired."""
        age = (datetime.utcnow() - session.last_accessed).total_seconds()
        return age > self._ttl

    def _cleanup_if_needed(self):
        """Remove expired sessions periodically. Must be called with lock held."""
        now = time.time()
        if now - self._last_cleanup < self.CLEANUP_INTERVAL_SECONDS:
            return

        self._last_cleanup = now
        expired = [
            sid for sid, session in self._sessions.items() if self._is_expired(session)
        ]
        for sid in expired:
            del self._sessions[sid]

        # Evict oldest if over limit
        if len(self._sessions) > self.MAX_SESSIONS:
            sorted_sessions = sorted(
                self._sessions.items(), key=lambda x: x[1].last_accessed
            )
            to_remove = len(self._sessions) - self.MAX_SESSIONS
            for sid, _ in sorted_sessions[:to_remove]:
                del self._sessions[sid]

    def validate_signature(
        self,
        session: Session,
        timestamp: str,
        nonce: str,
        method: str,
        path: str,
        signature: str,
    ) -> bool:
        """
        Validate HMAC signature on a request.

        The signature is computed as:
            HMAC-SHA256(key, "{timestamp}:{nonce}:{method}:{path}")

        Args:
            session: The session containing the HMAC key
            timestamp: Unix timestamp from X-Request-Timestamp header
            nonce: Random nonce from X-Request-Nonce header
            method: HTTP method (GET, POST, etc.)
            path: Request path (e.g., /api/portfolio/accounts)
            signature: Hex-encoded signature from X-Request-Signature header

        Returns:
            True if signature is valid, False otherwise
        """
        # Validate timestamp freshness (5 minute window)
        try:
            ts = int(timestamp)
            if abs(time.time() - ts) > 300:
                return False
        except (ValueError, TypeError):
            return False

        # Check for nonce reuse (replay attack prevention)
        nonce_key = f"{timestamp}:{nonce}"
        with self._lock:
            if nonce_key in session.used_nonces:
                return False
            # Clean old nonces (older than 5 min) to prevent memory growth
            # Since timestamp is already validated, we only need to track recent nonces
            session.used_nonces.add(nonce_key)

        # Compute expected signature
        message = f"{timestamp}:{nonce}:{method}:{path}"
        expected = hmac.new(
            session.hmac_key.encode(), message.encode(), hashlib.sha256
        ).hexdigest()

        return hmac.compare_digest(signature, expected)

    def session_count(self) -> int:
        """Get current number of active sessions."""
        with self._lock:
            return len(self._sessions)


# Global singleton
_session_manager: Optional[SessionManager] = None
_session_manager_lock = threading.Lock()


def get_session_manager() -> SessionManager:
    """Get the global SessionManager instance."""
    global _session_manager
    if _session_manager is None:
        with _session_manager_lock:
            if _session_manager is None:
                _session_manager = SessionManager()
    return _session_manager


def is_multi_user_mode() -> bool:
    """
    Check if running in multi-user mode.

    Multi-user mode is enabled when:
    - MULTI_USER_MODE=true is set, OR
    - Running on Heroku (DYNO env var exists), OR
    - PROTECT_DEMO_DATA=true is set

    In single-user mode (local Docker), session isolation is relaxed.
    """
    if os.environ.get("MULTI_USER_MODE", "").lower() in ("true", "1", "yes"):
        return True
    if os.environ.get("DYNO"):  # Heroku sets this
        return True
    if os.environ.get("PROTECT_DEMO_DATA", "").lower() in ("true", "1", "yes"):
        return True
    return False


def is_signing_enforced() -> bool:
    """
    Check if request signing should be enforced.

    Signing is enforced when:
    - ENFORCE_REQUEST_SIGNING=true is explicitly set, OR
    - Running in multi-user mode (Heroku/DYNO, etc.)
    """
    explicit = os.environ.get("ENFORCE_REQUEST_SIGNING", "").lower()
    if explicit in ("true", "1", "yes"):
        return True
    if explicit in ("false", "0", "no"):
        return False
    # Default: enforce in multi-user mode
    return is_multi_user_mode()
