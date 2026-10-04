"""Stateless /api/v2 API package.

v2 endpoints receive the client's portfolio/budget data in the request body
and persist nothing server-side (no `get_database()` / `Depends(get_db)`,
no table writes). The only permitted server-side reads are: the funds.yaml
cache (FundDataService, cache-only), price/quote fetches keyed by ticker
(PriceService), and API keys from environment variables.

See src/api/v2/payload.py for the client-supplied payload models and the
adapters that bridge them into the existing pure analysis code.
"""

from fastapi import APIRouter

from src.api.v2.analysis import router as v2_analysis_router
from src.api.v2.triggers import router as v2_triggers_router
from src.api.v2.projections import router as v2_projections_router
from src.api.v2.budget import router as v2_budget_router
from src.api.v2.bank_statements import router as v2_bank_statements_router
from src.api.v2.imports import router as v2_imports_router
from src.api.v2.prices import router as v2_prices_router
from src.api.v2.fund import router as v2_fund_router
from src.api.v2.commentary import router as v2_commentary_router
from src.api.v2.smart_import import router as v2_smart_import_router
from src.api.v2.connectors import router as v2_connectors_router

v2_router = APIRouter()
v2_router.include_router(v2_analysis_router)
v2_router.include_router(v2_triggers_router)
v2_router.include_router(v2_projections_router)
v2_router.include_router(v2_budget_router)
v2_router.include_router(v2_bank_statements_router)
v2_router.include_router(v2_imports_router)
v2_router.include_router(v2_prices_router)
v2_router.include_router(v2_fund_router)
v2_router.include_router(v2_commentary_router)
v2_router.include_router(v2_smart_import_router)
v2_router.include_router(v2_connectors_router)

__all__ = ["v2_router"]
