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
CONFIG_FILE = ROOT / "config" / "candidates.json"
TEMPLATE_DIR = ROOT / "config" / "templates"
UI_DIR = ROOT / "manager" / "ui"
HOST_DIR = ROOT / "native-host"

EXTENSION_ID_PATTERN = re.compile(r"[a-p]{32}")
MAX_REQUEST_BYTES = 512_000
WRITE_LOCK = threading.Lock()
SESSION_TOKEN = secrets.token_urlsafe(32)


def load_state() -> dict:
    if not CONFIG_FILE.exists():
        return {
            "schemaVersion": 1,
            "activeCandidateId": None,
            "candidates": [],
        }

    state = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))

    if state.get("schemaVersion") != 1:
        raise ValueError("Unsupported candidates.json version.")

    return state


def write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as file:
        temporary_path = Path(file.name)
        file.write(text)

    try:
        os.replace(temporary_path, path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def save_state(state: dict) -> None:
    write_text_atomic(
        CONFIG_FILE,
        json.dumps(state, indent=2, ensure_ascii=False) + "\n",
    )


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

    if prompt_file_value:
        prompt_file = check_prompt_file(prompt_file_value)
    else:
        prompt_file = None
        if not isinstance(template_text, str) or not template_text.strip():
            raise ValueError("Paste the candidate's prompt text or choose a prompt file.")

    folder, _ = check_history_folder(payload.get("historyFolder"))
    state = load_state()

    if candidate_id is not None:
        find_candidate(state, candidate_id)
    else:
        candidate_id = uuid.uuid4().hex

    for other in state["candidates"]:
        if other["id"] == candidate_id:
            continue

        if other["extensionId"] == extension_id:
            raise ValueError("This extension ID belongs to another candidate.")

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
        "id": candidate_id,
        "name": name,
        "historyFolder": str(folder),
        "extensionId": extension_id,
    }
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

    save_state(state)
    registration = sync_host_registration()

    return {
        "candidate": candidate,
        "registration": registration,
        "state": state,
    }


def delete_candidate(candidate_id: str) -> dict:
    state = load_state()
    find_candidate(state, candidate_id)
    state["candidates"] = [
        candidate for candidate in state["candidates"]
        if candidate["id"] != candidate_id
    ]
    if state.get("activeCandidateId") == candidate_id:
        state["activeCandidateId"] = None

    save_state(state)

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
    def send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid request length.") from error

        if size < 1 or size > MAX_REQUEST_BYTES:
            raise ValueError("Request is empty or too large.")

        data = json.loads(self.rfile.read(size))

        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object.")

        return data

    def check_local_request(self, write: bool = False) -> bool:
        expected_host = f"127.0.0.1:{self.server.server_port}"

        if self.headers.get("Host") != expected_host:
            self.send_json(403, {"error": "Invalid host."})
            return False

        if write:
            expected_origin = f"http://{expected_host}"

            if self.headers.get("Origin") != expected_origin:
                self.send_json(403, {"error": "Invalid origin."})
                return False

            if self.headers.get("X-Tracker-Token") != SESSION_TOKEN:
                self.send_json(403, {"error": "Invalid session token."})
                return False

        return True

    def handle_error(self, error: Exception) -> None:
        if isinstance(error, (ValueError, json.JSONDecodeError)):
            self.send_json(400, {"error": str(error)})
        elif isinstance(error, PermissionError):
            self.send_json(403, {"error": str(error)})
        else:
            self.log_error("Request failed: %s", error)
            self.send_json(500, {"error": "The request could not be completed."})

    def do_GET(self) -> None:
        if not self.check_local_request():
            return

        path = urlsplit(self.path).path

        try:
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
                template_path = TEMPLATE_DIR / f"{candidate['id']}.txt"
                self.send_json(
                    200,
                    {
                        "promptTemplateText": template_path.read_text(
                            encoding="utf-8"
                        )
                    },
                )
                return

            static_files = {
                "/": ("index.html", "text/html; charset=utf-8"),
                "/styles.css": ("styles.css", "text/css; charset=utf-8"),
                "/app.js": ("app.js", "text/javascript; charset=utf-8"),
            }

            if path not in static_files:
                self.send_error(404)
                return

            filename, content_type = static_files[path]
            file_path = UI_DIR / filename

            if not file_path.is_file():
                self.send_error(404)
                return

            body = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
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

    def handle_write(self, method: str) -> None:
        if not self.check_local_request(write=True):
            return

        path = urlsplit(self.path).path

        try:
            payload = self.read_json()

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
                    state = load_state()
                    find_candidate(state, candidate_id)
                    state["activeCandidateId"] = candidate_id
                    save_state(state)
                    response = {"state": state}

                else:
                    self.send_error(404)
                    return

            self.send_json(200, response)

        except Exception as error:
            self.handle_error(error)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), TrackerHandler)
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
