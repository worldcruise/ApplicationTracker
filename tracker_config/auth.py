"""Process-local owner authentication. No filesystem work or credentials on import."""
from collections import deque
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
        self._attempt()
        validate_credentials(username, password)
        if not self._verifications.acquire(blocking=False):
            raise AuthError(429, "rate-limited", "Too many sign-in attempts. Try again later.", retry_after=1)
        try:
            with self._lock:
                snapshot = self._security()
                serial = self._revocation_serial
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
                if current.revision != snapshot.revision or serial != self._revocation_serial:
                    raise invalid_credentials()
                now = self.clock()
                self._prune(now, current.data)
                previous = self._digest(previous_token)
                if len(self._sessions) >= MAX_SESSIONS and previous not in self._sessions:
                    raise AuthError(503, "session-capacity", "Session capacity reached. Sign out an existing session or wait for expiration.")
                for _ in range(5):
                    token = secrets.token_urlsafe(32)
                    digest = self._digest(token)
                    if digest is not None and digest not in self._sessions:
                        break
                else:
                    raise AuthError(503, "authentication-unavailable", "A fresh session could not be issued.")
                session = _Session(*self._binding(snapshot.data), now, now)
                self._sessions[digest] = session
                self._sessions.pop(previous, None)
                return IssuedSession(token, self._metadata(session, owner, now))
        finally:
            self._verifications.release()

    def session(self, token, *, touch=False):
        with self._lock:
            snapshot = self._security()
            now = self.clock()
            self._prune(now, snapshot.data)
            session = self._sessions.get(self._digest(token))
            if session is None:
                raise authentication_required()
            if touch:
                session.last_activity = now
            return self._metadata(session, snapshot.data["users"][0], now)

    def logout(self, token):
        with self._lock:
            self._sessions.pop(self._digest(token), None)

    def revoke_all(self):
        with self._lock:
            self._sessions.clear()
            self._revocation_serial += 1
