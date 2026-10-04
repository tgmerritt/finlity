"""Secure storage for API keys and sensitive data."""

import base64
import logging
import os
import secrets as _pysecrets
import time
from pathlib import Path
from typing import Any, Optional, cast

import yaml
from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from src.database import Database

logger = logging.getLogger(__name__)

# Legacy hardcoded salt used by installations predating the per-install salt
# file. Retained solely to decrypt existing ciphertext during migration.
_LEGACY_SALT = b"investment_dashboard_salt"
_SALT_BYTES = 16
_PBKDF2_ITERATIONS = 200_000  # doubled from 100k legacy value
# A salt file another process has created but not finished writing is
# re-read this many times, this many seconds apart, before giving up.
_SALT_WAIT_ATTEMPTS = 5
_SALT_WAIT_SECONDS = 0.05


def _salt_file() -> Path:
    """Per-install salt file. Lives next to the encryption key file."""
    return Path.home() / ".investment_dashboard_salt"


def _key_file() -> Path:
    """Per-install key file, used when SECRET_KEY is not set."""
    return Path.home() / ".investment_dashboard_key"


class EncryptionKeyUnavailable(RuntimeError):
    """The encryption key (or its salt) exists but cannot be read, or does not
    exist and the caller only reads. The file is never regenerated or
    overwritten in that case: doing so would make every stored secret
    unreadable. The message is fixed and names no path or value."""

    def __init__(self) -> None:
        super().__init__("the encryption key could not be read")


def _create_exclusive(path: Path, data: bytes) -> bytes:
    """Write ``data`` to a new file (mode 0o600) without ever replacing one.

    If another process created the file first, its contents win. A write
    failure keeps the old behaviour (a warning, an unpersisted value).
    """
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _read_existing(path)
    except OSError as exc:
        logger.warning("Could not persist %s: %s", path.name, exc.__class__.__name__)
        return data
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return data


def _read_existing(path: Path, strip: bool = True) -> bytes:
    try:
        data = path.read_bytes()
    except OSError:
        logger.error("Could not read %s; leaving it untouched.", path.name)
        raise EncryptionKeyUnavailable() from None
    return data.strip() if strip else data


def _read_salt(path: Path) -> bytes:
    """The salt in ``path``. Older code wrote 16 raw bytes that could begin
    or end with whitespace, so when the stripped salt is short and the file
    holds exactly 16 raw bytes, those raw bytes are the salt."""
    data = _read_existing(path)
    if len(data) < _SALT_BYTES:
        raw = _read_existing(path, strip=False)
        if len(raw) == _SALT_BYTES:
            return raw
    return data


def _load_or_create_salt(create: bool = True) -> Optional[bytes]:
    """Load the per-install salt; generate it (mode 0o600) only when
    ``create`` is true and no file exists. An existing file that cannot be
    read, or is truncated, raises EncryptionKeyUnavailable and is left as is.
    A file another process created first but has not finished writing is
    re-read briefly, then raises EncryptionKeyUnavailable.
    Returns None when there is no file and ``create`` is false."""
    path = _salt_file()
    if path.exists():
        data = _read_salt(path)
        if len(data) < _SALT_BYTES:
            logger.error("Salt file %s is truncated; leaving it untouched.", path.name)
            raise EncryptionKeyUnavailable()
        return data
    if not create:
        return None
    data = _create_exclusive(path, _new_salt())
    for _ in range(_SALT_WAIT_ATTEMPTS):
        if len(data) >= _SALT_BYTES:
            return data
        # Another process created the file first and is still writing it.
        time.sleep(_SALT_WAIT_SECONDS)
        data = _read_salt(path)
    if len(data) >= _SALT_BYTES:
        return data
    logger.error("Salt file %s is still incomplete after waiting; leaving it untouched.", path.name)
    raise EncryptionKeyUnavailable()


def _new_salt() -> bytes:
    """Random salt bytes that survive the ``strip()`` applied on read: a salt
    starting or ending with a whitespace byte would read back as a different
    (or truncated) salt and make everything encrypted with it unreadable."""
    while True:
        salt = _pysecrets.token_bytes(_SALT_BYTES)
        if salt.strip() == salt:
            return salt


