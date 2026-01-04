"""Factory functions for inference providers.

This module provides the main entry point for getting inference providers.
It initializes the built-in providers and registers them with the global registry.
"""

import logging
from typing import Optional

from src.services.providers import (
    InferenceProvider,
    InferenceProviderError,
    ProviderNotConfiguredError,
    ProviderRegistry,
    get_registry,
)
from src.services.providers.cerebras_provider import CerebrasProvider
from src.services.providers.claude_provider import ClaudeProvider
from src.services.providers.openai_provider import OpenAIProvider

logger = logging.getLogger(__name__)

# Track if providers have been initialized
_providers_initialized = False


def init_providers(db=None) -> ProviderRegistry:
    """Initialize and register all built-in providers and plugin providers.

    This should be called once at application startup.

    Args:
        db: Optional database connection for secrets lookup

    Returns:
        The global ProviderRegistry instance
    """
    global _providers_initialized

    registry = get_registry()

    if not _providers_initialized:
        # Register built-in providers
        registry.register(ClaudeProvider(db))
        registry.register(CerebrasProvider(db))
        registry.register(OpenAIProvider(db))

        # Register providers from plugins
        _register_plugin_providers(registry, db)

        # Set Claude as default
        registry.set_default("claude")

        _providers_initialized = True
        logger.info(
            f"Initialized {len(registry.get_all())} inference providers, "
            f"{len(registry.get_available())} available"
        )

    return registry


def _register_plugin_providers(registry: ProviderRegistry, db=None) -> None:
    """Register inference providers from plugins.

    Args:
        registry: The provider registry to register providers with
        db: Optional database connection
    """
    try:
        from src.plugins.registry import PluginRegistry

        plugin_registry = PluginRegistry()
        plugin_registry.discover_plugins()
        plugin_registry.load_enabled_plugins()

        for plugin in plugin_registry.get_inference_providers():
            try:
                provider = plugin.get_provider(db)
                if provider:
                    registry.register(provider)
                    logger.info(f"Registered inference provider from plugin: {plugin.name}")
            except Exception as e:
                logger.warning(f"Failed to load provider from plugin {plugin.name}: {e}")
    except ImportError:
        # Plugin system not available
        logger.debug("Plugin system not available, skipping plugin providers")
    except Exception as e:
        logger.warning(f"Error loading plugin providers: {e}")


def get_provider(
    provider_id: Optional[str] = None, db=None
) -> InferenceProvider:
    """Get an inference provider by ID, with fallback to available providers.

    Args:
        provider_id: Optional preferred provider ID
        db: Optional database connection for secrets lookup

    Returns:
        An InferenceProvider instance

    Raises:
        ProviderNotConfiguredError: If no providers are available
    """
    # Ensure providers are initialized
    registry = init_providers(db)

    return registry.get_provider_with_fallback(provider_id)


def get_available_providers(db=None) -> list[InferenceProvider]:
    """Get all providers that have API keys configured.

    Args:
        db: Optional database connection for secrets lookup

    Returns:
        List of available InferenceProvider instances
    """
    registry = init_providers(db)
    return registry.get_available()


def get_all_providers(db=None) -> list[InferenceProvider]:
    """Get all registered providers (available or not).

    Args:
        db: Optional database connection for secrets lookup

    Returns:
        List of all InferenceProvider instances
    """
    registry = init_providers(db)
    return registry.get_all()


def refresh_providers(db=None) -> None:
    """Refresh provider availability status.

    Call this after API keys are added/removed to update availability.

    Args:
        db: Optional database connection for secrets lookup
    """
    global _providers_initialized

    registry = get_registry()
    registry.clear()
    _providers_initialized = False
    init_providers(db)


# Re-export common classes for convenience
__all__ = [
    "InferenceProvider",
    "InferenceProviderError",
    "ProviderNotConfiguredError",
    "get_provider",
    "get_available_providers",
    "get_all_providers",
    "init_providers",
    "refresh_providers",
]
