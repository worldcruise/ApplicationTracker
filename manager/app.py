from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent
# Support the existing `python manager/app.py` entry point without installation.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tracker_config import CandidateRegistryRepository, atomic_write_text
from tracker_config.models import RevisionConflict
from tracker_config.repositories import ConfigurationRepositories
from tracker_config.web_studio import WebStudio, legacy_prompt
from tracker_config.auth import AuthError, AuthService
from tracker_config.security import SecurityRepository
from manager import auth_http
from tracker_config.repositories import _invalid_constant, _unique_object


CONFIG_FILE = ROOT / "config" / "candidates.json"
TEMPLATE_DIR = ROOT / "config" / "templates"
UI_DIR = ROOT / "manager" / "ui"
EXTENSION_DIR = ROOT / "extension"
HOST_DIR = ROOT / "native-host"

# Exact read-only resources, never a directory listing or a path supplied by a client.
SHARED_STATIC_FILES = {
    "/shared/resume-renderer.mjs": ("shared/resume-renderer.mjs", "text/javascript; charset=utf-8"),
    "/shared/data-contracts.mjs": ("shared/data-contracts.mjs", "text/javascript; charset=utf-8"),
    "/shared/data-contracts-v1.json": ("shared/data-contracts-v1.json", "application/json; charset=utf-8"),
    "/shared/document-settings.mjs": ("shared/document-settings.mjs", "text/javascript; charset=utf-8"),
    "/shared/document-layouts-v1.json": ("shared/document-layouts-v1.json", "application/json; charset=utf-8"),
    "/shared/vendor/pdfmake-0.3.11/pdfmake.min.js": ("shared/vendor/pdfmake-0.3.11/pdfmake.min.js", "text/javascript; charset=utf-8"),
    "/shared/vendor/pdfmake-0.3.11/vfs_fonts.js": ("shared/vendor/pdfmake-0.3.11/vfs_fonts.js", "text/javascript; charset=utf-8"),
    # This one existing dependency is shared by Studio and the data-contract module.
    "/studio/contracts.mjs": ("studio/contracts.mjs", "text/javascript; charset=utf-8"),
}


def shared_static_resource(path: str):
    entry = SHARED_STATIC_FILES.get(path)
    if entry is None:
        return None
    relative, content_type = entry
    extension_root = EXTENSION_DIR.resolve()
    intended_root = (EXTENSION_DIR / relative.split("/", 1)[0]).resolve()
    file_path = (EXTENSION_DIR / relative).resolve()
    if not intended_root.is_relative_to(extension_root) or not file_path.is_relative_to(intended_root):
        raise PermissionError("Shared resource is outside its approved directory.")
    return file_path, content_type


EXTENSION_ID_PATTERN = re.compile(r"[a-p]{32}")
MAX_REQUEST_BYTES = 512_000
WRITE_LOCK = threading.Lock()
SESSION_TOKEN = secrets.token_urlsafe(32)
_CURRENT_REVISION = object()


def candidate_repository() -> CandidateRegistryRepository:
    return CandidateRegistryRepository(CONFIG_FILE)


def load_state() -> dict:
    return candidate_repository().read().data


def write_text_atomic(path: Path, text: str) -> None:
    atomic_write_text(path, text)


def save_state(state: dict, *, expected_revision=_CURRENT_REVISION) -> None:
    repository = candidate_repository()
    if expected_revision is _CURRENT_REVISION:
        expected_revision = repository.read().revision
    repository.save(state, expected_revision=expected_revision)


def find_candidate(state: dict, candidate_id: str) -> dict:
    for candidate in state["candidates"]:
        if candidate["id"] == candidate_id:
            return candidate

    raise ValueError("Candidate not found. Refresh the page and try again.")


def check_history_folder(value: str) -> tuple[Path, bool]:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Enter a history-folder path.")

    folder = Path(value.strip()).expanduser()

    if not folder.is_absolute():
        raise ValueError("Use a full, absolute history-folder path.")

    folder = folder.resolve()

    if folder.exists():
        if not folder.is_dir():
            raise ValueError("The history path points to a file.")

        with tempfile.TemporaryFile(dir=folder):
            pass

        return folder, True

    parent = folder
    while not parent.exists():
        parent = parent.parent

    if not parent.is_dir():
        raise ValueError("The history folder cannot be created here.")

    with tempfile.TemporaryDirectory(dir=parent):
        pass

    return folder, False


