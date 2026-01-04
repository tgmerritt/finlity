"""
API endpoints for background task management.

These endpoints allow clients to:
1. Check the status of a background task
2. Get the result when completed
3. List recent tasks

In multi-user mode, tasks are scoped to sessions - users can only see
their own tasks, not tasks from other sessions.
"""

from fastapi import APIRouter, HTTPException, Request

from src.services.background_tasks import task_manager

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def get_session_id(request: Request) -> str | None:
    """Get session ID from request state (set by SessionMiddleware)."""
    return getattr(request.state, "session_id", None)


@router.get("/{task_id}")
async def get_task_status(task_id: str, request: Request):
    """
    Get the status and result of a background task.

    Poll this endpoint to check if a long-running operation has completed.

    In multi-user mode, you can only access tasks from your own session.

    Returns:
        - status: pending | running | completed | failed
        - progress: 0.0 to 1.0
        - result: The task result (only when status=completed)
        - error: Error message (only when status=failed)
    """
    session_id = get_session_id(request)
    task = task_manager.get_task_dict(task_id, session_id=session_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return task


@router.get("")
async def list_tasks(limit: int = 20, request: Request = None):
    """
    List recent background tasks.

    In multi-user mode, only returns tasks from your session.
    """
    session_id = get_session_id(request) if request else None
    return {"tasks": task_manager.list_tasks(limit=limit, session_id=session_id)}
