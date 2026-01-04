"""Secure storage for API keys and sensitive data."""

import base64
import logging
import os
from pathlib import Path
from typing import Optional

import yaml
from cryptography.fernet import Fernet, InvalidToken

from src.database import Database

logger = logging.getLogger(__name__)


def _get_or_create_encryption_key() -> bytes:
    """Get encryption key from environment or generate and store one.

    The key is derived from the SECRET_KEY environment variable if set,
    otherwise a new key is generated and stored in a local key file.

    Returns:
        32-byte URL-safe base64-encoded Fernet key
    """
    # Check environment variable first
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        # If the env key is already a valid Fernet key (44 chars base64), use it
        if len(env_key) == 44:
            return env_key.encode()
        # Otherwise, derive a Fernet key from it using PBKDF2
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        from cryptography.hazmat.primitives import hashes
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b"investment_dashboard_salt",  # Static salt, key comes from env
            iterations=100000,
        )
        return base64.urlsafe_b64encode(kdf.derive(env_key.encode()))

    # Fall back to local key file
    key_file = Path.home() / ".investment_dashboard_key"

    if key_file.exists():
        try:
            return key_file.read_bytes().strip()
        except Exception:
            pass

    # Generate new key
    new_key = Fernet.generate_key()
    try:
        key_file.write_bytes(new_key)
        key_file.chmod(0o600)  # Restrict permissions
    except Exception as e:
        logger.warning(f"Could not persist encryption key: {e}")

    return new_key


class SecretsManager:
    """Manages secure storage of API keys and secrets.

    API keys can be stored in four places (checked in this order):
    1. Environment variables (e.g., ANTHROPIC_API_KEY)
    2. A .env file in the project root
    3. config.yaml under api_keys section
    4. The database (encrypted with Fernet symmetric encryption)

    Database storage uses Fernet encryption (AES-128-CBC with HMAC).
    The encryption key is derived from the SECRET_KEY environment variable
    or stored in a local key file (~/.investment_dashboard_key).
    """

    # Common API key names
    ANTHROPIC_API_KEY = "anthropic_api_key"
    FMP_API_KEY = "fmp_api_key"  # Financial Modeling Prep

    def __init__(self, db: Database):
        """Initialize secrets manager with database connection."""
        self.db = db
        self._env_loaded = False
        self._config_cache = None
        self._fernet: Optional[Fernet] = None

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

    def _get_fernet(self) -> Fernet:
        """Get or create the Fernet cipher instance."""
        if self._fernet is None:
            key = _get_or_create_encryption_key()
            self._fernet = Fernet(key)
        return self._fernet

    def _encode(self, value: str) -> str:
        """Encrypt a value for database storage using Fernet.

        The encrypted value is prefixed with 'fernet:' to distinguish
        it from legacy base64-encoded values.
        """
        fernet = self._get_fernet()
        encrypted = fernet.encrypt(value.encode())
        return "fernet:" + encrypted.decode()

    def _decode(self, encoded: str) -> str:
        """Decrypt a value from database storage.

        Supports both new Fernet-encrypted values (prefixed with 'fernet:')
        and legacy base64-encoded values for backward compatibility.
        """
        if encoded.startswith("fernet:"):
            # New Fernet-encrypted value
            fernet = self._get_fernet()
            try:
                encrypted_data = encoded[7:].encode()  # Remove 'fernet:' prefix
                return fernet.decrypt(encrypted_data).decode()
            except InvalidToken:
                logger.error("Failed to decrypt value - invalid token or wrong key")
                raise
        else:
            # Legacy base64-encoded value (for backward compatibility)
            logger.warning(
                "Decoding legacy base64-encoded secret. "
                "Consider re-saving the API key to upgrade to Fernet encryption."
            )
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
