"""Private browser bindings and process-local, one-use enrollment exchanges.

No provisioning, file access or credentials are created on import/construction.
Management callers supply an owner ID from a verified backend session. The
dedicated enrollment methods scope requests to existing private installation
state; they never authenticate an owner or grant business access.
"""
from collections import OrderedDict, deque
from contextlib import contextmanager
import base64
import copy
import datetime as dt
import hashlib
import hmac
import re
import secrets
import threading
import time
import uuid

from .auth import AuthError, TOKEN_PATTERN
from .models import ConfigurationError, RevisionConflict, allowed_fields, identifier, require, timestamp, version_one
from .repositories import JsonRepository, _lock
from .security import UUID_HEX


PAIRING_SECONDS = 300
MAX_PENDING = 32
MAX_INSTALLATIONS = 256
ORIGIN = re.compile(r"chrome-extension://[a-p]{32}")
DIGEST = re.compile(r"[0-9a-f]{64}")


def validate_bindings(value):
    require(isinstance(value, dict), "Browser bindings must be an object.")
    version_one(value, "browser bindings")
    allowed_fields(value, ("schemaVersion", "installations"), "Browser bindings")
    rows = value.get("installations")
    require(isinstance(rows, list) and len(rows) <= MAX_INSTALLATIONS, "Invalid browser installation list.")
    seen, exchanges = set(), set()
    for row in rows:
        require(isinstance(row, dict), "Browser installation must be an object.")
        fields = ("id", "pairingId", "ownerId", "backendId", "workspaceId", "candidateId", "extensionOrigin", "label",
                  "bindingRevision", "revoked", "credentialDigest", "authEpoch", "authGeneration", "createdAt", "updatedAt")
        allowed_fields(row, fields, "Browser installation")
        require(set(row) == set(fields), "Browser installation fields are incomplete.")
        for field in ("id", "pairingId", "ownerId", "backendId", "authEpoch"):
            require(isinstance(row[field], str) and bool(UUID_HEX.fullmatch(row[field])), f"Invalid installation {field}.")
        require(row["id"] not in seen, "Duplicate installation ID.")
        require(row["pairingId"] not in exchanges, "Pairing exchange already claimed.")
        seen.add(row["id"])
        exchanges.add(row["pairingId"])
        identifier(row["candidateId"], "candidateId")
        identifier(row["workspaceId"], "workspaceId")
        require(isinstance(row["extensionOrigin"], str) and bool(ORIGIN.fullmatch(row["extensionOrigin"])), "Invalid extension origin.")
        require(isinstance(row["label"], str) and 1 <= len(row["label"]) <= 80 and row["label"] == row["label"].strip()
                and all(ord(char) >= 32 for char in row["label"]), "Invalid browser label.")
        for field in ("bindingRevision", "authGeneration"):
            require(type(row[field]) is int and 1 <= row[field] < 2**53, f"Invalid {field}.")
        require(type(row["revoked"]) is bool, "Invalid installation revocation state.")
        require(isinstance(row["credentialDigest"], str) and bool(DIGEST.fullmatch(row["credentialDigest"])), "Invalid installation credential digest.")
        require(timestamp(row["updatedAt"], "updatedAt") >= timestamp(row["createdAt"], "createdAt"), "Installation dates are inconsistent.")


class BrowserBindingRepository:
    def __init__(self, owner_repository):
        self.owner = owner_repository
        self.path = self.owner.directory / "browser-bindings.json"
        self.record = JsonRepository(self.path, validate_bindings,
                                     lambda: {"schemaVersion": 1, "installations": []}, atomic_writer=self._write)

    def _validate_files(self):
        self.owner.location.inspect(self.owner.permissions)
        for path in (self.path, self.record.backup_path):
            self.owner.permissions.validate(path, missing_ok=True)

    def _write(self, path, content, *, before_replace=None):
        def checked():
            self._validate_files()
            if before_replace:
                before_replace()
        self.owner._write(path, content, before_replace=checked)

    @contextmanager
    def transaction(self, owner_id):
        # Shared owner lock serializes reset/recovery with binding writes. The
        # same process/native locks and private atomic writer protect both stores.
        with self.owner._guard():
            security = self.owner._record.read(missing_ok=False).data
            owner = security["users"][0]
            if owner["disabled"] or owner["id"] != owner_id:
                raise AuthError(403, "access-denied", "Verified installation owner required.")
            # The owner guard already holds the cross-process private-store
            # lock (a directory flock on POSIX); do not acquire it twice.
            with _lock(self.path):
                self._validate_files()
                if self.record.backup_path.exists():
                    JsonRepository(self.record.backup_path, validate_bindings).read(missing_ok=False)
                    if not self.path.exists():
                        raise ConfigurationError("Browser binding primary is missing; explicit offline recovery is required.")
                yield security, self.record.read()


