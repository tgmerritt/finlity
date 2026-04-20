"""Tests for BackgroundTaskManager cleanup behavior."""

import time
from datetime import datetime, timedelta

from src.services.background_tasks import (
    BackgroundTaskManager,
    Task,
    TaskStatus,
)


def _wait_for_status(
    mgr: BackgroundTaskManager, task_id: str, status: TaskStatus, timeout: float = 2.0
) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = mgr.get_task(task_id)
        if task and task.status == status:
            return
        time.sleep(0.01)
    raise AssertionError(f"task {task_id} did not reach {status} within {timeout}s")


def test_cleanup_removes_aged_out_tasks() -> None:
    mgr = BackgroundTaskManager(
        max_completed_tasks=100,
        max_task_age=timedelta(seconds=1),
    )

    # Seed a completed task that is already "old".
    old_task = Task(
        id="old",
        status=TaskStatus.COMPLETED,
        created_at=datetime.utcnow() - timedelta(hours=2),
        completed_at=datetime.utcnow() - timedelta(hours=2),
    )
    mgr._tasks["old"] = old_task

    # Seed a recent completed task.
    recent_task = Task(
        id="recent",
        status=TaskStatus.COMPLETED,
        created_at=datetime.utcnow(),
        completed_at=datetime.utcnow(),
    )
    mgr._tasks["recent"] = recent_task

    mgr._cleanup_old_tasks()

    assert "old" not in mgr._tasks
    assert "recent" in mgr._tasks


def test_cleanup_enforces_count_cap() -> None:
    mgr = BackgroundTaskManager(
        max_completed_tasks=2,
        max_task_age=timedelta(hours=24),
    )
    base = datetime.utcnow()
    for i in range(5):
        mgr._tasks[f"t{i}"] = Task(
            id=f"t{i}",
            status=TaskStatus.COMPLETED,
            created_at=base + timedelta(seconds=i),
            completed_at=base + timedelta(seconds=i),
        )

    mgr._cleanup_old_tasks()

    assert len(mgr._tasks) == 2
    # Most recent two are kept.
    assert "t3" in mgr._tasks
    assert "t4" in mgr._tasks


def test_submit_runs_function_in_background() -> None:
    mgr = BackgroundTaskManager()
    task_id = mgr.submit(lambda x: x * 2, 21)
    _wait_for_status(mgr, task_id, TaskStatus.COMPLETED)
    task = mgr.get_task(task_id)
    assert task is not None
    assert task.result == 42
