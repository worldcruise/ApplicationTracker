"""Cookie transport and shared request/owner guards for the local manager."""
import hmac
import json
import re
import socket
from urllib.parse import urlsplit

from tracker_config.auth import AuthError, TOKEN_PATTERN
from tracker_config.repositories import _invalid_constant, _unique_object
from tracker_config.security import normalize_username, UUID_HEX


COOKIE_NAME = "tracker_owner_session"
COOKIE_SCOPE = "HttpOnly; SameSite=Strict; Path=/api/"
MAX_AUTH_BYTES = 8192
ROUTES = {
    "/api/auth/status": "GET", "/api/auth/login": "POST",
    "/api/auth/session": "GET", "/api/auth/activity": "POST", "/api/auth/logout": "POST",
}
JSON_TYPE = re.compile(r'application/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?', re.I)


def is_auth_request(target):
    try:
        path = urlsplit(target).path
        return path == "/api/auth" or path.startswith("/api/auth/")
    except ValueError:
        return target.startswith("/api/auth")


def _invalid(message="Invalid authentication request."):
    return AuthError(400, "invalid-request", message)


def _cookie(token=None):
    if token is not None and (not isinstance(token, str) or not TOKEN_PATTERN.fullmatch(token)):
        raise ValueError("Invalid issued session credential.")
    return f"{COOKIE_NAME}={token or ''}; {COOKIE_SCOPE}; Max-Age={28800 if token else 0}"


def send_response(handler, status, data, *, cookie=None, retry_after=None, allow=None):
    body = json.dumps(data, ensure_ascii=True, allow_nan=False).encode("utf-8")
    handler.close_connection = True
    handler.send_response(status)
    for name, value in (("Content-Type", "application/json; charset=utf-8"),
                        ("Content-Length", str(len(body))), ("Cache-Control", "no-store"),
                        ("X-Content-Type-Options", "nosniff"), ("Connection", "close")):
        handler.send_header(name, value)
    if cookie is not None:
        handler.send_header("Set-Cookie", cookie)
    if retry_after is not None:
        handler.send_header("Retry-After", str(retry_after))
    if allow:
        handler.send_header("Allow", allow)
    handler.end_headers()
    if getattr(handler, "command", "") != "HEAD":
        handler.wfile.write(body)


def send_error(handler, error, *, allow=None):
    send_response(handler, error.status, {"error": error.message, "code": error.code},
                  cookie=_cookie() if error.status == 401 else None,
                  retry_after=error.retry_after, allow=allow)


def check_request(handler, method, csrf_token):
    headers = handler.headers
    for name in ("Host", "Origin", "X-Tracker-Token", "Content-Length", "Content-Type", "Cookie"):
        values = headers.get_all(name, []) if hasattr(headers, "get_all") else ([headers[name]] if name in headers else [])
        if len(values) > 1:
            raise _invalid("Duplicate authentication request headers are not supported.")
    if headers.get("Transfer-Encoding") is not None or headers.get("Expect") is not None:
        raise _invalid("Unsupported authentication request framing.")
    unsafe = method not in ("GET", "HEAD", "OPTIONS")
    if not handler.check_local_request(write=unsafe, auth=True):
        return False
    parsed = urlsplit(handler.path)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        raise _invalid("Unsupported API request target.")
    expected_origin = f"http://127.0.0.1:{handler.server.server_port}"
    if headers.get("Origin") is not None and headers["Origin"] != expected_origin:
        raise AuthError(403, "invalid-origin", "Invalid origin.")
    if headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
        raise AuthError(403, "invalid-origin", "Invalid origin.")
    # The existing checker remains the shared Host/Origin authority. Its process
    # token is CSRF protection only, never an owner credential.
    if unsafe and not hmac.compare_digest(headers.get("X-Tracker-Token", ""), csrf_token):
        raise AuthError(403, "invalid-csrf", "Invalid request token.")
    length = headers.get("Content-Length")
    if length is not None and not re.fullmatch(r"[0-9]{1,10}", length):
        raise _invalid("Invalid request length.")
    if method in ("GET", "HEAD", "OPTIONS") and int(length or "0"):
        raise _invalid("Unexpected request body.")
    return True


def require_owner(handler):
    service = getattr(handler.server, "auth_service", None)
    if service is None:
        raise AuthError(503, "authentication-unavailable", "Owner authentication is unavailable.")
    metadata = _safe_metadata(service.session(_session_token(handler)))
    if metadata["user"]["role"] != "owner":
        raise AuthError(403, "access-denied", "Owner access required.")
    return metadata["user"]


