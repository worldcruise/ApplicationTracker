"""Owner-only security repository. No account/session or filesystem work on import."""
from contextlib import contextmanager
import base64
import copy
from dataclasses import dataclass
import datetime as dt
import hashlib
import hmac
import json
from pathlib import Path
import re
import secrets
import uuid

from .models import ConfigurationError, RevisionConflict, allowed_fields, require, timestamp, version_one
from .repositories import JsonRepository, _decode, _encode, _lock
from .security_files import SecurityPermissions, private_atomic_write


MIN_ITERATIONS = 600_000
MAX_ITERATIONS = 2_000_000
MAX_PASSWORD_BYTES = 1024
ALGORITHM = "pbkdf2-hmac-sha256"
USERNAME = re.compile(r"[a-z0-9][a-z0-9_.-]{2,63}")
UUID_HEX = re.compile(r"[0-9a-f]{32}")


def normalize_username(value):
    require(isinstance(value, str), "Username must be text.")
    value = value.strip().casefold()
    require(bool(USERNAME.fullmatch(value)), "Username must be 3–64 ASCII letters, digits, dots, underscores or hyphens.")
    return value


def _password_bytes(value):
    if not isinstance(value, str):
        return None
    try:
        encoded = value.encode("utf-8")
    except UnicodeError:
        return None
    return encoded if len(encoded) <= MAX_PASSWORD_BYTES else None


def _base64_bytes(value, size):
    require(isinstance(value, str), "Password verifier encoding is invalid.")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, UnicodeError) as error:
        raise ConfigurationError("Password verifier encoding is invalid.") from error
    require(len(decoded) == size and base64.b64encode(decoded).decode("ascii") == value,
            "Password verifier encoding or length is invalid.")
    return decoded


def validate_password_verifier(value):
    require(isinstance(value, dict), "Password verifier must be an object.")
    allowed_fields(value, ("algorithm", "iterations", "salt", "digest"), "Password verifier")
    require(value.get("algorithm") == ALGORITHM, "Unsupported password verifier algorithm.")
    iterations = value.get("iterations")
    require(type(iterations) is int and MIN_ITERATIONS <= iterations <= MAX_ITERATIONS,
            "Password verifier iterations must be between 600000 and 2000000.")
    _base64_bytes(value.get("salt"), 32)
    _base64_bytes(value.get("digest"), 32)


def create_password_verifier(password, *, iterations=MIN_ITERATIONS):
    encoded = _password_bytes(password)
    require(encoded is not None and len(password) >= 15,
            "Use a passphrase of at least 15 characters and at most 1024 UTF-8 bytes.")
    require(type(iterations) is int and MIN_ITERATIONS <= iterations <= MAX_ITERATIONS,
            "Password verifier iterations must be between 600000 and 2000000.")
    salt = secrets.token_bytes(32)
    digest = hashlib.pbkdf2_hmac("sha256", encoded, salt, iterations, dklen=32)
    return {"algorithm": ALGORITHM, "iterations": iterations,
            "salt": base64.b64encode(salt).decode("ascii"),
            "digest": base64.b64encode(digest).decode("ascii")}


def verify_password(password, verifier):
    validate_password_verifier(verifier)
    encoded = _password_bytes(password)
    if encoded is None:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", encoded, _base64_bytes(verifier["salt"], 32),
                                verifier["iterations"], dklen=32)
    return hmac.compare_digest(actual, _base64_bytes(verifier["digest"], 32))


def validate_security_record(value):
    require(isinstance(value, dict), "Security configuration must be an object.")
    version_one(value, "owner security")
    allowed_fields(value, ("schemaVersion", "backendId", "authEpoch", "users"), "Security configuration")
    for key in ("backendId", "authEpoch"):
        require(isinstance(value.get(key), str) and bool(UUID_HEX.fullmatch(value[key])), f"Invalid security {key}.")
    users = value.get("users")
    require(isinstance(users, list) and len(users) == 1, "This security version requires exactly one owner account.")
    owner = users[0]
    require(isinstance(owner, dict), "Owner account must be an object.")
    allowed_fields(owner, ("id", "username", "role", "passwordVerifier", "authGeneration", "disabled", "createdAt", "passwordChangedAt"), "Owner account")
    require(isinstance(owner.get("id"), str) and bool(UUID_HEX.fullmatch(owner["id"])), "Owner requires an immutable UUID identifier.")
    require(owner.get("username") == normalize_username(owner.get("username")), "Stored owner username must be canonical.")
    require(owner.get("role") == "owner", "Only the local owner role is supported.")
    require(type(owner.get("disabled")) is bool, "Owner disabled must be boolean.")
    generation = owner.get("authGeneration")
    require(type(generation) is int and 1 <= generation < 2**53, "Invalid owner authentication generation.")
    validate_password_verifier(owner.get("passwordVerifier"))
    created = timestamp(owner.get("createdAt"), "Owner createdAt")
    changed = timestamp(owner.get("passwordChangedAt"), "Owner passwordChangedAt")
    require(changed >= created, "Owner passwordChangedAt precedes account creation.")


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _reset_record(data, password):
    result = copy.deepcopy(data)
    owner = result["users"][0]
    owner["passwordVerifier"] = create_password_verifier(password)
    owner["passwordChangedAt"] = _now()
    owner["authGeneration"] += 1
    # UI-C2 must validate both epoch and generation on every session lookup.
    result["authEpoch"] = uuid.uuid4().hex
    validate_security_record(result)
    return result


