"""FastAPI routes for the investment portfolio API."""

from .portfolio import router as portfolio_router
from .imports import router as imports_router
from .analysis import router as analysis_router
from .projections import router as projections_router
from .settings import router as settings_router

__all__ = [
    "portfolio_router",
    "imports_router",
    "analysis_router",
    "projections_router",
    "settings_router",
]
