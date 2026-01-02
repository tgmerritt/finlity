"""
Background task manager for long-running operations.

This module provides a simple in-memory task queue that allows long-running
operations (like Monte Carlo simulations) to run in background threads.
This is essential for platforms like Heroku that have 30-second request timeouts.

Usage:
    # In your API endpoint
    task_id = task_manager.submit(my_function, arg1, arg2, kwarg1=value)
    return {"task_id": task_id}

    # Client polls GET /api/tasks/{task_id}
    # Returns: {"status": "completed", "result": {...}}
"""

import threading
import uuid
import traceback
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Optional
from enum import Enum


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Task:
    id: str
    status: TaskStatus
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    result: Any = None
    error: Optional[str] = None
    progress: float = 0.0  # 0.0 to 1.0
    progress_message: Optional[str] = None


class BackgroundTaskManager:
    """
    Simple in-memory background task manager.

    Note: Tasks are lost on dyno/server restart. For a production system
    with multiple dynos, you'd want Redis + a worker dyno instead.
    """

    def __init__(self, max_completed_tasks: int = 100):
        self._tasks: Dict[str, Task] = {}
        self._lock = threading.Lock()
        self._max_completed = max_completed_tasks

    def submit(
        self,
        func: Callable,
        *args,
        task_id: Optional[str] = None,
        **kwargs
    ) -> str:
        """
        Submit a function to run in the background.

        Args:
            func: The function to run
            *args: Positional arguments for the function
            task_id: Optional custom task ID (auto-generated if not provided)
            **kwargs: Keyword arguments for the function

        Returns:
            task_id: Use this to poll for results
        """
        if task_id is None:
            task_id = str(uuid.uuid4())

        task = Task(
            id=task_id,
            status=TaskStatus.PENDING,
            created_at=datetime.utcnow()
        )

        with self._lock:
            self._tasks[task_id] = task
            self._cleanup_old_tasks()

        # Start background thread
        thread = threading.Thread(
            target=self._run_task,
            args=(task_id, func, args, kwargs),
            daemon=True
        )
        thread.start()

        return task_id

    def _run_task(
        self,
        task_id: str,
        func: Callable,
        args: tuple,
        kwargs: dict
    ):
        """Execute the task in the background thread."""
        with self._lock:
            task = self._tasks.get(task_id)
            if task:
                task.status = TaskStatus.RUNNING
                task.started_at = datetime.utcnow()

        try:
            # If the function accepts a progress_callback, provide one
            if 'progress_callback' in func.__code__.co_varnames:
                kwargs['progress_callback'] = lambda p, msg=None: self.update_progress(task_id, p, msg)

            result = func(*args, **kwargs)

            with self._lock:
                task = self._tasks.get(task_id)
                if task:
                    task.status = TaskStatus.COMPLETED
                    task.completed_at = datetime.utcnow()
                    task.result = result
                    task.progress = 1.0

        except Exception as e:
            with self._lock:
                task = self._tasks.get(task_id)
                if task:
                    task.status = TaskStatus.FAILED
                    task.completed_at = datetime.utcnow()
                    task.error = f"{type(e).__name__}: {str(e)}\n{traceback.format_exc()}"

    def update_progress(self, task_id: str, progress: float, message: Optional[str] = None):
        """Update task progress (called from within the task function)."""
        with self._lock:
            task = self._tasks.get(task_id)
            if task:
                task.progress = min(max(progress, 0.0), 1.0)
                if message:
                    task.progress_message = message

    def get_task(self, task_id: str) -> Optional[Task]:
        """Get task status and result."""
        with self._lock:
            return self._tasks.get(task_id)

    def get_task_dict(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Get task as a dictionary (for JSON response)."""
        task = self.get_task(task_id)
        if not task:
            return None

        result = {
            "task_id": task.id,
            "status": task.status.value,
            "progress": task.progress,
            "progress_message": task.progress_message,
            "created_at": task.created_at.isoformat() if task.created_at else None,
            "started_at": task.started_at.isoformat() if task.started_at else None,
            "completed_at": task.completed_at.isoformat() if task.completed_at else None,
        }

        if task.status == TaskStatus.COMPLETED:
            result["result"] = task.result
        elif task.status == TaskStatus.FAILED:
            result["error"] = task.error

        return result

    def _cleanup_old_tasks(self):
        """Remove old completed/failed tasks to prevent memory buildup."""
        completed = [
            (t.completed_at, tid)
            for tid, t in self._tasks.items()
            if t.status in (TaskStatus.COMPLETED, TaskStatus.FAILED) and t.completed_at
        ]

        if len(completed) > self._max_completed:
            # Sort by completion time, remove oldest
            completed.sort()
            to_remove = completed[:-self._max_completed]
            for _, tid in to_remove:
                del self._tasks[tid]

    def list_tasks(self, limit: int = 20) -> list:
        """List recent tasks."""
        with self._lock:
            tasks = sorted(
                self._tasks.values(),
                key=lambda t: t.created_at,
                reverse=True
            )[:limit]
            return [self.get_task_dict(t.id) for t in tasks]


# Global instance
task_manager = BackgroundTaskManager()