@dataclass(frozen=True, repr=False)
class RecoverySnapshot:
    data: dict
    revision: str | None
    backup_revision: str


class SecurityRepository:
    """Explicit owner operations; generic record replacement/backup restore is not exposed."""
    def __init__(self, directory, *, permissions=None):
        self.directory = Path(directory).absolute()
        self.path = self.directory / "security.json"
        self.backup_path = self.directory / "security.json.bak"
        self.permissions = permissions or SecurityPermissions()
        self._record = JsonRepository(self.path, validate_security_record, atomic_writer=self._write)
        self._backup = JsonRepository(self.backup_path, validate_security_record)

    def _write(self, path, content, *, before_replace=None):
        private_atomic_write(path, content, permissions=self.permissions, before_replace=before_replace)

    @contextmanager
    def _guard(self):
        self.permissions.validate(self.directory, directory=True)
        canonical = self.directory.resolve() / "security.json"
        with _lock(canonical), self.permissions.lock(canonical):
            self.permissions.validate(self.directory, directory=True)
            for path in (self.path, self.backup_path, *self.directory.glob(".security.json.*")):
                self.permissions.validate(path, missing_ok=True)
            yield

    def _pristine(self):
        if self.path.exists() or self.backup_path.exists() or any(self.directory.glob(".security.json.*")):
            raise ConfigurationError("Security storage already exists or has recovery artifacts. Initialization will not replace it; use explicit reset/recovery.")

    def ensure_uninitialized(self):
        with self._guard():
            self._pristine()

    def read(self):
        with self._guard():
            return self._record.read(missing_ok=False)

    def initialize(self, username, password):
        with self._guard():
            self._pristine()
            now = _now()
            owner = {"id": uuid.uuid4().hex, "username": normalize_username(username), "role": "owner",
                     "passwordVerifier": create_password_verifier(password), "authGeneration": 1,
                     "disabled": False, "createdAt": now, "passwordChangedAt": now}
            data = {"schemaVersion": 1, "backendId": uuid.uuid4().hex, "authEpoch": uuid.uuid4().hex, "users": [owner]}
            return self._record.save(data, expected_revision=None)

    @staticmethod
    def _owner(data, username):
        owner = data["users"][0]
        require(owner["username"] == normalize_username(username), "The requested username does not match this owner store.")
        return owner

    def reset_password(self, username, password, *, expected_revision):
        with self._guard():
            snapshot = self._record.read(missing_ok=False)
            if snapshot.revision != expected_revision:
                raise RevisionConflict("Owner security changed; inspect it again before resetting.")
            self._owner(snapshot.data, username)
            return self._record.save(_reset_record(snapshot.data, password), expected_revision=expected_revision)

    def _recoverable_primary(self):
        raw = self._record._raw()
        if raw is not None:
            try:
                header = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeError):
                header = None
            if isinstance(header, dict) and header.get("schemaVersion") not in (None, 1):
                raise ConfigurationError("Recovery cannot downgrade an unsupported primary schema; use a compatible application version.")
            try:
                _decode(raw, self.path, validate_security_record)
            except ConfigurationError:
                pass
            else:
                raise ConfigurationError("The primary owner record is valid; use reset-password instead of backup recovery.")
        return raw

    def recovery_snapshot(self):
        with self._guard():
            self._recoverable_primary()
            backup = self._backup.read(missing_ok=False)
            return RecoverySnapshot(backup.data, self._record.current_revision(), backup.revision)

    def recover_backup(self, username, password, *, expected_revision, expected_backup_revision):
        with self._guard():
            old = self._recoverable_primary()
            backup = self._backup.read(missing_ok=False)
            self._owner(backup.data, username)

            def unchanged():
                if self._record.current_revision() != expected_revision or self._backup.current_revision() != expected_backup_revision:
                    raise RevisionConflict("Security primary or backup changed; inspect recovery again.")

            unchanged()
            encoded = _encode(_reset_record(backup.data, password), validate_security_record)
            if old is not None:
                retained = self.directory / f".security.json.before-restore.{uuid.uuid4().hex}"
                self._write(retained, old, before_replace=unchanged)
            self._write(self.path, encoded, before_replace=unchanged)
            # The validated backup remains untouched. Retained malformed bytes are
            # forensic evidence only, never silently consumed as configuration.
            return self._record.read(missing_ok=False)
