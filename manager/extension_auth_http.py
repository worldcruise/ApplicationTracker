"""Exact installation-scoped authentication routes, separate from web cookies."""
import hmac
import json
import re
from urllib.parse import urlsplit

from . import auth_http, enrollment_http, pairing_http
from tracker_config.auth import AuthError, TOKEN_PATTERN
from tracker_config.models import ConfigurationError, identifier
from tracker_config.security import UUID_HEX


PREFIX = "/api/extension/auth"
ROUTES = {PREFIX + "/login": "POST", PREFIX + "/session": "GET",
          PREFIX + "/activity": "POST", PREFIX + "/logout": "POST"}
PROOF_HEADERS = {"x-tracker-installation-id", "x-tracker-installation-credential"}
BEARER = re.compile(r"Bearer ([A-Za-z0-9_-]{43})")


def is_auth_request(target):
    try:
        path = urlsplit(target).path
        return path == PREFIX or path.startswith(PREFIX + "/")
    except ValueError:
        return target.startswith(PREFIX)


def _send(handler, status, data=None, *, origin=None, method=None, headers=None, retry_after=None, allow=None):
    body = b"" if data is None else json.dumps(data, ensure_ascii=True, allow_nan=False).encode("utf-8")
    handler.close_connection = True
    handler.send_response(status)
    for name, value in (("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(body))),
                        ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                        ("Connection", "close"), ("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")):
        handler.send_header(name, value)
    if origin is not None:
        handler.send_header("Access-Control-Allow-Origin", origin)
        if method:
            handler.send_header("Access-Control-Allow-Methods", method)
            handler.send_header("Access-Control-Allow-Headers", ", ".join(sorted(headers)))
    if retry_after is not None:
        handler.send_header("Retry-After", str(retry_after))
    if allow:
        handler.send_header("Allow", allow)
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(body)


def _metadata(value):
    """Validate and project responses, never serialize a session/store record."""
    if set(value) != {"authenticated", "user", "session", "context"}:
        raise ValueError("Invalid extension metadata.")
    session = value["session"]
    if set(session) != {"audience", "idleRemainingSeconds", "absoluteRemainingSeconds"} or session["audience"] != "extension":
        raise ValueError("Invalid extension session.")
    result = auth_http._safe_metadata({"authenticated": value["authenticated"], "user": value["user"],
                                      "session": {key: session[key] for key in ("idleRemainingSeconds", "absoluteRemainingSeconds")}})
    context = value["context"]
    if (set(context) != {"backendId", "workspaceId", "installationId", "bindingId", "bindingRevision", "extensionOrigin", "candidate"}
            or any(not isinstance(context[key], str) or not UUID_HEX.fullmatch(context[key])
                   for key in ("backendId", "installationId", "bindingId"))
            or context["installationId"] != context["bindingId"]
            or type(context["bindingRevision"]) is not int or not 1 <= context["bindingRevision"] < 2**53
            or not isinstance(context["extensionOrigin"], str)
            or not re.fullmatch(r"chrome-extension://[a-p]{32}", context["extensionOrigin"])
            or set(context["candidate"]) != {"id", "name"}
            or not isinstance(context["candidate"]["name"], str) or not context["candidate"]["name"].strip()):
        raise ValueError("Invalid extension context.")
    identifier(context["workspaceId"], "workspaceId")
    identifier(context["candidate"]["id"], "candidateId")
    result["session"]["audience"] = "extension"
    result["context"] = {**context, "candidate": dict(context["candidate"])}
    return result


def handle_request(handler, method, directory):
    if not is_auth_request(handler.path):
        return False
    origin = None
    try:
        for name in ("X-Tracker-Installation-Id", "X-Tracker-Installation-Credential"):
            if len(handler.headers.get_all(name, [])) > 1:
                raise AuthError(400, "invalid-request", "Duplicate installation headers are not supported.")
        origin, _ = enrollment_http._guard(handler, method, directory, allow_authorization=True)
        if handler.headers.get("X-Pairing-Exchange") is not None:
            raise AuthError(400, "invalid-request", "Pairing exchange credentials are not accepted for owner login.")
        path = urlsplit(handler.path).path
        allowed = ROUTES.get(path)
        if allowed is None:
            raise AuthError(404, "not-found", "Extension authentication endpoint not found.")
        login = path == PREFIX + "/login"
        permitted_headers = PROOF_HEADERS | ({"content-type", "x-tracker-token"} if allowed == "POST" else set())
        if not login:
            permitted_headers |= {"authorization"}
        if method == "OPTIONS":
            requested = handler.headers.get("Access-Control-Request-Headers", "")
            names = [name.strip().lower() for name in requested.split(",") if name.strip()]
            if (handler.headers.get("Access-Control-Request-Method") != allowed or not names
                    or len(names) != len(set(names)) or set(names) - permitted_headers
                    or handler.headers.get("Access-Control-Request-Private-Network") is not None):
                raise AuthError(403, "preflight-denied", "Unsupported extension authentication preflight.")
            _send(handler, 204, origin=origin, method=allowed, headers=permitted_headers)
            return True
        if method != allowed:
            _send(handler, 405, {"code": "method-not-allowed", "error": "Method not allowed."}, origin=origin, allow=allowed)
            return True
        payload = auth_http._payload(handler, method)
        if payload is not None and set(payload) != ({"username", "password"} if login else set()):
            raise AuthError(400, "invalid-request", "Provide only the documented extension authentication fields.")
        pairings = pairing_http.service_for(handler, directory)
        if method == "POST":
            token = handler.headers.get("X-Tracker-Token", "")
            if not TOKEN_PATTERN.fullmatch(token) or not hmac.compare_digest(token, pairings.enrollment_request_token):
                raise AuthError(403, "invalid-request-token", "Refresh backend bootstrap before retrying explicitly.")
        installation_id = handler.headers.get("X-Tracker-Installation-Id", "")
        credential = handler.headers.get("X-Tracker-Installation-Credential", "")
        if not UUID_HEX.fullmatch(installation_id) or not TOKEN_PATTERN.fullmatch(credential):
            raise AuthError(403, "installation-unavailable", "Browser installation authorization is unavailable.")
        authorization = handler.headers.get("Authorization")
        if login:
            if authorization is not None:
                raise AuthError(400, "invalid-request", "Owner login does not accept an existing bearer token.")
        elif not isinstance(authorization, str) or not BEARER.fullmatch(authorization):
            raise AuthError(401, "authentication-required", "Sign in to continue.")
        service = handler.server.auth_service
        proof = (pairings, installation_id, credential, origin)
        if login:
            issued = service.login_extension(payload["username"], payload["password"], *proof)
            result = _metadata(issued.metadata)
            if not TOKEN_PATTERN.fullmatch(issued.token):
                raise ValueError("Invalid issued session.")
            result["sessionToken"] = issued.token
        elif path == PREFIX + "/logout":
            service.logout_extension(BEARER.fullmatch(authorization)[1], *proof)
            result = {"authenticated": False}
        else:
            result = _metadata(service.extension_session(BEARER.fullmatch(authorization)[1], *proof,
                               touch=path == PREFIX + "/activity"))
        _send(handler, 200, result, origin=origin)
    except (BrokenPipeError, ConnectionResetError):
        # A response loss never triggers automatic session issuance/retry.
        handler.close_connection = True
    except AuthError as error:
        if error.code in ("pairing-setup-required", "enrollment-setup-required"):
            error = AuthError(503, "authentication-unavailable", "Configure the local extension service in Web Extension Studio first.")
        _send(handler, error.status, {"code": error.code, "error": error.message}, origin=origin, retry_after=error.retry_after)
    except (ConfigurationError, OSError, RecursionError):
        _send(handler, 503, {"code": "authentication-unavailable", "error": "Private authentication storage is unavailable."}, origin=origin)
    except Exception:
        # Never log an exception containing request credentials or raw headers.
        _send(handler, 503, {"code": "authentication-unavailable", "error": "Extension authentication is unavailable."}, origin=origin)
    return True
