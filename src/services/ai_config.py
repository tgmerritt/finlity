"""Centralized configuration for Claude AI API settings.

This module provides a single source of truth for Claude model configuration,
allowing the model to be configured via environment variable.

Available Models (as of 2025):
- claude-opus-4-5-20251101     : Most capable, best for complex analysis (expensive)
- claude-sonnet-4-20250514     : Balanced performance and cost (recommended default)
- claude-3-5-haiku-20241022    : Fastest, cheapest, good for simple tasks

Usage:
    from src.services.ai_config import get_claude_model, CLAUDE_MODEL_HAIKU

    # Get configured model (from env var or default)
    model = get_claude_model()

    # Use specific model for lightweight tasks
    model = CLAUDE_MODEL_HAIKU
"""

import os
import logging

logger = logging.getLogger(__name__)

# Available Claude models
CLAUDE_MODEL_OPUS = "claude-opus-4-5-20251101"
CLAUDE_MODEL_SONNET = "claude-sonnet-4-20250514"
CLAUDE_MODEL_HAIKU = "claude-3-5-haiku-20241022"

# Default model for general use
DEFAULT_CLAUDE_MODEL = CLAUDE_MODEL_SONNET

# Valid model identifiers for validation
VALID_CLAUDE_MODELS = {
    CLAUDE_MODEL_OPUS,
    CLAUDE_MODEL_SONNET,
    CLAUDE_MODEL_HAIKU,
    # Legacy model IDs that may still work
    "claude-3-opus-20240229",
    "claude-3-5-sonnet-20241022",
    "claude-3-haiku-20240307",
}

# Model aliases for user convenience
MODEL_ALIASES = {
    "opus": CLAUDE_MODEL_OPUS,
    "sonnet": CLAUDE_MODEL_SONNET,
    "haiku": CLAUDE_MODEL_HAIKU,
    # Common variations
    "claude-opus": CLAUDE_MODEL_OPUS,
    "claude-sonnet": CLAUDE_MODEL_SONNET,
    "claude-haiku": CLAUDE_MODEL_HAIKU,
}


def get_claude_model() -> str:
    """Get the configured Claude model from environment or use default.

    Reads from ANTHROPIC_MODEL environment variable. Supports both full model
    IDs (e.g., 'claude-sonnet-4-20250514') and aliases (e.g., 'sonnet').

    Returns:
        Model identifier string for use with Anthropic API
    """
    env_model = os.environ.get("ANTHROPIC_MODEL", "").strip().lower()

    if not env_model:
        return DEFAULT_CLAUDE_MODEL

    # Check if it's an alias
    if env_model in MODEL_ALIASES:
        resolved = MODEL_ALIASES[env_model]
        logger.debug(f"Resolved model alias '{env_model}' to '{resolved}'")
        return resolved

    # Check if it's a valid full model ID (case-insensitive check)
    env_model_original = os.environ.get("ANTHROPIC_MODEL", "").strip()
    if env_model_original in VALID_CLAUDE_MODELS:
        return env_model_original

    # Unknown model - log warning but allow it (API will reject if invalid)
    logger.warning(
        f"Unknown ANTHROPIC_MODEL '{env_model_original}'. "
        f"Valid options: {', '.join(sorted(MODEL_ALIASES.keys()))} or full model IDs. "
        f"Using as-is - API will validate."
    )
    return env_model_original


def get_model_for_task(task_type: str = "default") -> str:
    """Get the appropriate model for a specific task type.

    This allows using different models for different purposes:
    - 'default': Uses ANTHROPIC_MODEL env var or default
    - 'fast': Always uses Haiku for speed/cost efficiency
    - 'analysis': Uses configured model (for thorough analysis)
    - 'parsing': Uses Haiku (simple extraction tasks)

    Args:
        task_type: Type of task ('default', 'fast', 'analysis', 'parsing')

    Returns:
        Model identifier string
    """
    if task_type == "fast" or task_type == "parsing":
        return CLAUDE_MODEL_HAIKU
    return get_claude_model()