def _derive_fernet_key(password: str, salt: bytes) -> bytes:
    """Derive a URL-safe Fernet key from a password and salt via PBKDF2-SHA256."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=_PBKDF2_ITERATIONS,
    )
    return base64.urlsafe_b64encode(kdf.derive(password.encode()))


def _get_or_create_encryption_key(create: bool = True) -> bytes:
    """Get the encryption key from the environment or the key file.

    The key is SECRET_KEY itself (a 44-character Fernet key), or derived from
    SECRET_KEY with the per-install salt, or read from
    ``~/.investment_dashboard_key``. A missing key file (or salt) is created
    only when ``create`` is true; a read never creates one and raises
    EncryptionKeyUnavailable instead. An existing file that cannot be read
    raises EncryptionKeyUnavailable and is never regenerated or overwritten.

    Returns:
        32-byte URL-safe base64-encoded Fernet key
    """
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        # Already a Fernet key: use directly.
        if len(env_key) == 44:
            return env_key.encode()
        # Otherwise derive with the per-install salt.
        salt = _load_or_create_salt(create)
        if salt is None:
            raise EncryptionKeyUnavailable()
        return _derive_fernet_key(env_key, salt)

    # No env-var path: use a randomly-generated key persisted on disk.
    key_file = _key_file()
    if key_file.exists():
        return _read_existing(key_file)
    if not create:
        raise EncryptionKeyUnavailable()
    return _create_exclusive(key_file, Fernet.generate_key())


class SecretUnreadable(Exception):
    """A stored secret that cannot be used: missing key, rotated key, a value
    written by the other data path (``wc1:``), a legacy or plaintext row, or
    ciphertext that does not decrypt. Callers treat it as "reconnect needed".

    The message is fixed; it never carries the value or exception text.
    """

    def __init__(self) -> None:
        super().__init__("stored secret could not be read")


class StoredSecretsUnavailable(PermissionError):
    """Database-only secrets are refused on a shared deployment."""

    def __init__(self) -> None:
        super().__init__("stored secrets are not available on this deployment")


_FERNET_PREFIX = "fernet:"

# Settings rows owned by the connection store (src/connectors/store.py). The
# generic API key methods and routes never read, write or report them.
RESERVED_SETTING_KEY = "connections"
RESERVED_SETTING_PREFIX = "connection_secret:"


def is_reserved_secret_name(name: object) -> bool:
    """True for the ``connections`` row and any ``connection_secret:`` row
    (any case, surrounding whitespace ignored)."""
    if not isinstance(name, str):
        return False
    folded = name.strip().lower()
    return folded == RESERVED_SETTING_KEY or folded.startswith(RESERVED_SETTING_PREFIX)


def _refuse_shared() -> None:
    # Imported here: src.connectors is the stateless core and must not import
    # src.services, so the dependency only goes this way, at call time.
    from src.connectors.env import shared_deployment

    if shared_deployment():
        raise StoredSecretsUnavailable()


def _get_legacy_fernet_key() -> Optional[bytes]:
    """Return the legacy (pre-per-install-salt) Fernet key, if derivable."""
    env_key = os.environ.get("SECRET_KEY")
    if not env_key or len(env_key) == 44:
        return None
    return _derive_fernet_key(env_key, _LEGACY_SALT)


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
        self._config_cache: Optional[dict] = None
        self._fernet: Optional[Any] = None

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
        result = api_keys.get(name)
        return cast(Optional[str], result)

    def _get_env_var_name(self, key: str) -> str:
        """Get environment variable name for a key."""
        return key.upper()

    def _get_fernet(self, create: bool = True):
        """Get the Fernet cipher (with legacy fallback).

        When a derived-from-password key is in use, a :class:`MultiFernet`
        is returned that wraps the current per-install key *plus* the
        legacy hardcoded-salt key. Decrypting existing ciphertext still
        succeeds; new ciphertext is encrypted under the current key.

        With ``create`` false (every decrypt path) a missing key file or salt
        is not created: the legacy key alone is used when one is derivable,
        otherwise EncryptionKeyUnavailable is raised. An unreadable or
        malformed key also raises EncryptionKeyUnavailable; nothing on disk
        is regenerated or overwritten.
        """
        if self._fernet is not None:
            return self._fernet
        legacy_key = _get_legacy_fernet_key()
        try:
            current_key = _get_or_create_encryption_key(create)
        except EncryptionKeyUnavailable:
            # A password SECRET_KEY with no salt file yet: values written
            # before the per-install salt still decrypt with the legacy key.
            if create or legacy_key is None or _salt_file().exists():
                raise
            return Fernet(legacy_key)
        try:
            if legacy_key and legacy_key != current_key:
                fernet: Any = MultiFernet([Fernet(current_key), Fernet(legacy_key)])
            else:
                fernet = Fernet(current_key)
        except (ValueError, TypeError):
            # A key file that is not a Fernet key (binascii.Error is a ValueError).
            logger.error("The encryption key is malformed; leaving it untouched.")
            raise EncryptionKeyUnavailable() from None
        self._fernet = fernet
        return fernet

    def _encode(self, value: str) -> str:
        """Encrypt a value for database storage using Fernet.

        The encrypted value is prefixed with 'fernet:' to distinguish
        it from legacy base64-encoded values.
        """
        fernet = self._get_fernet()
        encrypted = fernet.encrypt(value.encode())
        return "fernet:" + cast(str, encrypted.decode())

    def _decode(self, encoded: str) -> str:
        """Decrypt a value from database storage.

        Supports both new Fernet-encrypted values (prefixed with 'fernet:')
        and legacy base64-encoded values for backward compatibility.
        """
        if encoded.startswith("fernet:"):
            # New Fernet-encrypted value; reading never creates a key file.
            fernet = self._get_fernet(create=False)
            try:
                encrypted_data = encoded[7:].encode()  # Remove 'fernet:' prefix
                return cast(str, fernet.decrypt(encrypted_data).decode())
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

    # ---- Database-only secrets (connector credentials) -------------------
    #
    # Unlike get_api_key these never consult the environment, .env or
    # config.yaml (a variable named after a stored secret means nothing), and a
    # decrypt failure raises SecretUnreadable instead of returning None, so the
    # caller can ask the user to reconnect. Only Fernet values are accepted:
    # no legacy base64 fallback, no plaintext rows.

    def encrypt_for_storage(self, value: str) -> str:
        """``fernet:`` ciphertext for ``value``, for a row with ``encrypted=1``.
        Refused on a shared deployment."""
        _refuse_shared()
        return self._encode(value)

    def decrypt_stored(self, value: object, encrypted: object) -> str:
        """Plaintext of a stored ``fernet:`` value, or raise SecretUnreadable.
        Refused on a shared deployment."""
        _refuse_shared()
        if not encrypted or not isinstance(value, str) or not value.startswith(_FERNET_PREFIX):
            raise SecretUnreadable()
        token = value[len(_FERNET_PREFIX):].encode("ascii", errors="replace")
        plain: Optional[str] = None
        try:
            plain = self._get_fernet(create=False).decrypt(token).decode("utf-8")
        except (InvalidToken, EncryptionKeyUnavailable, ValueError, TypeError):
            # A missing, unreadable or malformed key, a wrong key, or bytes
            # that are not UTF-8 (UnicodeDecodeError is a ValueError).
            plain = None
        # Raised outside the except block so no exception context holds bytes.
        if plain is None:
            raise SecretUnreadable()
        return plain

    def set_stored_secret(self, name: str, value: str) -> None:
        """Encrypt ``value`` and store it in the database under ``name``.

        Refused on a shared deployment (StoredSecretsUnavailable). Raises
        EncryptionKeyUnavailable when the key exists but cannot be read.
        """
        _refuse_shared()
        self.db.set_setting(name, self.encrypt_for_storage(value), encrypted=True)

    def get_stored_secret(self, name: str) -> Optional[str]:
        """The decrypted database value for ``name``; None when there is no row.

        Raises SecretUnreadable when the row exists but cannot be decrypted,
        and StoredSecretsUnavailable on a shared deployment.
        """
        _refuse_shared()
        setting = self.db.get_setting(name)
        if setting is None:
            return None
        return self.decrypt_stored(setting.value, setting.encrypted)

    def delete_stored_secret(self, name: str) -> bool:
        """Remove the database row for ``name``. True when a row was removed."""
        return self.db.delete_setting(name)

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
            The API key value, or None if not found (always None for the
            connection store's reserved rows)
        """
        if is_reserved_secret_name(name):
            return None
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
                    return self._decode(cast(str, setting.value))
                except Exception:
                    return None
            return cast(str, setting.value)

        return None

    def set_api_key(self, name: str, value: str) -> bool:
        """Store an API key in the database.

        Args:
            name: The key name (e.g., "anthropic_api_key")
            value: The API key value

        Returns:
            True if stored successfully (never for a reserved name)
        """
        if is_reserved_secret_name(name):
            return False
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
            True if deleted successfully (never for a reserved name)
        """
        if is_reserved_secret_name(name):
            return False
        return self.db.delete_setting(name)

    def has_api_key(self, name: str) -> bool:
        """Check if an API key is available (from any source).

        Args:
            name: The key name

        Returns:
            True if the key is available (never for a reserved name)
        """
        if is_reserved_secret_name(name):
            return False
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
        if is_reserved_secret_name(name):
            return None
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
