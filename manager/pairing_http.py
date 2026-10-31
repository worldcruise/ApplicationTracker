"""Owner-authenticated pairing administration; no public enrollment exception."""
import re
import threading
from urllib.parse import urlsplit

from . import auth_http
from tracker_config.auth import AuthError
from tracker_config.browser_bindings import BrowserBindingRepository, BrowserPairingService
from tracker_config.models import ConfigurationError, RevisionConflict
from tracker_config.repositories import ConfigurationRepositories


PREFIX = "/api/studio/extension/"
SERVICE_LOCK = threading.RLock()


def is_pairing_request(target):
    try:
        path = urlsplit(target).path
    except ValueError:
        path = target
    return path.startswith((PREFIX + "pairings", PREFIX + "installations"))


def service_for(handler, config_directory):
    device = ConfigurationRepositories(config_directory).extension_device.read().data
    if not device.get("id") or not re.fullmatch(r"[a-p]{32}", device.get("extensionId", "")):
        raise AuthError(409, "pairing-setup-required", "Save local device settings and a valid extension ID before managing browser pairings.")
    key = (device["id"], device["extensionId"])
    with SERVICE_LOCK:
        if getattr(handler.server, "pairing_service_key", None) != key:
            handler.server.pairing_service = BrowserPairingService(
                BrowserBindingRepository(handler.server.auth_service.repository),
                ConfigurationRepositories(config_directory).candidates, key[0], "chrome-extension://" + key[1])
            handler.server.pairing_service_key = key
        return handler.server.pairing_service


def handle_request(handler, method, config_directory):
    if not is_pairing_request(handler.path):
        return False
    try:
        parsed = urlsplit(handler.path)
        if parsed.query or parsed.fragment or parsed.scheme or parsed.netloc:
            raise AuthError(400, "invalid-request", "Pairing endpoints do not accept URL parameters.")
        match = re.fullmatch(r"/api/studio/extension/(pairings|installations)(?:/([0-9a-f]{32})/(approve|deny|claim|binding|revoke))?", parsed.path)
        if not match:
            raise AuthError(404, "not-found", "Pairing endpoint not found.")
        kind, record_id, action = match.groups()
        allowed = ("GET", "POST") if kind == "pairings" and not record_id else ("GET",) if not record_id else ("PUT",) if action == "binding" else ("POST",)
        if ((kind == "pairings" and action in ("binding", "revoke"))
                or (kind == "installations" and action in ("approve", "deny", "claim"))):
            raise AuthError(404, "not-found", "Pairing endpoint not found.")
        if method not in allowed:
            auth_http.send_error(handler, AuthError(405, "method-not-allowed", "Method not allowed."), allow=", ".join(allowed))
            return True
        if kind == "pairings" and ((method == "POST" and record_id is None) or action == "claim"):
            raise AuthError(410, "enrollment-route-retired", "Use the extension-origin /api/extension enrollment transport. Web routes cannot issue installation credentials.")
        # The central manager gate has already checked Host/Origin/framing/CSRF
        # and owner login. Reuse strict bounded JSON parsing for enrollment data.
        payload = auth_http._payload(handler, "POST" if method in ("POST", "PUT") else "GET")
        required = ({"candidateId", "revision"} if action in ("approve", "binding")
                    else {"revision"} if action in ("deny", "revoke") else set())
        if payload is not None and set(payload) != required:
            raise AuthError(400, "invalid-request", "Provide only the documented pairing fields.")
        service = service_for(handler, config_directory)
        owner_id = handler.owner_context["id"]
        status = 200
        if method == "GET":
            result = service.listing(owner_id)
        elif action in ("approve", "deny"):
            result = service.decide(owner_id, record_id, revision=payload["revision"],
                                    candidate_id=payload.get("candidateId"), approve=action == "approve")
        else:
            result = service.update_binding(owner_id, record_id, revision=payload["revision"],
                                            candidate_id=payload.get("candidateId"), revoke=action == "revoke")
            # update_binding has committed and released all private locks.
            # Revalidation on every extension request remains authoritative.
            handler.server.auth_service.revoke_installation(
                record_id, binding_revision=result["bindingRevision"], revoked=result["revoked"])
        auth_http.send_response(handler, status, result)
    except AuthError as error:
        auth_http.send_error(handler, error)
    except RevisionConflict:
        auth_http.send_error(handler, AuthError(409, "revision-conflict", "Pairing or binding changed; refresh and review before retrying."))
    except (ConfigurationError, OSError, RecursionError):
        auth_http.send_error(handler, AuthError(503, "pairing-unavailable", "Private pairing storage is unavailable. Review its configuration; no automatic recovery was performed."))
    except Exception:
        auth_http.send_error(handler, AuthError(500, "pairing-failed", "Pairing operation failed. Refresh and review before retrying."))
    return True
