"""
Tests for session management and multi-user security features.
"""

import hmac
import hashlib
import time


class TestSessionManager:
    """Test session management service."""

    def test_session_manager_import(self):
        """Test that session manager can be imported."""
        from src.services.session import SessionManager
        manager = SessionManager()
        assert manager is not None

    def test_create_session(self):
        """Test creating a new session."""
        from src.services.session import SessionManager
        manager = SessionManager()

        session = manager.create_session()

        assert session is not None
        assert session.id is not None
        assert len(session.id) == 36  # UUID format
        assert session.hmac_key is not None
        assert len(session.hmac_key) == 64  # SHA-256 hex

    def test_get_session(self):
        """Test retrieving an existing session."""
        from src.services.session import SessionManager
        manager = SessionManager()

        session = manager.create_session()
        session_id = session.id

        retrieved = manager.get_session(session_id)

        assert retrieved is not None
        assert retrieved.id == session_id
        assert retrieved.hmac_key == session.hmac_key

    def test_get_nonexistent_session(self):
        """Test retrieving a non-existent session returns None."""
        from src.services.session import SessionManager
        manager = SessionManager()

        result = manager.get_session("nonexistent-session-id")
        assert result is None

    def test_session_expiration_logic(self):
        """Test session expiration logic without waiting."""
        from src.services.session import SessionManager
        from datetime import datetime, timedelta

        manager = SessionManager(ttl_seconds=60)
        session = manager.create_session()

        # Manually set last_accessed to be in the past
        session.last_accessed = datetime.utcnow() - timedelta(seconds=120)

        # Session should be considered expired
        assert manager._is_expired(session) is True

        # Fresh session should not be expired
        session.last_accessed = datetime.utcnow()
        assert manager._is_expired(session) is False

    def test_validate_signature_success(self):
        """Test successful signature validation."""
        from src.services.session import SessionManager
        manager = SessionManager()

        session = manager.create_session()
        timestamp = int(time.time())
        nonce = "test-nonce-12345"
        method = "POST"
        path = "/api/portfolio/accounts"
        body_hash = ""

        message = f"{timestamp}:{nonce}:{method}:{path}:{body_hash}"
        signature = hmac.new(
            session.hmac_key.encode(),
            message.encode(),
            hashlib.sha256
        ).hexdigest()

        is_valid = manager.validate_signature(
            session, timestamp, nonce, method, path, signature
        )
        assert is_valid is True

    def test_validate_signature_wrong_key(self):
        """Test signature validation fails with wrong key."""
        from src.services.session import SessionManager
        manager = SessionManager()

        session = manager.create_session()
        timestamp = int(time.time())
        nonce = "test-nonce-wrong-key"
        method = "POST"
        path = "/api/portfolio/accounts"
        body_hash = ""

        message = f"{timestamp}:{nonce}:{method}:{path}:{body_hash}"
        signature = hmac.new(
            b"wrong-key",
            message.encode(),
            hashlib.sha256
        ).hexdigest()

        is_valid = manager.validate_signature(
            session, timestamp, nonce, method, path, signature
        )
        assert is_valid is False

    def test_validate_signature_expired_timestamp(self):
        """Test signature validation fails with expired timestamp."""
        from src.services.session import SessionManager
        manager = SessionManager()

        session = manager.create_session()
        # Timestamp from 10 minutes ago (beyond 5 min window)
        timestamp = int(time.time()) - 600
        nonce = "test-nonce-expired"
        method = "POST"
        path = "/api/portfolio/accounts"
        body_hash = ""

        message = f"{timestamp}:{nonce}:{method}:{path}:{body_hash}"
        signature = hmac.new(
            session.hmac_key.encode(),
            message.encode(),
            hashlib.sha256
        ).hexdigest()

        is_valid = manager.validate_signature(
            session, timestamp, nonce, method, path, signature
        )
        assert is_valid is False

    def test_validate_signature_replay_attack(self):
        """Test that nonces can only be used once."""
        from src.services.session import SessionManager
        manager = SessionManager()

        session = manager.create_session()
        timestamp = int(time.time())
        nonce = "unique-nonce-replay-test"
        method = "POST"
        path = "/api/portfolio/accounts"
        body_hash = ""

        message = f"{timestamp}:{nonce}:{method}:{path}:{body_hash}"
        signature = hmac.new(
            session.hmac_key.encode(),
            message.encode(),
            hashlib.sha256
        ).hexdigest()

        # First use should succeed
        is_valid = manager.validate_signature(
            session, timestamp, nonce, method, path, signature
        )
        assert is_valid is True

        # Replay should fail
        is_valid = manager.validate_signature(
            session, timestamp, nonce, method, path, signature
        )
        assert is_valid is False


