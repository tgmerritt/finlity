"""Connector errors (design 5.3). Messages are fixed strings, never provider
content, URLs, hostnames, tokens or exception text."""

from __future__ import annotations

from ..smart_import.errors import ERROR_CATALOG, SmartImportError

# error_type -> (HTTP status, fixed detail).
CONNECTOR_ERRORS: dict[str, tuple[int, str]] = {
    "bad_setup_token": (422, "This does not look like a SimpleFIN setup token."),
    "claim_refused": (
        422,
        "This setup token was already used or is not valid. If you did not use "
        "it, disable it at SimpleFIN Bridge.",
    ),
    "host_not_allowed": (422, "This connection address is not allowed."),
    "reconnect_needed": (
        409,
        "The provider no longer accepts this connection. Reconnect to continue.",
    ),
    "payment_required": (
        409,
        "The provider reports that the subscription needs attention.",
    ),
    "provider_rate_limited": (
        429,
        "The provider asked for fewer requests. Try again tomorrow.",
    ),
    "quota_reached": (
        429,
        "This connection has reached its daily sync limit. Try again tomorrow.",
    ),
    "window_too_long": (
        422,
        "The sync period is longer than 90 days or ends in the future.",
    ),
    "provider_timeout": (504, "The provider took too long to respond."),
    "response_too_large": (502, "The provider sent more data than the limit allows."),
    "provider_bad_response": (502, "The provider returned an unusable response."),
    "provider_unavailable": (502, "The provider could not be reached."),
    "connector_disabled": (503, "This connection type is not enabled here."),
    "connections_unavailable": (
        403,
        "Connected accounts are not available on this deployment.",
    ),
    "connection_not_found": (404, "Connection not found."),
    "connection_limit": (
        422,
        "This profile already has the maximum of 10 connections. Disconnect one first.",
    ),
    "claim_not_saved": (
        500,
        "Your setup token was used but the connection could not be saved. Create a "
        "new setup token in SimpleFIN and try again.",
    ),
    "claim_timeout": (
        504,
        "The setup token may have been used. If connecting again fails, create a "
        "new one.",
    ),
    "request_time_short": (
        503,
        "Not enough time was left to contact the provider. Try again.",
    ),
}


class ConnectorError(SmartImportError):
    """A SmartImportError with a connector code, so SmartImportRoute renders it.

    Codes come from CONNECTOR_ERRORS, then from the smart import catalog (for
    shared codes such as ``bad_request``). An unknown code is a programming
    error and raises ValueError rather than inventing a message.
    """

    def __init__(self, error_type: str):
        entry = CONNECTOR_ERRORS.get(error_type) or ERROR_CATALOG.get(error_type)
        if entry is None:
            raise ValueError("unknown connector error type")
        status, detail = entry
        super().__init__(error_type, status=status, detail=detail)
