"""
API endpoints for background task management.

These endpoints allow clients to:
1. Check the status of a background task
2. Get the result when completed
3. List recent tasks
"""

from fastapi import APIRouter, HTTPException
from src.services.background_tasks import task_manager

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("/{task_id}")
async def get_task_status(task_id: str):
    """
    Get the status and result of a background task.

    Poll this endpoint to check if a long-running operation has completed.

    Returns:
        - status: pending | running | completed | failed
        - progress: 0.0 to 1.0
        - result: The task result (only when status=completed)
        - error: Error message (only when status=failed)
    """
    task = task_manager.get_task_dict(task_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
    return task


@router.get("")
async def list_tasks(limit: int = 20):
    """List recent background tasks."""
    return {"tasks": task_manager.list_tasks(limit=limit)}
