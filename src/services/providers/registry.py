"""Provider registry for managing AI inference providers."""

from typing import Optional

from .base import InferenceProvider, ProviderNotConfiguredError


class ProviderRegistry:
    """Singleton registry for AI inference providers."""

    _instance: Optional["ProviderRegistry"] = None
    _initialized: bool = False

    def __new__(cls) -> "ProviderRegistry":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        if not self._initialized:
            self._providers: dict[str, InferenceProvider] = {}
            self._default_provider_id: str = "claude"
            ProviderRegistry._initialized = True

    def register(self, provider: InferenceProvider) -> None:
        """Register a provider with the registry."""
        self._providers[provider.info.id] = provider

    def unregister(self, provider_id: str) -> None:
        """Unregister a provider from the registry."""
        if provider_id in self._providers:
            del self._providers[provider_id]

    def get(self, provider_id: str) -> Optional[InferenceProvider]:
        """Get a provider by ID."""
        return self._providers.get(provider_id)

    def get_all(self) -> list[InferenceProvider]:
        """Get all registered providers."""
        return list(self._providers.values())

    def get_available(self) -> list[InferenceProvider]:
        """Get all providers that have API keys configured."""
        return [p for p in self._providers.values() if p.is_available()]

    def get_provider_ids(self) -> list[str]:
        """Get all registered provider IDs."""
        return list(self._providers.keys())

    def set_default(self, provider_id: str) -> None:
        """Set the default provider."""
        if provider_id not in self._providers:
            raise ValueError(f"Provider {provider_id} not registered")
        self._default_provider_id = provider_id

    def get_default(self) -> Optional[InferenceProvider]:
        """Get the default provider."""
        return self._providers.get(self._default_provider_id)

    def get_provider_with_fallback(
        self, preferred_id: Optional[str] = None
    ) -> InferenceProvider:
        """
        Get a provider with fallback logic.

        Priority:
        1. Preferred provider (if specified and available)
        2. Default provider (claude) if available
        3. Any available provider
        4. Raise ProviderNotConfiguredError if none available

        Args:
            preferred_id: Preferred provider ID

        Returns:
            An available InferenceProvider

        Raises:
            ProviderNotConfiguredError: If no providers are available
        """
        # Try preferred provider first
        if preferred_id:
            provider = self.get(preferred_id)
            if provider and provider.is_available():
                return provider

        # Try default provider
        default = self.get_default()
        if default and default.is_available():
            return default

        # Try any available provider
        available = self.get_available()
        if available:
            return available[0]

        # No providers available
        raise ProviderNotConfiguredError(
            "No AI providers configured. Please add an API key in Settings."
        )

    def to_dict(self) -> dict:
        """Convert registry to dictionary for API responses."""
        return {
            "providers": [p.to_dict() for p in self._providers.values()],
            "default_provider_id": self._default_provider_id,
        }

    def clear(self) -> None:
        """Clear all providers (mainly for testing)."""
        self._providers.clear()


# Global registry instance
_registry: Optional[ProviderRegistry] = None


def get_registry() -> ProviderRegistry:
    """Get the global provider registry."""
    global _registry
    if _registry is None:
        _registry = ProviderRegistry()
    return _registry


def reset_registry() -> None:
    """Reset the global registry (for testing)."""
    global _registry
    if _registry:
        _registry.clear()
    _registry = None
    ProviderRegistry._instance = None
    ProviderRegistry._initialized = False
