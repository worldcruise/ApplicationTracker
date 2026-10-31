"""Only three pre-login extension endpoints; no owner/business API fallback."""
import hmac
import json
import re
from urllib.parse import urlsplit

from . import auth_http, pairing_http
from tracker_config.auth import AuthError, TOKEN_PATTERN
from tracker_config.models import ConfigurationError, RevisionConflict
from tracker_config.repositories import ConfigurationRepositories


PREFIX = "/api/extension/"
CLAIM = re.compile(r"/api/extension/pairings/([0-9a-f]{32})/claim")
HEADERS = {"content-type", "x-tracker-token", "x-pairing-exchange"}


def is_enrollment_request(target):
    try:
        path = urlsplit(target).path
    except ValueError:
        return False
    return path in (PREFIX + "bootstrap", PREFIX + "pairings") or bool(CLAIM.fullmatch(path))


def _send(handler, status, data=None, *, origin=None, preflight=False, retry_after=None, allow=None):
    body = b"" if data is None else json.dumps(data, ensure_ascii=True, allow_nan=False).encode("utf-8")
    handler.close_connection = True
    handler.send_response(status)
    for name, value in (("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(body))),
                        ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                        ("Connection", "close"), ("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")):
        handler.send_header(name, value)
    if origin is not None:
        handler.send_header("Access-Control-Allow-Origin", origin)
        if preflight:
            handler.send_header("Access-Control-Allow-Methods", "POST")
            handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Tracker-Token, X-Pairing-Exchange")
    if retry_after is not None:
        handler.send_header("Retry-After", str(retry_after))
    if allow:
        handler.send_header("Allow", allow)
    handler.end_headers()
    if getattr(handler, "command", "") != "HEAD":
        handler.wfile.write(body)


def _guard(handler, method, directory, *, allow_authorization=False):
    headers = handler.headers
    for name in ("Host", "Origin", "Content-Length", "Content-Type", "X-Tracker-Token", "X-Pairing-Exchange",
                 "Cookie", "Authorization", "Access-Control-Request-Method", "Access-Control-Request-Headers"):
        if len(headers.get_all(name, [])) > 1:
            raise AuthError(400, "invalid-request", "Duplicate enrollment headers are not supported.")
    if headers.get("Transfer-Encoding") is not None or headers.get("Expect") is not None:
        raise AuthError(400, "invalid-request", "Unsupported enrollment request framing.")
    expected_host = f"127.0.0.1:{handler.server.server_port}"
    if headers.get("Host") != expected_host:
        raise AuthError(403, "invalid-host", "Invalid host.")
    parsed = urlsplit(handler.path)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise AuthError(400, "invalid-request", "Enrollment URLs do not accept parameters or credentials.")
    forbidden = ("Cookie", "Proxy-Authorization") if allow_authorization else ("Cookie", "Authorization", "Proxy-Authorization")
    if any(headers.get(name) is not None for name in forbidden):
        raise AuthError(400, "credentials-not-allowed", "Enrollment requests must omit credentials.")
    device = ConfigurationRepositories(directory).extension_device.read().data
    extension_id = device.get("extensionId", "")
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise AuthError(503, "enrollment-setup-required", "Configure the installed extension in Web Extension Studio first.")
    origin = "chrome-extension://" + extension_id
    if headers.get("Origin") != origin:
        raise AuthError(403, "invalid-origin", "Invalid extension origin.")
    length = headers.get("Content-Length")
    if length is not None and not re.fullmatch(r"[0-9]{1,10}", length):
        raise AuthError(400, "invalid-request", "Invalid request length.")
    if method != "POST" and int(length or "0"):
        raise AuthError(400, "invalid-request", "Unexpected enrollment request body.")
    return origin, device


def _unready(state):
    return {"protocolVersion": 1, "state": state, "backendId": None, "workspaceId": None, "requestToken": None}


def handle_request(handler, method, directory):
    if not is_enrollment_request(handler.path):
        return False
    origin = None
    try:
        origin, device = _guard(handler, method, directory)
        path = urlsplit(handler.path).path
        bootstrap = path == PREFIX + "bootstrap"
        if method == "OPTIONS" and not bootstrap:
            requested = handler.headers.get("Access-Control-Request-Headers", "")
            names = [name.strip().lower() for name in requested.split(",") if name.strip()]
            if (handler.headers.get("Access-Control-Request-Method") != "POST" or not names
                    or len(names) != len(set(names)) or set(names) - HEADERS
                    or handler.headers.get("Access-Control-Request-Private-Network") is not None):
                raise AuthError(403, "preflight-denied", "Unsupported enrollment preflight.")
            _send(handler, 204, origin=origin, preflight=True)
            return True
        allowed = "GET" if bootstrap else "POST"
        if method != allowed:
            _send(handler, 405, {"code": "method-not-allowed", "error": "Method not allowed."}, origin=origin, allow=allowed)
            return True
        # Read-only discovery: never provision owner storage or a device ID.
        if not device.get("id"):
            if bootstrap:
                _send(handler, 200, _unready("setup-required"), origin=origin)
                return True
            raise AuthError(503, "enrollment-setup-required", "Save Web Extension Studio device settings first.")
        service = pairing_http.service_for(handler, directory)
        try:
            context = service.enrollment_bootstrap()
        except FileNotFoundError:
            if bootstrap:
                _send(handler, 200, _unready("setup-required"), origin=origin)
                return True
            raise AuthError(503, "enrollment-setup-required", "Initialize the local owner explicitly before enrollment.") from None
        if bootstrap:
            _send(handler, 200, context, origin=origin)
            return True
        token = handler.headers.get("X-Tracker-Token", "")
        if not TOKEN_PATTERN.fullmatch(token) or not hmac.compare_digest(token, context["requestToken"]):
            raise AuthError(403, "invalid-request-token", "Refresh enrollment bootstrap before retrying explicitly.")
        secret = handler.headers.get("X-Pairing-Exchange")
        service._secret_digest(secret)
        payload = auth_http._payload(handler, "POST")
        if path == PREFIX + "pairings":
            if set(payload) != {"protocolVersion", "label"} or type(payload["protocolVersion"]) is not int or payload["protocolVersion"] != 1:
                raise AuthError(400, "invalid-request", "Provide protocolVersion 1 and a browser label only.")
            result = service.request_enrollment(payload["label"], origin, secret)
            _send(handler, 201, {"pairingId": result["id"], "approvalCode": result["approvalCode"],
                                 "status": result["state"], "expiresAt": result["expiresAt"]}, origin=origin)
        else:
            if payload:
                raise AuthError(400, "invalid-request", "Claim requires an empty JSON object.")
            result = service.claim_enrollment(CLAIM.fullmatch(path)[1], origin, secret)
            if result["state"] == "pending":
                _send(handler, 202, {"status": "pending"}, origin=origin)
            else:
                # One binding per installation; reuse its existing stable ID.
                response = {key: result[key] for key in ("installationCredential", "installationId", "bindingRevision", "backendId", "workspaceId")}
                response["bindingId"] = result["installationId"]
                _send(handler, 200, response, origin=origin)
    except (BrokenPipeError, ConnectionResetError):
        # A committed claim remains consumed even when its response cannot be
        # delivered. Do not attempt a second response or expose a traceback.
        handler.close_connection = True
    except AuthError as error:
        if method == "GET" and error.status == 503 and origin is not None:
            _send(handler, 503, _unready("unavailable"), origin=origin)
        else:
            _send(handler, error.status, {"code": error.code, "error": error.message}, origin=origin, retry_after=error.retry_after)
    except (ConfigurationError, OSError, RecursionError, RevisionConflict):
        _send(handler, 503, _unready("unavailable") if method == "GET" else
              {"code": "enrollment-unavailable", "error": "Enrollment storage is unavailable; no automatic recovery was performed."}, origin=origin)
    except Exception:
        _send(handler, 500, {"code": "enrollment-failed", "error": "Enrollment failed; do not replay an uncertain claim."}, origin=origin)
    return True
