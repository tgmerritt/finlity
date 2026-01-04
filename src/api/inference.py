"""API endpoints for inference provider management."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from src.database import get_database
from src.services.inference_provider import (
    get_all_providers,
    get_provider,
    refresh_providers,
)
from src.services.providers import ProviderNotConfiguredError

router = APIRouter(prefix="/api/inference", tags=["inference"])


class ModelResponse(BaseModel):
    """Model information response."""

    id: str
    display_name: str
    context_length: int
    capabilities: list[str]
    is_default: bool


class ProviderResponse(BaseModel):
    """Provider information response."""

    id: str
    display_name: str
    is_available: bool
    models: list[ModelResponse]


class ProvidersListResponse(BaseModel):
    """Response for listing all providers."""

    providers: list[ProviderResponse]
    default_provider_id: str


class ProviderStatusResponse(BaseModel):
    """Response for provider status check."""

    provider_id: str
    is_available: bool
    display_name: str


@router.get("/providers", response_model=ProvidersListResponse)
async def list_providers(db=Depends(get_database)):
    """Get all registered AI providers with their availability status.

    Returns a list of all providers, their models, and whether they
    have API keys configured.
    """
    providers = get_all_providers(db)

    provider_list = []
    for p in providers:
        provider_list.append(
            ProviderResponse(
                id=p.info.id,
                display_name=p.info.display_name,
                is_available=p.is_available(),
                models=[
                    ModelResponse(
                        id=m.id,
                        display_name=m.display_name,
                        context_length=m.context_length,
                        capabilities=m.capabilities,
                        is_default=m.is_default,
                    )
                    for m in p.info.models
                ],
            )
        )

    return ProvidersListResponse(
        providers=provider_list,
        default_provider_id="claude",
    )


@router.get("/providers/{provider_id}/status", response_model=ProviderStatusResponse)
async def get_provider_status(provider_id: str, db=Depends(get_database)):
    """Get the availability status of a specific provider.

    Args:
        provider_id: The provider ID to check

    Returns:
        Provider status including availability
    """
    providers = get_all_providers(db)

    for p in providers:
        if p.info.id == provider_id:
            return ProviderStatusResponse(
                provider_id=p.info.id,
                is_available=p.is_available(),
                display_name=p.info.display_name,
            )

    raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")


@router.post("/providers/refresh")
async def refresh_provider_status(db=Depends(get_database)):
    """Refresh provider availability status.

    Call this after adding or removing API keys to update
    which providers are available.
    """
    refresh_providers(db)
    return {"status": "ok", "message": "Provider status refreshed"}


@router.get("/providers/default")
async def get_default_provider_info(db=Depends(get_database)):
    """Get information about the default/active provider.

    Returns the provider that will be used if no preference is specified.
    Falls back through: preferred -> claude -> any available.
    """
    try:
        provider = get_provider(db=db)
        return {
            "provider_id": provider.info.id,
            "display_name": provider.info.display_name,
            "is_available": provider.is_available(),
            "default_model": (
                provider.info.get_default_model().id
                if provider.info.get_default_model()
                else None
            ),
        }
    except ProviderNotConfiguredError:
        return {
            "provider_id": None,
            "display_name": None,
            "is_available": False,
            "default_model": None,
            "error": "No AI providers configured",
        }
