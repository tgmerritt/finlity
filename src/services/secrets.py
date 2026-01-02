"""Secure storage for API keys and sensitive data."""

import base64
import os
from pathlib import Path
from typing import Optional

import yaml

from src.database import Database


class SecretsManager:
    """Manages secure storage of API keys and secrets.

    API keys can be stored in four places (checked in this order):
    1. Environment variables (e.g., ANTHROPIC_API_KEY)
    2. A .env file in the project root
    3. config.yaml under api_keys section
    4. The database (encrypted with a machine-specific key)

    For simplicity, this implementation uses base64 encoding for database storage.
    In production, consider using cryptography.fernet for stronger encryption.
    """

    # Common API key names
    ANTHROPIC_API_KEY = "anthropic_api_key"

    def __init__(self, db: Database):
        """Initialize secrets manager with database connection."""
        self.db = db
        self._env_loaded = False
        self._config_cache = None

    def _load_env_file(self) -> None:
        """Load .env file if present."""
        if self._env_loaded:
            return

        env_path = Path(".env")
        if env_path.exists():
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, value = line.split("=", 1)
                        key = key.strip()
                        value = value.strip().strip('"').strip("'")
                        if key and value and key not in os.environ:
                            os.environ[key] = value
        self._env_loaded = True

    def _load_config_yaml(self) -> dict:
        """Load config.yaml and cache it."""
        if self._config_cache is not None:
            return self._config_cache

        config_path = Path("config.yaml")
        if config_path.exists():
            try:
                with open(config_path) as f:
                    self._config_cache = yaml.safe_load(f) or {}
            except Exception:
                self._config_cache = {}
        else:
            self._config_cache = {}
        return self._config_cache

    def _get_config_api_key(self, name: str) -> Optional[str]:
        """Get an API key from config.yaml."""
        config = self._load_config_yaml()
        api_keys = config.get("api_keys", {})
        return api_keys.get(name)

    def _get_env_var_name(self, key: str) -> str:
        """Get environment variable name for a key."""
        return key.upper()

    def _encode(self, value: str) -> str:
        """Encode a value for database storage."""
        return base64.b64encode(value.encode()).decode()

    def _decode(self, encoded: str) -> str:
        """Decode a value from database storage."""
        return base64.b64decode(encoded.encode()).decode()

    def get_api_key(self, name: str) -> Optional[str]:
        """Get an API key by name.

        Checks in order:
        1. Environment variable
        2. .env file
        3. config.yaml
        4. Database storage

        Args:
            name: The key name (e.g., "anthropic_api_key")

        Returns:
            The API key value, or None if not found
        """
        # Load .env file
        self._load_env_file()

        # Check environment variable
        env_name = self._get_env_var_name(name)
        env_value = os.environ.get(env_name)
        if env_value:
            return env_value

        # Check config.yaml
        config_value = self._get_config_api_key(name)
        if config_value:
            return config_value

        # Check database
        setting = self.db.get_setting(name)
        if setting and setting.value:
            if setting.encrypted:
                try:
                    return self._decode(setting.value)
                except Exception:
                    return None
            return setting.value

        return None

    def set_api_key(self, name: str, value: str) -> bool:
        """Store an API key in the database.

        Args:
            name: The key name (e.g., "anthropic_api_key")
            value: The API key value

        Returns:
            True if stored successfully
        """
        try:
            encoded = self._encode(value)
            self.db.set_setting(name, encoded, encrypted=True)
            return True
        except Exception:
            return False

    def delete_api_key(self, name: str) -> bool:
        """Delete an API key from the database.

        Args:
            name: The key name

        Returns:
            True if deleted successfully
        """
        return self.db.delete_setting(name)

    def has_api_key(self, name: str) -> bool:
        """Check if an API key is available (from any source).

        Args:
            name: The key name

        Returns:
            True if the key is available
        """
        return self.get_api_key(name) is not None

    def mask_key(self, key: str) -> str:
        """Return a masked version of an API key for display.

        Shows first 4 and last 4 characters, masks the rest.

        Args:
            key: The API key to mask

        Returns:
            Masked key string
        """
        if not key or len(key) < 12:
            return "****"
        return f"{key[:4]}...{key[-4:]}"

    def get_key_source(self, name: str) -> Optional[str]:
        """Determine where an API key is coming from.

        Args:
            name: The key name

        Returns:
            "environment" for environment variable, ".env file" for .env file,
            "config.yaml" for config file, "database" for database, or None if not found
        """
        self._load_env_file()

        env_name = self._get_env_var_name(name)

        # Check if it's a real environment variable (not from .env)
        if env_name in os.environ:
            # Try to determine if it's from .env or actual env
            env_path = Path(".env")
            if env_path.exists():
                with open(env_path) as f:
                    content = f.read()
                    if f"{env_name}=" in content:
                        return ".env file"
            return "environment"

        # Check config.yaml
        config_value = self._get_config_api_key(name)
        if config_value:
            return "config.yaml"

        # Check database
        setting = self.db.get_setting(name)
        if setting and setting.value:
            return "database"

        return None
