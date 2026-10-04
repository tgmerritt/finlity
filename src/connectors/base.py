"""The provider protocol (design 5.1).

Providers take the HTTP client as an argument. It is typed here as the small
``ProviderClient`` protocol that ``http.SafeClient`` satisfies, so providers
cannot reach anything but the allowlisted client and tests can pass a fake.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from typing import Any, Protocol

from .types import AccountRequest, AccountsResult, Credentials, FetchResult


class ProviderClient(Protocol):
    def get_json(
        self,
        url: str,
        *,
        auth: tuple[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        params: Any = None,
    ) -> Any: ...

    def post_text(self, url: str) -> str: ...

    def seconds_left(self) -> float | None:
        """Time left before the call's overall deadline; None when unbounded."""
        ...


class ConnectorProvider(Protocol):
    id: str  # "simplefin" | "akahu" | "demo"
    display_name: str
    max_window_days: int
    daily_request_budget: int | None  # None: unlimited (demo)

    def claim(self, client: ProviderClient, setup: str) -> Credentials: ...

    def list_accounts(
        self, client: ProviderClient, creds: Credentials
    ) -> AccountsResult: ...

    def fetch(
        self,
        client: ProviderClient,
        creds: Credentials,
        accounts: list[AccountRequest],
        start: date,
        end: date,
    ) -> FetchResult: ...
