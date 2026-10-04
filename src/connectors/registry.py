"""Provider registry and deployment gating (design 5.1, C8, E8 as revised
after the A1/A2 review: the opt-in is needed on any shared deployment)."""

from __future__ import annotations

from collections.abc import Callable

from .base import ConnectorProvider
from .env import connectors_enabled_flag, shared_deployment
from .errors import ConnectorError

# Every provider id the API accepts, in display order.
PROVIDER_IDS: tuple[str, ...] = ("simplefin", "akahu", "demo")
# Providers that need no operator opt-in anywhere.
ALWAYS_ON: frozenset[str] = frozenset({"demo"})


def _simplefin() -> ConnectorProvider:
    # Imported here: simplefin imports http, which imports this module.
    from .simplefin import SimpleFinProvider

    return SimpleFinProvider()


def _akahu() -> ConnectorProvider:
    # Imported here for the same reason as _simplefin.
    from .akahu import AkahuProvider

    return AkahuProvider()


def _demo() -> ConnectorProvider:
    from .demo import DemoProvider

    return DemoProvider()


# id -> zero-argument factory. Each provider task adds its entry here.
_FACTORIES: dict[str, Callable[[], ConnectorProvider]] = {
    "simplefin": _simplefin,
    "akahu": _akahu,
    "demo": _demo,
}


def real_providers_opted_in() -> bool:
    """E8 for real providers: always on a single-user server, and only with
    ``CONNECTORS_ENABLED=true`` on a shared deployment.

    The v2 routes add one more condition on Heroku (an active rate limiter,
    ``src.api.v2.connectors.real_connectors_allowed``); it lives there because
    this stateless core must not import ``src.services``.
    """
    return not shared_deployment() or connectors_enabled_flag()


def enabled_providers() -> list[str]:
    """Provider ids usable on this deployment, read from the environment now.

    A single-user server enables all. On any shared deployment (Heroku
    ``DYNO``, ``MULTI_USER_MODE`` or ``PROTECT_DEMO_DATA``, see
    ``env.shared_deployment``) real providers need ``CONNECTORS_ENABLED=true``,
    because the operator's server would carry visitors' tokens. The demo
    provider is always on.
    """
    real_allowed = real_providers_opted_in()
    return [p for p in PROVIDER_IDS if p in ALWAYS_ON or real_allowed]


def is_enabled(provider_id: str) -> bool:
    return provider_id in enabled_providers()


def get_provider(provider_id: str) -> ConnectorProvider:
    """The provider for an id; an unknown id is ``bad_request``.

    Gating is the caller's concern (``is_enabled``), so tests and the data
    layer can build a provider without consulting the environment.
    """
    if not isinstance(provider_id, str):
        raise ConnectorError("bad_request")
    factory = _FACTORIES.get(provider_id)
    if factory is None:
        raise ConnectorError("bad_request")
    return factory()
