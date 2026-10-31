"""Process-local owner authentication. No filesystem work or credentials on import."""
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import math
import re
import secrets
import threading
import time

from .models import ConfigurationError
from .security import MAX_PASSWORD_BYTES, normalize_username, verify_password


IDLE_SECONDS = 1800
ABSOLUTE_SECONDS = 28800
ATTEMPT_WINDOW_SECONDS = 300
MAX_ATTEMPTS = 10
MAX_VERIFICATIONS = 2
MAX_SESSIONS = 128
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")


class AuthError(Exception):
    def __init__(self, status, code, message, *, retry_after=None):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.retry_after = retry_after


def invalid_credentials():
    return AuthError(401, "invalid-credentials", "Invalid username or password.")


def authentication_required():
    return AuthError(401, "authentication-required", "Sign in to continue.")


def validate_credentials(username, password):
    try:
        valid = (isinstance(username, str) and 0 < len(username.strip()) <= 64 and len(username) <= 256
                 and isinstance(password, str) and 0 < len(password.encode("utf-8")) <= MAX_PASSWORD_BYTES)
    except UnicodeError:
        valid = False
    if not valid:
        raise AuthError(400, "invalid-request", "Provide a username and password as nonempty text within the supported limits.")


@dataclass(repr=False)
class _Session:
    user_id: str
    backend_id: str
    auth_epoch: str
    generation: int
    created: float
    last_activity: float
    audience: str = "web"
    extension_scope: object = None


@dataclass(frozen=True, repr=False)
class _ExtensionScope:
    backendId: str
    workspaceId: str
    installationId: str
    bindingId: str
    candidateId: str
    bindingRevision: int
    extensionOrigin: str


@dataclass(frozen=True, repr=False)
class IssuedSession:
    # Only the caller receives this transient token; the session store never does.
    token: str
    metadata: dict