def check_prompt_file(value: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Choose a prompt .txt or .md file.")

    prompt_file = Path(value.strip()).expanduser()
    if not prompt_file.is_absolute():
        raise ValueError("Use a full, absolute prompt-file path.")

    prompt_file = prompt_file.resolve()
    if prompt_file.suffix.lower() not in {".txt", ".md"} or not prompt_file.is_file():
        raise ValueError("Choose an existing .txt or .md prompt file.")

    if prompt_file.stat().st_size > MAX_REQUEST_BYTES:
        raise ValueError("The prompt file must be smaller than 500 KB.")

    try:
        prompt_text = prompt_file.read_text(encoding="utf-8")
    except UnicodeError as error:
        raise ValueError("The prompt file must be UTF-8 text.") from error
    except OSError as error:
        raise ValueError(f"The prompt file could not be read: {error}") from error

    if not prompt_text.strip():
        raise ValueError("The prompt file is empty.")

    return prompt_file


def browse_path(kind: str, current_path: str) -> str:
    if kind not in {"folder", "prompt"}:
        raise ValueError("Invalid browse type.")

    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as error:
        raise ValueError("File browsing requires Tkinter. Enter the full path instead.") from error

    try:
        root = tk.Tk()
    except tk.TclError as error:
        raise ValueError("Could not open the file browser. Enter the full path instead.") from error
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        current = Path(current_path).expanduser() if current_path else Path.home()
        initial_dir = current if current.is_dir() else current.parent
        if not initial_dir.is_dir():
            initial_dir = Path.home()

        if kind == "folder":
            selected = filedialog.askdirectory(
                parent=root, title="Choose candidate history folder",
                initialdir=str(initial_dir), mustexist=True,
            )
        else:
            selected = filedialog.askopenfilename(
                parent=root, title="Choose candidate prompt file",
                initialdir=str(initial_dir),
                filetypes=[("Prompt files", "*.txt *.md"), ("All files", "*.*")],
            )
        return str(Path(selected).resolve()) if selected else ""
    finally:
        root.destroy()


def sync_host_registration() -> dict:
    try:
        result = subprocess.run(
            [sys.executable, str(HOST_DIR / "register_host.py")],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"ok": False, "error": str(error)}

    if result.returncode != 0:
        return {
            "ok": False,
            "error": (
                result.stdout.strip()
                or result.stderr.strip()
                or "Native-host registration failed."
            ),
        }

    return {"ok": True}


def save_candidate(payload: dict, candidate_id: str | None = None) -> dict:
    name = str(payload.get("name") or "").strip()
    extension_id = str(payload.get("extensionId") or "").strip().lower()
    template_text = payload.get("promptTemplateText")
    prompt_file_value = payload.get("promptFilePath")

    if not name or len(name) > 100:
        raise ValueError("Candidate name must be 1–100 characters.")

    if not EXTENSION_ID_PATTERN.fullmatch(extension_id):
        raise ValueError("Enter the installed extension's 32-character ID.")

    snapshot = candidate_repository().read()
    state = snapshot.data
    existing_candidate = find_candidate(state, candidate_id) if candidate_id is not None else {}
    if "registryRevision" in payload and payload["registryRevision"] != snapshot.revision:
        raise RevisionConflict("Candidate registry changed while the configuration form was open.")
    settings = {field: payload[field] for field in ("assignedPromptTemplateId", "preferredDocumentTemplateId") if field in payload}
    settings = ConfigurationRepositories(CONFIG_FILE.parent).candidate_settings(settings, existing_candidate)

    if prompt_file_value:
        prompt_file = check_prompt_file(prompt_file_value)
    else:
        prompt_file = None
        if not isinstance(template_text, str) or not template_text.strip():
            raise ValueError("Paste the candidate's prompt text or choose a prompt file.")

    folder, _ = check_history_folder(payload.get("historyFolder"))
    if candidate_id is None:
        candidate_id = uuid.uuid4().hex

    for other in state["candidates"]:
        if other["id"] == candidate_id:
            continue

        if (
            other["extensionId"] == extension_id
            and other["name"].strip().casefold() == name.casefold()
        ):
            raise ValueError(
                "This candidate name is already used for this extension ID."
            )

        other_folder = Path(other["historyFolder"]).expanduser().resolve()
        if os.path.normcase(str(other_folder)) == os.path.normcase(str(folder)):
            raise ValueError("This history folder belongs to another candidate.")

    folder.mkdir(parents=True, exist_ok=True)

    # Verify that the folder remains writable when it is created.
    with tempfile.TemporaryFile(dir=folder):
        pass

    template_name = f"{candidate_id}.txt"
    if prompt_file is None:
        write_text_atomic(TEMPLATE_DIR / template_name, template_text)

    candidate = {
        **existing_candidate,
        **settings,
        "id": candidate_id,
        "name": name,
        "historyFolder": str(folder),
        "extensionId": extension_id,
    }
    # Preserve unknown settings while retaining the existing prompt-mode switch.
    candidate.pop("promptTemplate", None)
    candidate.pop("promptFilePath", None)
    if prompt_file is None:
        candidate["promptTemplate"] = f"templates/{template_name}"
    else:
        candidate["promptFilePath"] = str(prompt_file)

    existing_index = next(
        (
            index
            for index, item in enumerate(state["candidates"])
            if item["id"] == candidate_id
        ),
        None,
    )

    if existing_index is None:
        state["candidates"].append(candidate)
    else:
        state["candidates"][existing_index] = candidate

    save_state(state, expected_revision=snapshot.revision)
    registration = sync_host_registration()

    return {
        "candidate": candidate,
        "registration": registration,
        "state": state,
    }


def delete_candidate(candidate_id: str) -> dict:
    snapshot = candidate_repository().read()
    state = snapshot.data
    find_candidate(state, candidate_id)
    state["candidates"] = [
        candidate for candidate in state["candidates"]
        if candidate["id"] != candidate_id
    ]
    if state.get("activeCandidateId") == candidate_id:
        state["activeCandidateId"] = None

    save_state(state, expected_revision=snapshot.revision)

    cleanup_warning = None
    if re.fullmatch(r"[0-9a-f]{32}", candidate_id):
        try:
            (TEMPLATE_DIR / f"{candidate_id}.txt").unlink(missing_ok=True)
        except OSError as error:
            cleanup_warning = f"Saved prompt cleanup needs attention: {error}"

    return {
        "state": state,
        "registration": sync_host_registration(),
        "cleanupWarning": cleanup_warning,
    }


class TrackerHandler(BaseHTTPRequestHandler):
    owner_authorization_enforced = True

    def check_business_request(self, method):
        path = urlsplit(self.path).path
        if path != "/api" and not path.startswith("/api/"):
            return self.check_local_request(write=method not in ("GET", "HEAD", "OPTIONS"))
        try:
            if not auth_http.check_request(self, method, SESSION_TOKEN):
                return False
            self.owner_context = auth_http.require_owner(self)
            # Explicit MVP policy: the verified installation owner administers
            # this registry. No client identity/unknown record field grants access.
            match = re.fullmatch(r"/api/(?:studio/candidates/([A-Za-z0-9_-]+)/(?:profile|prompt|settings)|candidates/([^/]+)(?:/template)?)", path)
            if match:
                candidate_repository().get(match[1] or match[2])
            return True
        except AuthError as error:
            auth_http.send_error(self, error)
        except Exception as error:
            self.handle_error(error)
        return False

    def log_message(self, format, *args):
        if auth_http.is_auth_request(getattr(self, "path", "")) or b"/api/auth" in getattr(self, "raw_requestline", b""):
            # BaseHTTPRequestHandler normally logs the full request target.
            # Even rejected credential-bearing URLs must never reach logs.
            super().log_message("Authentication request processed.")
        else:
            super().log_message(format, *args)

    def send_error(self, code, message=None, explain=None):
        if auth_http.is_auth_request(getattr(self, "path", "")):
            if code == 501:
                auth_http.handle_request(self, getattr(self, "command", "GET"), SESSION_TOKEN)
                return
            status = 405 if code == 501 else code
            auth_http.send_error(self, AuthError(status, "method-not-allowed" if status == 405 else "invalid-request", "Authentication request rejected."),
                                 allow=auth_http.ROUTES.get(urlsplit(self.path).path) if status == 405 else None)
        elif urlsplit(getattr(self, "path", "")).path == "/api" or urlsplit(getattr(self, "path", "")).path.startswith("/api/"):
            if code != 501 or self.check_business_request(getattr(self, "command", "GET")):
                auth_http.send_error(self, AuthError(405 if code == 501 else code,
                                     "method-not-allowed" if code == 501 else "not-found" if code == 404 else "invalid-request",
                                     "API request rejected."))
        else:
            super().send_error(code, message, explain)

    def send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid request length.") from error

        if size < 1 or size > MAX_REQUEST_BYTES:
            raise ValueError("Request is empty or too large.")

        data = json.loads(self.rfile.read(size), object_pairs_hook=_unique_object, parse_constant=_invalid_constant)

        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object.")

        return data

    def check_local_request(self, write: bool = False, *, auth: bool = False) -> bool:
        expected_host = f"127.0.0.1:{self.server.server_port}"

        def deny(message, code):
            if auth:
                auth_http.send_error(self, AuthError(403, code, message))
            else:
                self.send_json(403, {"error": message})
            return False

        if self.headers.get("Host") != expected_host:
            return deny("Invalid host.", "invalid-host")

        if write:
            expected_origin = f"http://{expected_host}"

            if self.headers.get("Origin") != expected_origin:
                return deny("Invalid origin.", "invalid-origin")

            if self.headers.get("X-Tracker-Token") != SESSION_TOKEN:
                return deny("Invalid session token.", "invalid-csrf")

        return True

    def handle_error(self, error: Exception) -> None:
        if isinstance(error, RevisionConflict):
            self.send_json(409, {"error": f"{error} Reload the record and reconcile your edits.", "code": "revision-conflict"})
        elif isinstance(error, (ValueError, json.JSONDecodeError)):
            self.send_json(400, {"error": str(error)})
        elif isinstance(error, PermissionError):
            self.send_json(403, {"error": str(error)})
        else:
            self.log_error("Request failed: %s", error)
            self.send_json(500, {"error": "The request could not be completed."})

    def do_GET(self) -> None:
        if auth_http.handle_request(self, "GET", SESSION_TOKEN):
            return
        if not self.check_business_request("GET"):
            return

        path = urlsplit(self.path).path

        try:
            if path == "/api/studio/extension":
                self.send_json(200, WebStudio(CONFIG_FILE.parent).extension_settings(EXTENSION_DIR))
                return
            if path == "/api/studio/state":
                self.send_json(200, WebStudio(CONFIG_FILE.parent).state())
                return
            studio_match = re.fullmatch(r"/api/studio/candidates/([A-Za-z0-9_-]+)/(profile|prompt)", path)
            if studio_match:
                service = WebStudio(CONFIG_FILE.parent)
                operation = service.profile if studio_match[2] == "profile" else service.prompt
                self.send_json(200, operation(studio_match[1]))
                return
            if path == "/api/state":
                self.send_json(
                    200,
                    {**load_state(), "sessionToken": SESSION_TOKEN},
                )
                return

            match = re.fullmatch(
                r"/api/candidates/([^/]+)/template", path
            )
            if match:
                candidate = find_candidate(load_state(), match.group(1))
                self.send_json(
                    200,
                    {
                        "promptTemplateText": legacy_prompt(candidate, CONFIG_FILE.parent)
                    },
                )
                return

            static_files = {
                "/": ("index.html", "text/html; charset=utf-8"),
                "/extension-studio": ("index.html", "text/html; charset=utf-8"),
                "/styles.css": ("styles.css", "text/css; charset=utf-8"),
                "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/auth.mjs": ("auth.mjs", "text/javascript; charset=utf-8"),
                "/studio-app.mjs": ("studio-app.mjs", "text/javascript; charset=utf-8"),
                "/studio-core.mjs": ("studio-core.mjs", "text/javascript; charset=utf-8"),
                "/extension-studio.mjs": ("extension-studio.mjs", "text/javascript; charset=utf-8"),
                "/classic.svg": ("classic.svg", "image/svg+xml"),
                "/modern.svg": ("modern.svg", "image/svg+xml"),
            }

            shared = shared_static_resource(path)
            if shared is not None:
                file_path, content_type = shared
            elif path in static_files:
                filename, content_type = static_files[path]
                file_path = (UI_DIR / filename).resolve()
                if not file_path.is_relative_to(UI_DIR.resolve()):
                    raise PermissionError("UI resource is outside its approved directory.")
            else:
                self.send_error(404)
                return

            if not file_path.is_file():
                self.send_error(404)
                return

            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if shared is not None:
                self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        except Exception as error:
            self.handle_error(error)

    def do_POST(self) -> None:
        self.handle_write("POST")

    def do_PUT(self) -> None:
        self.handle_write("PUT")

    def do_DELETE(self) -> None:
        self.handle_write("DELETE")

    def reject_shared_method(self, path: str) -> bool:
        if path.startswith("/shared/") or path == "/studio/contracts.mjs":
            self.send_response(405)
            self.send_header("Allow", "GET")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        return False

    def do_HEAD(self) -> None:
        if auth_http.handle_request(self, getattr(self, "command", "HEAD"), SESSION_TOKEN):
            return
        if self.check_business_request(getattr(self, "command", "HEAD")) and not self.reject_shared_method(urlsplit(self.path).path):
            self.send_error(501)

    do_OPTIONS = do_HEAD
    do_PATCH = do_HEAD

    def handle_write(self, method: str) -> None:
        if auth_http.handle_request(self, method, SESSION_TOKEN):
            return
        if not self.check_business_request(method):
            return

        path = urlsplit(self.path).path

        if self.reject_shared_method(path):
            return

        try:
            payload = self.read_json()

            if path.startswith("/api/studio/"):
                service = WebStudio(CONFIG_FILE.parent)
                service.check_payload(payload)
                match = re.fullmatch(r"/api/studio/candidates/([A-Za-z0-9_-]+)/(profile|settings)", path)
                prompt_match = re.fullmatch(r"/api/studio/prompts(?:/([A-Za-z0-9_-]+))?", path)
                document_match = re.fullmatch(r"/api/studio/documents(?:/([A-Za-z0-9_-]+))?", path)
                extension_match = re.fullmatch(r"/api/studio/extension/(preferences|device)", path)
                with WRITE_LOCK:
                    if extension_match and method == "PUT":
                        response = service.envelope(service.repositories.save_extension_settings(
                            extension_match[1], payload["data"], expected_revision=payload["revision"]))
                    elif match and method == "PUT":
                        if match[2] == "profile":
                            response = service.save_profile(match[1], payload)
                        else:
                            response = service.envelope(service.repositories.update_candidate_settings(
                                match[1], payload["data"], expected_revision=payload["revision"]))
                    elif prompt_match and ((method == "POST" and prompt_match[1] is None) or (method == "PUT" and prompt_match[1])):
                        response = service.envelope(service.repositories.save_prompt(
                            payload["data"], template_id=prompt_match[1], expected_revision=payload["revision"]))
                    elif document_match and ((method == "POST" and document_match[1] is None) or (method == "PUT" and document_match[1])):
                        response = service.envelope(service.repositories.save_document(
                            payload["data"], template_id=document_match[1], expected_revision=payload["revision"]))
                    else:
                        self.send_error(404)
                        return
                self.send_json(200, response)
                return

            if method == "POST" and path == "/api/browse":
                current_path = payload.get("currentPath", "")
                if not isinstance(current_path, str):
                    raise ValueError("Invalid starting path.")
                selected = browse_path(payload.get("kind"), current_path)
                self.send_json(200, {"path": selected})
                return

            with WRITE_LOCK:
                if method == "POST" and path == "/api/folders/check":
                    folder, exists = check_history_folder(
                        payload.get("historyFolder")
                    )
                    response = {
                        "historyFolder": str(folder),
                        "exists": exists,
                    }

                elif method == "POST" and path == "/api/candidates":
                    response = save_candidate(payload)

                elif method == "PUT" and re.fullmatch(
                    r"/api/candidates/[^/]+", path
                ):
                    candidate_id = path.rsplit("/", 1)[1]
                    response = save_candidate(payload, candidate_id)

                elif method == "DELETE" and re.fullmatch(
                    r"/api/candidates/[^/]+", path
                ):
                    candidate_id = path.rsplit("/", 1)[1]
                    response = delete_candidate(candidate_id)

                elif method == "POST" and path == "/api/active":
                    candidate_id = payload.get("candidateId")
                    snapshot = candidate_repository().read()
                    state = snapshot.data
                    find_candidate(state, candidate_id)
                    state["activeCandidateId"] = candidate_id
                    save_state(state, expected_revision=snapshot.revision)
                    response = {"state": state}

                else:
                    self.send_error(404)
                    return

            self.send_json(200, response)

        except Exception as error:
            self.handle_error(error)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), TrackerHandler)
    server.auth_service = AuthService(SecurityRepository(CONFIG_FILE.parent))
    url = f"http://127.0.0.1:{server.server_port}/"

    print(f"Application Tracker: {url}")
    webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
