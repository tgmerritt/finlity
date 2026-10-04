"""Connector tests never touch the network.

Name resolution and socket connects fail loudly unless a test installs its
own fake, so a request that slips past ``httpx.MockTransport`` cannot reach a
real host.
"""

from __future__ import annotations

import socket
from typing import Any

import pytest


def _no_network(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("a connector test tried to use the network")


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", _no_network)
    monkeypatch.setattr(socket, "create_connection", _no_network)