class AuthService:
    def __init__(self, repository, *, clock=time.monotonic):
        self.repository, self.clock = repository, clock
        self._lock = threading.RLock()
        self._verifications = threading.BoundedSemaphore(MAX_VERIFICATIONS)
        self._attempts = deque()
        self._sessions = {}
        self._revocation_serial = 0

    def _security(self):
        # Call while holding _lock: no older concurrent observation can restore
        # sessions after another request has detected an unavailable store.
        try:
            return self.repository.read()
        except FileNotFoundError:
            self.revoke_all()
            raise AuthError(503, "owner-setup-required", "Initialize the local owner using the administrative command.") from None
        except (ConfigurationError, OSError, RecursionError):
            self.revoke_all()
            raise AuthError(503, "authentication-unavailable", "Owner authentication is unavailable. Review the local security configuration.") from None

    @staticmethod
    def _binding(data):
        owner = data["users"][0]
        return owner["id"], data["backendId"], data["authEpoch"], owner["authGeneration"]

    @staticmethod
    def _digest(token):
        if not isinstance(token, str) or not TOKEN_PATTERN.fullmatch(token):
            return None
        return hashlib.sha256(token.encode("ascii")).digest()

    def _prune(self, now, data):
        binding = self._binding(data)
        disabled = data["users"][0]["disabled"]
        for digest, session in list(self._sessions.items()):
            if (disabled or now >= session.created + ABSOLUTE_SECONDS
                    or now >= session.last_activity + IDLE_SECONDS
                    or (session.user_id, session.backend_id, session.auth_epoch, session.generation) != binding):
                del self._sessions[digest]

    @staticmethod
    def _metadata(session, owner, now):
        return {
            "authenticated": True,
            "user": {"id": session.user_id, "username": owner["username"], "role": "owner"},
            "session": {
                "idleRemainingSeconds": max(0, math.ceil(session.last_activity + IDLE_SECONDS - now)),
                "absoluteRemainingSeconds": max(0, math.ceil(session.created + ABSOLUTE_SECONDS - now)),
            },
        }

    def status(self):
        with self._lock:
            try:
                self._security()
                return "ready"
            except AuthError as error:
                return "setup-required" if error.code == "owner-setup-required" else "unavailable"

    def _attempt(self):
        with self._lock:
            now = self.clock()
            while self._attempts and now >= self._attempts[0] + ATTEMPT_WINDOW_SECONDS:
                self._attempts.popleft()
            if len(self._attempts) >= MAX_ATTEMPTS:
                retry = max(1, math.ceil(self._attempts[0] + ATTEMPT_WINDOW_SECONDS - now))
                raise AuthError(429, "rate-limited", "Too many sign-in attempts. Try again later.", retry_after=retry)
            self._attempts.append(now)

    def login(self, username, password, *, previous_token=None):
        return self._login(username, password, previous_token=previous_token)

    def login_extension(self, username, password, pairings, installation_id, credential, extension_origin):
        return self._login(username, password, extension=(pairings, installation_id, credential, extension_origin))

    @contextmanager
    def _extension_transaction(self, extension, owner_id, *, logout_only=False):
        pairings, installation_id, credential, origin = extension
        try:
            with pairings.installation_context(owner_id, installation_id, credential, origin,
                                               logout_only=logout_only) as context:
                yield context
        except (ConfigurationError, OSError, RecursionError):
            self.revoke_installation(installation_id)
            raise AuthError(503, "authentication-unavailable", "Private installation authorization is unavailable.") from None

    def _login(self, username, password, *, previous_token=None, extension=None):
        self._attempt()
        validate_credentials(username, password)
        if not self._verifications.acquire(blocking=False):
            raise AuthError(429, "rate-limited", "Too many sign-in attempts. Try again later.", retry_after=1)
        try:
            with self._lock:
                snapshot = self._security()
                serial = self._revocation_serial
                scope = None
                if extension is not None:
                    with self._extension_transaction(extension, snapshot.data["users"][0]["id"]) as (security, context, _):
                        if self._binding(security) != self._binding(snapshot.data):
                            raise invalid_credentials()
                        scope = _ExtensionScope(**context)
            owner = snapshot.data["users"][0]
            try:
                canonical = normalize_username(username)
            except ConfigurationError:
                canonical = None
            # One owner: use the same real verifier even for an unknown username.
            # The username/disabled result is checked only after the bounded hash.
            password_ok = verify_password(password, owner["passwordVerifier"])
            if not password_ok or canonical != owner["username"] or owner["disabled"]:
                raise invalid_credentials()
            with self._lock:
                current = self._security()
                # A reset detected during password work also removes sessions
                # from that old generation, even though this login is rejected.
                self._prune(self.clock(), current.data)
                if current.revision != snapshot.revision or serial != self._revocation_serial:
                    raise invalid_credentials()
                if extension is not None:
                    with self._extension_transaction(extension, owner["id"]) as (security, context, candidate):
                        if self._binding(security) != self._binding(snapshot.data):
                            raise invalid_credentials()
                        if _ExtensionScope(**context) != scope:
                            raise AuthError(409, "binding-changed", "Browser assignment changed. Review it and sign in again explicitly.")
                        return self._issue(current.data, scope=scope, candidate=candidate)
                return self._issue(current.data, previous_token=previous_token)
        finally:
            self._verifications.release()

    def _issue(self, data, *, previous_token=None, scope=None, candidate=None):
        # Called under _lock and, for extensions, the current private binding
        # transaction. No concurrent login can leave two sessions per install.
        now = self.clock()
        self._prune(now, data)
        replace = set()
        if scope is not None:
            replace = {key for key, value in self._sessions.items()
                       if value.audience == "extension" and value.extension_scope.installationId == scope.installationId}
        else:
            previous = self._digest(previous_token)
            if previous in self._sessions and self._sessions[previous].audience == "web":
                replace.add(previous)
        if len(self._sessions) - len(replace) >= MAX_SESSIONS:
            raise AuthError(503, "session-capacity", "Session capacity reached. Sign out an existing session or wait for expiration.")
        for _ in range(5):
            token = secrets.token_urlsafe(32)
            digest = self._digest(token)
            if digest is not None and digest not in self._sessions:
                break
        else:
            raise AuthError(503, "authentication-unavailable", "A fresh session could not be issued.")
        session = _Session(*self._binding(data), now, now, "extension" if scope else "web", scope)
        metadata = self._extension_metadata(session, data["users"][0], candidate, now) if scope else self._metadata(session, data["users"][0], now)
        for key in replace:
            del self._sessions[key]
        self._sessions[digest] = session
        return IssuedSession(token, metadata)

    @classmethod
    def _extension_metadata(cls, session, owner, candidate, now):
        metadata = cls._metadata(session, owner, now)
        scope = session.extension_scope
        metadata["session"]["audience"] = "extension"
        metadata["context"] = {
            "backendId": scope.backendId, "workspaceId": scope.workspaceId,
            "installationId": scope.installationId, "bindingId": scope.bindingId,
            "bindingRevision": scope.bindingRevision, "extensionOrigin": scope.extensionOrigin,
            "candidate": {"id": scope.candidateId, "name": candidate["name"]},
        }
        return metadata

    def session(self, token, *, touch=False):
        with self._lock:
            snapshot = self._security()
            now = self.clock()
            self._prune(now, snapshot.data)
            session = self._sessions.get(self._digest(token))
            if session is None or session.audience != "web":
                raise authentication_required()
            if touch:
                session.last_activity = now
            return self._metadata(session, snapshot.data["users"][0], now)

    def logout(self, token):
        with self._lock:
            digest = self._digest(token)
            session = self._sessions.get(digest)
            if session is not None and session.audience == "web":
                del self._sessions[digest]

    def extension_session(self, token, pairings, installation_id, credential, extension_origin, *, touch=False):
        with self._lock:
            snapshot = self._security()
            now = self.clock()
            self._prune(now, snapshot.data)
            digest = self._digest(token)
            session = self._sessions.get(digest)
            if (session is None or session.audience != "extension"
                    or session.extension_scope.installationId != installation_id):
                raise authentication_required()
            extension = (pairings, installation_id, credential, extension_origin)
            try:
                with self._extension_transaction(extension, session.user_id) as (security, context, candidate):
                    if self._binding(security) != (session.user_id, session.backend_id, session.auth_epoch, session.generation):
                        raise authentication_required()
                    if _ExtensionScope(**context) != session.extension_scope:
                        raise AuthError(409, "binding-changed", "Browser assignment changed. Sign in again before accessing its data.")
                    # ACL/file checks can take time: expiration is authoritative
                    # at the final decision, before any activity renewal.
                    now = self.clock()
                    self._prune(now, security)
                    if digest not in self._sessions:
                        raise authentication_required()
                    if touch:
                        session.last_activity = now
                    return self._extension_metadata(session, security["users"][0], candidate, now)
            except AuthError as error:
                if error.code in ("binding-changed", "candidate-unavailable", "installation-unavailable", "authentication-required"):
                    self._sessions.pop(digest, None)
                raise

    def logout_extension(self, token, pairings, installation_id, credential, extension_origin):
        with self._lock:
            # Best effort for the exact old scoped token, including after a
            # reassignment/revocation. This never grants candidate access and
            # cannot delete a replacement token from a concurrent login.
            session = self._sessions.get(self._digest(token))
            if (session is None or session.audience != "extension"
                    or session.extension_scope.installationId != installation_id):
                raise authentication_required()
            extension = (pairings, installation_id, credential, extension_origin)
            with self._extension_transaction(extension, session.user_id, logout_only=True) as (_, context, _):
                scope = session.extension_scope
                if any(context[key] != getattr(scope, key) for key in
                       ("backendId", "workspaceId", "installationId", "bindingId", "extensionOrigin")):
                    raise authentication_required()
                self._sessions.pop(self._digest(token), None)

    def revoke_installation(self, installation_id, *, binding_revision=None, revoked=False):
        # Management calls this AFTER committing and releasing private locks.
        # A delayed callback must preserve sessions issued under a newer binding.
        with self._lock:
            for digest, session in list(self._sessions.items()):
                if (session.audience == "extension" and session.extension_scope.installationId == installation_id
                        and (revoked or binding_revision is None or session.extension_scope.bindingRevision < binding_revision)):
                    del self._sessions[digest]

    def revoke_all(self):
        with self._lock:
            self._sessions.clear()
            self._revocation_serial += 1
