"""Stateless v2 commentary endpoint (F2).

Today local-mode frontend hits v1's GET /api/commentary/{id}/stream via
EventSource with the current page data serialized into the QUERY STRING
(no request body on EventSource/GET), and CommentaryService reads the
user's age/retirement age and the AI provider config from the server DB
even when the caller passes no_store=true.

This endpoint is the stateless v2 counterpart: a POST with a JSON body (so
financial data never rides in the URL/query string/server logs), the
Claude API key from the environment only, and a CommentaryService
constructed with no `db` at all — see the `db=None` / `claude_api_key` /
`portfolio_context` / `user_context` injection points added to
CommentaryService (src/services/commentary_service.py), mirroring how
AdvisorAnalysisService takes a `portfolio_context` override for its own
stateless v2 endpoints (src/api/v2/analysis.py).

Streams the exact same `data: {...}` chunk protocol as v1's stream endpoint
(cached/chunk/complete/error message types) so the existing frontend SSE
parser is reusable unchanged.
"""

import json
import os
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.services.commentary_registry import get_element_config

router = APIRouter(prefix="/api/v2/commentary", tags=["v2-commentary"])


def _get_env_claude_key() -> Optional[str]:
    """Claude API key from environment variables only (no app_settings table)."""
    return os.environ.get("ANTHROPIC_API_KEY") or None


class UserContextPayload(BaseModel):
    age: Optional[int] = None
    retirement_age: Optional[int] = None


class CommentaryStreamRequestV2(BaseModel):
    data: dict = {}
    user_context: Optional[UserContextPayload] = None


@router.post("/{element_id}/stream")
def stream_element_commentary_v2(
    element_id: str,
    request: CommentaryStreamRequestV2,
) -> StreamingResponse:
    """Stream AI commentary for a dashboard element from client-supplied
    data only. No DB access: no cache read, no cache write, no settings
    reads. User context (age/retirement_age) comes only from the request
    body and is omitted from the prompt entirely when absent — v1's
    DB-backed defaults (35/65) are never substituted in here.

    Streams the same `data: {...}` SSE chunk protocol as v1's
    GET /api/commentary/{element_id}/stream (cached/chunk/complete/error
    message types).
    """
    from src.services.commentary_service import CommentaryService

    config = get_element_config(element_id)
    if not config:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown element: {element_id}. Use GET /api/commentary/elements to see available elements.",
        )

    claude_key = _get_env_claude_key()

    user_context_dict = None
    if request.user_context:
        user_context_dict = request.user_context.model_dump(exclude_none=True)

    def error_stream(message: str) -> Any:
        yield f"data: {json.dumps({'error': message})}\n\n"

    if not claude_key:
        return StreamingResponse(
            error_stream(
                "Claude API key not configured. Set the ANTHROPIC_API_KEY "
                "environment variable to use commentary."
            ),
            media_type="text/event-stream",
        )

    service = CommentaryService(
        db=None,
        claude_api_key=claude_key,
        user_context=user_context_dict,
    )

    def event_generator() -> Any:
        yield from service.generate_commentary_streaming(
            element_id,
            current_data=request.data,
            no_store=True,  # no_store alone already skips the cache check
        )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