class BrowserPairingService:
    def __init__(self, repository, candidates, workspace_id, extension_origin, *, clock=time.monotonic,
                 utcnow=lambda: dt.datetime.now(dt.timezone.utc)):
        identifier(workspace_id, "workspaceId")
        require(isinstance(extension_origin, str) and bool(ORIGIN.fullmatch(extension_origin)), "Save a valid extension ID before pairing.")
        self.repository, self.candidates = repository, candidates
        self.workspace_id, self.extension_origin = workspace_id, extension_origin
        self.clock, self.utcnow = clock, utcnow
        # Separate from the web manager's CSRF token and owner sessions.
        self.enrollment_request_token = secrets.token_urlsafe(32)
        self._lock = threading.RLock()
        self._requests = OrderedDict()
        self._attempts = deque()

    def _enrollment_owner(self):
        """Scope enrollment to this installation; this is NOT owner login."""
        security = self.repository.owner.read().data
        if security["users"][0]["disabled"]:
            raise AuthError(503, "enrollment-unavailable", "Owner enrollment is unavailable.")
        return security["users"][0]["id"]

    def enrollment_bootstrap(self):
        with self.repository.transaction(self._enrollment_owner()) as (security, _):
            return {"protocolVersion": 1, "state": "ready", "backendId": security["backendId"],
                    "workspaceId": self.workspace_id, "requestToken": self.enrollment_request_token}

    def request_enrollment(self, label, extension_origin, exchange_secret):
        return self.create(self._enrollment_owner(), label, extension_origin, exchange_secret)

    def claim_enrollment(self, request_id, extension_origin, exchange_secret):
        if extension_origin != self.extension_origin:
            raise AuthError(403, "extension-origin-denied", "Invalid enrollment origin.")
        return self.claim(self._enrollment_owner(), request_id, exchange_secret, extension_origin=extension_origin)

    @staticmethod
    def _secret_digest(secret):
        if not isinstance(secret, str) or not TOKEN_PATTERN.fullmatch(secret):
            raise AuthError(400, "invalid-request", "Provide a 32-byte URL-safe exchange credential.")
        raw = base64.urlsafe_b64decode(secret + "=")
        if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != secret:
            raise AuthError(400, "invalid-request", "Provide a canonical 32-byte URL-safe exchange credential.")
        return hashlib.sha256(secret.encode("ascii")).hexdigest()

    @staticmethod
    def _identity(security):
        return (security["users"][0]["id"], security["backendId"], security["authEpoch"], security["users"][0]["authGeneration"])

    def _candidate(self, candidate_id):
        try:
            identifier(candidate_id, "candidateId")
            return self.candidates.get(candidate_id)
        except ConfigurationError:
            raise AuthError(400, "invalid-candidate", "Select an existing authorized candidate.") from None

    def _active(self, row, security):
        return (not row["revoked"] and row["extensionOrigin"] == self.extension_origin
                and (row["ownerId"], row["backendId"], row["authEpoch"], row["authGeneration"]) == self._identity(security))

    def _in_scope(self, row, security):
        return (row["ownerId"], row["backendId"], row["workspaceId"]) == (security["users"][0]["id"], security["backendId"], self.workspace_id)

    def _request(self, request_id, security):
        request = self._requests.get(request_id)
        if request is None:
            raise AuthError(404, "pairing-not-found", "Pairing request not found; start a new exchange.")
        if self.clock() >= request["deadline"] or request["identity"] != self._identity(security):
            raise AuthError(410, "pairing-expired", "Pairing expired; start a new exchange.")
        return request

    @staticmethod
    def _request_view(request):
        return {key: copy.deepcopy(request[key]) for key in ("id", "label", "extensionOrigin", "approvalCode", "state", "revision", "expiresAt", "candidateId")}

    def _installation_view(self, row, security):
        result = {key: copy.deepcopy(row[key]) for key in ("id", "pairingId", "label", "ownerId", "backendId", "workspaceId", "candidateId", "extensionOrigin", "bindingRevision", "revoked", "createdAt", "updatedAt")}
        try:
            result["candidateName"] = self._candidate(row["candidateId"])["name"]
        except AuthError:
            result["candidateName"] = None
        result["usable"] = self._active(row, security) and result["candidateName"] is not None
        return result

    def _list(self, security, snapshot):
        requests = [self._request_view(row) for row in self._requests.values()
                    if row["state"] in ("pending", "approved") and self.clock() < row["deadline"] and row["identity"] == self._identity(security)]
        return {"workspaceId": self.workspace_id, "backendId": security["backendId"], "requests": requests,
                "installations": [self._installation_view(row, security) for row in snapshot.data["installations"] if self._in_scope(row, security)],
                "candidates": [{"id": row["id"], "name": row["name"]} for row in self.candidates.read().data["candidates"]]}

    def listing(self, owner_id):
        with self._lock, self.repository.transaction(owner_id) as (security, snapshot):
            return self._list(security, snapshot)

    def create(self, owner_id, label, extension_origin, exchange_secret):
        if (not isinstance(label, str) or not 1 <= len(label.strip()) <= 80
                or any(ord(char) < 32 for char in label)):
            raise AuthError(400, "invalid-request", "Browser label must contain 1–80 printable characters.")
        try:
            label.encode("utf-8")
        except UnicodeError:
            raise AuthError(400, "invalid-request", "Browser label must be valid UTF-8 text.") from None
        if extension_origin != self.extension_origin:
            raise AuthError(403, "extension-origin-denied", "The browser origin must match the saved extension ID.")
        digest = self._secret_digest(exchange_secret)
        with self._lock, self.repository.transaction(owner_id) as (security, _):
            now = self.clock()
            while self._attempts and now >= self._attempts[0] + PAIRING_SECONDS:
                self._attempts.popleft()
            if len(self._attempts) >= 10:
                raise AuthError(429, "rate-limited", "Too many pairing requests; wait five minutes.", retry_after=300)
            self._attempts.append(now)
            if sum(row["state"] in ("pending", "approved") and now < row["deadline"] for row in self._requests.values()) >= MAX_PENDING:
                raise AuthError(429, "pairing-capacity", "Too many pending browser requests.")
            # Bound terminal tombstones; unknown/removed IDs still cannot replay.
            while len(self._requests) >= 128:
                removable = next((key for key, row in self._requests.items() if row["state"] in ("claimed", "denied") or now >= row["deadline"]), None)
                if removable is None:
                    raise AuthError(429, "pairing-capacity", "Pairing capacity reached.")
                del self._requests[removable]
            code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
            request = {"id": uuid.uuid4().hex, "label": label.strip(), "extensionOrigin": extension_origin,
                       "approvalCode": code[:4] + "-" + code[4:], "state": "pending", "revision": 1,
                       "expiresAt": (self.utcnow() + dt.timedelta(seconds=PAIRING_SECONDS)).isoformat(),
                       "candidateId": None, "deadline": now + PAIRING_SECONDS, "identity": self._identity(security), "exchangeDigest": digest}
            self._requests[request["id"]] = request
            return self._request_view(request)

    @staticmethod
    def _revision(actual, expected):
        if type(expected) is not int or not 1 <= expected < 2**53:
            raise AuthError(400, "invalid-request", "Provide a positive integer revision.")
        if actual != expected:
            raise RevisionConflict("Browser pairing or binding changed; refresh before continuing.")

    def decide(self, owner_id, request_id, *, revision, candidate_id=None, approve=False):
        with self._lock, self.repository.transaction(owner_id) as (security, _):
            request = self._request(request_id, security)
            self._revision(request["revision"], revision)
            if request["state"] not in ("pending", "approved"):
                raise AuthError(409, "pairing-consumed", "This request has already been consumed or denied.")
            if approve:
                self._candidate(candidate_id)
            request.update(state="approved" if approve else "denied", candidateId=candidate_id if approve else None, revision=revision + 1)
            return self._request_view(request)

    def claim(self, owner_id, request_id, exchange_secret, *, extension_origin=None):
        digest = self._secret_digest(exchange_secret)
        with self._lock, self.repository.transaction(owner_id) as (security, snapshot):
            request = self._request(request_id, security)
            if extension_origin is not None and extension_origin != request["extensionOrigin"]:
                raise AuthError(403, "extension-origin-denied", "Invalid enrollment origin.")
            if not hmac.compare_digest(digest, request["exchangeDigest"]):
                raise AuthError(403, "invalid-exchange", "Invalid pairing exchange.")
            # The durable claim marker and credential digest share one atomic
            # record write. A post-commit response/write failure cannot reissue.
            if any(row["pairingId"] == request_id for row in snapshot.data["installations"]):
                request.update(state="claimed")
                raise AuthError(409, "pairing-consumed", "This exchange is already committed. Revoke/re-pair if its credential was not received.")
            if request["state"] == "pending":
                return {"state": "pending"}
            if request["state"] != "approved":
                raise AuthError(409, "pairing-consumed", "This request has already been consumed or denied.")
            self._candidate(request["candidateId"])
            if len(snapshot.data["installations"]) >= MAX_INSTALLATIONS:
                raise AuthError(409, "installation-capacity", "Installation capacity reached; administrative review required.")
            for _ in range(5):
                credential = secrets.token_urlsafe(32)
                if all(row["credentialDigest"] != self._secret_digest(credential) for row in snapshot.data["installations"]):
                    break
            else:
                raise AuthError(503, "pairing-unavailable", "A unique installation credential could not be issued.")
            owner_id, backend_id, epoch, generation = self._identity(security)
            now = self.utcnow().isoformat()
            row = {"id": uuid.uuid4().hex, "pairingId": request_id, "ownerId": owner_id, "backendId": backend_id, "workspaceId": self.workspace_id,
                   "candidateId": request["candidateId"], "extensionOrigin": self.extension_origin, "label": request["label"],
                   "bindingRevision": 1, "revoked": False, "credentialDigest": self._secret_digest(credential),
                   "authEpoch": epoch, "authGeneration": generation, "createdAt": now, "updatedAt": now}
            snapshot.data["installations"].append(row)
            self.repository.record.save(snapshot.data, expected_revision=snapshot.revision)
            request.update(state="claimed", revision=request["revision"] + 1)
            return {"state": "claimed", "installationId": row["id"], "installationCredential": credential,
                    "bindingRevision": 1, "candidateId": row["candidateId"], "backendId": backend_id, "workspaceId": self.workspace_id}

    def update_binding(self, owner_id, installation_id, *, revision, candidate_id=None, revoke=False):
        with self._lock, self.repository.transaction(owner_id) as (security, snapshot):
            row = next((row for row in snapshot.data["installations"] if row["id"] == installation_id and self._in_scope(row, security)), None)
            if row is None:
                raise AuthError(404, "installation-not-found", "Browser installation not found.")
            self._revision(row["bindingRevision"], revision)
            if not revoke:
                if not self._active(row, security):
                    raise AuthError(403, "installation-revoked", "Pair this browser again before assigning a candidate.")
                self._candidate(candidate_id)
                if candidate_id == row["candidateId"]:
                    return self._installation_view(row, security)
                row["candidateId"] = candidate_id
            elif row["revoked"]:
                return self._installation_view(row, security)
            row["revoked"] = revoke
            row["bindingRevision"] += 1
            row["updatedAt"] = max(row["createdAt"], self.utcnow().isoformat())
            self.repository.record.save(snapshot.data, expected_revision=snapshot.revision)
            return self._installation_view(row, security)

    def authorize_installation(self, owner_id, installation_id, credential, binding_revision):
        """Future authenticated operations MUST revalidate this context per request.

        A pairing credential alone is not an owner login or session credential.
        """
        digest = self._secret_digest(credential)
        with self._lock, self.repository.transaction(owner_id) as (security, snapshot):
            row = next((row for row in snapshot.data["installations"] if row["id"] == installation_id and self._in_scope(row, security)), None)
            if row is None or not hmac.compare_digest(row["credentialDigest"], digest) or not self._active(row, security):
                raise AuthError(403, "installation-revoked", "Browser installation is unavailable or revoked.")
            self._revision(row["bindingRevision"], binding_revision)
            self._candidate(row["candidateId"])
            return self._installation_view(row, security)

    @contextmanager
    def installation_context(self, owner_id, installation_id, credential, extension_origin, *, logout_only=False):
        """Hold the private transaction through an authentication decision.

        Callers acquire their AuthService lock first. Never call back into the
        AuthService while these repository locks are held. Logout permits only
        proof of the original installation, not access through a stale binding.
        """
        if extension_origin != self.extension_origin:
            raise AuthError(403, "invalid-origin", "Invalid extension origin.")
        try:
            digest = self._secret_digest(credential)
        except AuthError:
            raise AuthError(403, "installation-unavailable", "Browser installation authorization is unavailable.") from None
        with self._lock, self.repository.transaction(owner_id) as (security, snapshot):
            row = next((item for item in snapshot.data["installations"]
                        if item["id"] == installation_id and self._in_scope(item, security)), None)
            if (row is None or row["extensionOrigin"] != extension_origin
                    or not hmac.compare_digest(row["credentialDigest"], digest)
                    or (not logout_only and not self._active(row, security))):
                raise AuthError(403, "installation-unavailable", "Browser installation authorization is unavailable.")
            candidate = None
            if not logout_only:
                try:
                    candidate = self.candidates.get(row["candidateId"])
                except ConfigurationError:
                    raise AuthError(403, "candidate-unavailable", "The assigned candidate is unavailable. Review the binding in Web Extension Studio.") from None
            context = {"backendId": row["backendId"], "workspaceId": row["workspaceId"],
                       "installationId": row["id"], "bindingId": row["id"], "candidateId": row["candidateId"],
                       "bindingRevision": row["bindingRevision"], "extensionOrigin": row["extensionOrigin"]}
            yield security, context, candidate