def _payload(handler, method):
    length = handler.headers.get("Content-Length")
    if length is not None and not re.fullmatch(r"[0-9]{1,10}", length):
        raise _invalid("Invalid request length.")
    size = int(length or "0")
    if size > MAX_AUTH_BYTES or (method != "POST" and size != 0):
        raise _invalid("Authentication request is too large or has an unexpected body.")
    if method != "POST":
        return None
    if not size or not JSON_TYPE.fullmatch(handler.headers.get("Content-Type", "")):
        raise _invalid("Provide a nonempty application/json body encoded as UTF-8.")
    handler.connection.settimeout(5)
    try:
        raw = handler.rfile.read(size)
        if len(raw) != size:
            raise _invalid("Incomplete authentication request body.")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
    except (ValueError, UnicodeError, RecursionError, socket.timeout):
        raise _invalid("Provide valid UTF-8 JSON without duplicate properties.") from None
    if not isinstance(value, dict):
        raise _invalid("Expected a JSON object.")
    return value


def _session_token(handler):
    value = handler.headers.get("Cookie", "")
    found = []
    for field in value.split(";"):
        name, separator, token = field.strip().partition("=")
        if name == COOKIE_NAME:
            found.append(token if separator and TOKEN_PATTERN.fullmatch(token) else None)
    if len(found) > 1:
        raise _invalid("Duplicate owner session cookies are not supported.")
    return found[0] if found else None


def _safe_metadata(value):
    # Construct an explicit response projection: no session/store object can
    # accidentally expose its internal fields through JSON serialization.
    if (not isinstance(value, dict) or set(value) != {"authenticated", "user", "session"}
            or value["authenticated"] is not True):
        raise ValueError("Invalid session metadata.")
    user, session = value["user"], value["session"]
    if (not isinstance(user, dict) or set(user) != {"id", "username", "role"}
            or not isinstance(user["id"], str) or not UUID_HEX.fullmatch(user["id"])
            or normalize_username(user["username"]) != user["username"] or user["role"] != "owner"
            or not isinstance(session, dict) or set(session) != {"idleRemainingSeconds", "absoluteRemainingSeconds"}
            or any(type(session[key]) is not int or not 1 <= session[key] <= maximum for key, maximum in
                   (("idleRemainingSeconds", 1800), ("absoluteRemainingSeconds", 28800)))):
        raise ValueError("Invalid session metadata.")
    return {
        "authenticated": True,
        "user": {key: value["user"][key] for key in ("id", "username", "role")},
        "session": {key: value["session"][key] for key in ("idleRemainingSeconds", "absoluteRemainingSeconds")},
    }


def handle_request(handler, method, csrf_token):
    if not is_auth_request(handler.path):
        return False
    path = urlsplit(handler.path).path
    try:
        if not check_request(handler, method, csrf_token):
            return True
        parsed = urlsplit(handler.path)
        if parsed.query or parsed.fragment or parsed.scheme or parsed.netloc:
            raise _invalid("Authentication endpoints do not accept URL parameters.")
        allowed = ROUTES.get(path)
        if allowed is None:
            raise AuthError(404, "not-found", "Authentication endpoint not found.")
        if method != allowed:
            send_error(handler, AuthError(405, "method-not-allowed", "Method not allowed."), allow=allowed)
            return True
        payload = _payload(handler, method)
        if payload is not None and set(payload) != ({"username", "password"} if path == "/api/auth/login" else set()):
            raise _invalid("Unexpected or missing authentication request fields.")
        service = getattr(handler.server, "auth_service", None)
        if service is None:
            raise AuthError(503, "authentication-unavailable", "Owner authentication is unavailable.")
        token = _session_token(handler)
        if path == "/api/auth/status":
            state = service.status()
            if state not in ("ready", "setup-required", "unavailable"):
                raise ValueError("Invalid authentication availability state.")
            send_response(handler, 200, {"state": state, "csrfToken": csrf_token,
                                        "idleTimeoutSeconds": 1800, "absoluteTimeoutSeconds": 28800,
                                        "managerAuthorizationEnforced": getattr(handler, "owner_authorization_enforced", False) is True})
        elif path == "/api/auth/login":
            issued = service.login(payload["username"], payload["password"], previous_token=token)
            send_response(handler, 200, _safe_metadata(issued.metadata), cookie=_cookie(issued.token))
        elif path == "/api/auth/logout":
            service.logout(token)
            send_response(handler, 200, {"authenticated": False}, cookie=_cookie())
        else:
            metadata = service.session(token, touch=path == "/api/auth/activity")
            send_response(handler, 200, _safe_metadata(metadata))
    except AuthError as error:
        send_error(handler, error)
    except Exception:
        # Do not log exception repr: errors may contain a supplied credential.
        send_error(handler, AuthError(503, "authentication-unavailable", "Owner authentication is unavailable."))
    return True
