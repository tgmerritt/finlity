"""Server-mode connection routes (design 6.2; plan B2).

The service (``src/connectors/service.py``) does the work; these routes
validate bodies, refuse shared deployments and protect the demo.

* Every route refuses a shared deployment (``DYNO``, ``MULTI_USER_MODE`` or
  ``PROTECT_DEMO_DATA``) with 403 ``connections_unavailable`` before the body
  is read: hosted visitors keep connections in their browser (LocalAPI).
* Every write calls ``check_demo_data_protection()`` first.
* Error bodies are ``{error_type, detail}`` with a fixed message
  (``SmartImportRoute``); a validation error is ``bad_request`` with no echo.
* Credentials go in (create, reconnect) and never come out.
* Static paths are declared before the ``{connection_id}`` routes.
* ``DELETE /{id}`` disconnects; ``?remove_data=true`` also undoes every
  import of the connection in the same transaction (plan B4).

Provider calls reuse the v2 transport factory dependency, so one test
override covers both route families.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from src.api.dependencies import get_db
from src.api.v2.connectors import TransportFactory, transport_factory
from src.api.v2.smart_import import SmartImportRoute
from src.connectors import service
from src.connectors.env import shared_deployment
from src.connectors.errors import ConnectorError
from src.database import Database
from src.smart_import import service as smart_import_service
from src.smart_import.types import ACCOUNT_KINDS

logger = logging.getLogger(__name__)


class ConnectionsRoute(SmartImportRoute):
    """``SmartImportRoute`` that refuses a shared deployment first, before
    the body is parsed or validated."""

    def get_route_handler(
        self,
    ) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        inner = super().get_route_handler()

        async def handler(request: Request) -> Response:
            if shared_deployment():
                exc = ConnectorError("connections_unavailable")
                return JSONResponse(status_code=exc.status, content=exc.body())
            return await inner(request)

        return handler


router = APIRouter(
    prefix="/api/connections",
    tags=["connections"],
    route_class=ConnectionsRoute,
)


def check_demo_mode_write() -> None:
    """Refuse writes on the protected hosted demo (centralised check)."""
    from src.services.demo_mode import check_demo_data_protection

    check_demo_data_protection()


# --- bodies -----------------------------------------------------------------------

Label = Annotated[
    str, Field(min_length=1, max_length=120, pattern=r"^[^\x00-\x1f\x7f]+$")
]
FirstSyncDays = Literal[30, 60, 90]
Secret = Annotated[str, Field(min_length=1, max_length=4096)]
Token = Annotated[str, Field(min_length=1, max_length=512)]
AccountId = Annotated[str, Field(min_length=1, max_length=200)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CredentialsRequest(_Strict):
    """SimpleFIN: ``setup_token`` or ``access_url``. Akahu: ``user_token``
    and ``app_token``. Demo: nothing."""

    setup_token: Optional[Secret] = None
    access_url: Optional[Secret] = None
    user_token: Optional[Token] = None
    app_token: Optional[Token] = None


class CreateConnectionRequest(CredentialsRequest):
    provider: Literal["simplefin", "akahu", "demo"]
    label: Optional[Label] = None
    first_sync_days: Optional[FirstSyncDays] = None


class AccountUpdate(_Strict):
    kind: Optional[Literal[ACCOUNT_KINDS]] = None  # type: ignore[valid-type]
    role: Optional[Literal["debt", "cash_flow", "ignore"]] = None
    label: Optional[Label] = None
    liability_id: Optional[str] = Field(default=None, min_length=1, max_length=64)
    flip_balance: Optional[StrictBool] = None
    same_as_key: Optional[str] = Field(default=None, min_length=1, max_length=196)


class UpdateConnectionRequest(_Strict):
    label: Optional[Label] = None
    first_sync_days: Optional[FirstSyncDays] = None
    accounts: Optional[dict[AccountId, AccountUpdate]] = Field(default=None, max_length=50)


class SyncConnectionRequest(_Strict):
    window_index: int = Field(default=0, ge=0, le=3, strict=True)


def _sent(model: BaseModel) -> dict[str, Any]:
    """Only the fields the caller sent (``null`` included), nested."""
    return model.model_dump(exclude_unset=True)


# --- routes -----------------------------------------------------------------------
# Plain ``def`` handlers run in the threadpool; provider calls block there.


@router.get("")
def list_connections(db: Database = Depends(get_db)) -> list[dict[str, Any]]:
    """Every connection as a summary. Never a secret."""
    return service.list_connections(db)


@router.post("")
def create_connection(
    body: CreateConnectionRequest,
    db: Database = Depends(get_db),
    factory: TransportFactory = Depends(transport_factory),
) -> dict[str, Any]:
    """Claim or take the credential, store it encrypted, list accounts."""
    check_demo_mode_write()
    return service.create_connection(db, body.model_dump(), factory)


@router.get("/{connection_id}")
def get_connection(connection_id: str, db: Database = Depends(get_db)) -> dict[str, Any]:
    """Accounts with mapping and ``next_since``, windows, status and quota."""
    return service.get_connection(db, connection_id)


@router.put("/{connection_id}")
def update_connection(
    connection_id: str,
    body: UpdateConnectionRequest,
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    # CSRF posture: PUT is a non-simple method, so browsers preflight it against the CORS allowlist.
    check_demo_mode_write()
    return service.update_connection(db, connection_id, _sent(body))


@router.post("/{connection_id}/credentials")
def replace_credentials(
    connection_id: str,
    body: CredentialsRequest,
    db: Database = Depends(get_db),
    factory: TransportFactory = Depends(transport_factory),
) -> dict[str, Any]:
    """Reconnect: a new credential for the same id and mapping."""
    check_demo_mode_write()
    return service.replace_credentials(db, connection_id, body.model_dump(), factory)


@router.post("/{connection_id}/accounts")
def refresh_accounts(
    connection_id: str,
    db: Database = Depends(get_db),
    factory: TransportFactory = Depends(transport_factory),
) -> dict[str, Any]:
    """Reload the provider's account list (finishes an ``accounts_pending``
    connection)."""
    check_demo_mode_write()
    return service.refresh_accounts(db, connection_id, factory)


@router.post("/{connection_id}/sync")
def sync_connection(
    connection_id: str,
    body: Optional[SyncConnectionRequest] = None,
    db: Database = Depends(get_db),
    factory: TransportFactory = Depends(transport_factory),
) -> dict[str, Any]:
    """Fetch one window of the plan and return statements for the wizard.
    Nothing is applied here."""
    check_demo_mode_write()
    window_index = body.window_index if body is not None else 0
    context = smart_import_service.get_context(db)
    return service.sync_connection(
        db,
        connection_id,
        window_index,
        {"rules": context["rules"], "categories": context["categories"]},
        factory,
    )


@router.delete("/{connection_id}")
def delete_connection(
    connection_id: str,
    remove_data: Literal["true", "false"] = "false",
    db: Database = Depends(get_db),
) -> dict[str, Any]:
    """Disconnect: remove the metadata and the secret in one transaction.
    ``remove_data=true`` (exactly ``true`` or ``false``, so the browser twin
    accepts the same two values) also undoes every import of the connection,
    newest first; any failure rolls all of it back."""
    check_demo_mode_write()
    return service.delete_connection(db, connection_id, remove_data == "true")