class TestMultiUserMode:
    """Test multi-user mode detection."""

    def test_is_multi_user_mode_default(self):
        """Test default multi-user mode is off."""
        import os
        from src.services.session import is_multi_user_mode

        # Save current env vars
        saved = {
            k: os.environ.pop(k, None)
            for k in ["DYNO", "MULTI_USER_MODE", "PROTECT_DEMO_DATA"]
        }

        try:
            assert is_multi_user_mode() is False
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    def test_is_multi_user_mode_explicit(self):
        """Test explicit multi-user mode setting."""
        import os
        from src.services.session import is_multi_user_mode

        saved = os.environ.get("MULTI_USER_MODE")
        try:
            os.environ["MULTI_USER_MODE"] = "true"
            assert is_multi_user_mode() is True
        finally:
            if saved:
                os.environ["MULTI_USER_MODE"] = saved
            else:
                os.environ.pop("MULTI_USER_MODE", None)


class TestBackgroundTaskIsolation:
    """Test background task session isolation."""

    def test_task_manager_import(self):
        """Test background task manager import."""
        from src.services.background_tasks import BackgroundTaskManager
        manager = BackgroundTaskManager()
        assert manager is not None

    def test_task_dataclass_has_session_id(self):
        """Test Task dataclass has session_id field."""
        from src.services.background_tasks import Task, TaskStatus
        from datetime import datetime

        task = Task(
            id="test-123",
            status=TaskStatus.PENDING,
            created_at=datetime.utcnow(),
            session_id="session-abc"
        )
        assert task.session_id == "session-abc"

    def test_task_session_isolation_logic(self):
        """Test session isolation logic in get_task."""
        from src.services.background_tasks import Task, TaskStatus, BackgroundTaskManager
        from datetime import datetime

        manager = BackgroundTaskManager()

        # Manually add a task with session
        task = Task(
            id="test-task-1",
            status=TaskStatus.COMPLETED,
            created_at=datetime.utcnow(),
            session_id="session-owner"
        )
        manager._tasks["test-task-1"] = task

        # Same session can see task
        result = manager.get_task("test-task-1", session_id="session-owner")
        assert result is not None

        # Different session cannot see task
        result = manager.get_task("test-task-1", session_id="session-other")
        assert result is None

        # No session filter = can see all (local mode)
        result = manager.get_task("test-task-1", session_id=None)
        assert result is not None

    def test_list_tasks_session_filter(self):
        """Test listing tasks with session filter."""
        from src.services.background_tasks import Task, TaskStatus, BackgroundTaskManager
        from datetime import datetime

        manager = BackgroundTaskManager()

        # Manually add tasks for different sessions
        manager._tasks["task-1"] = Task(
            id="task-1",
            status=TaskStatus.COMPLETED,
            created_at=datetime.utcnow(),
            session_id="session-A"
        )
        manager._tasks["task-2"] = Task(
            id="task-2",
            status=TaskStatus.COMPLETED,
            created_at=datetime.utcnow(),
            session_id="session-A"
        )
        manager._tasks["task-3"] = Task(
            id="task-3",
            status=TaskStatus.COMPLETED,
            created_at=datetime.utcnow(),
            session_id="session-B"
        )

        # Session A should see 2 tasks
        tasks_a = manager.list_tasks(session_id="session-A")
        assert len([t for t in tasks_a if t]) == 2

        # Session B should see 1 task
        tasks_b = manager.list_tasks(session_id="session-B")
        assert len([t for t in tasks_b if t]) == 1

        # No filter = all tasks
        all_tasks = manager.list_tasks(session_id=None)
        assert len([t for t in all_tasks if t]) == 3
