"""Opt-in synthetic fixed-port server for later Chrome acceptance. Never auto-run."""
import argparse
from http.server import ThreadingHTTPServer
from pathlib import Path
import re
import socket
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from manager import app
from tracker_config.auth import AuthService
from tracker_config.repositories import ConfigurationRepositories
from tracker_config.security import SecurityRepository


def main(argv=None):
    parser = argparse.ArgumentParser(description="Synthetic extension-review backend; stop the production manager first.")
    parser.add_argument("--extension-id", required=True, help="Actual ID of the unpacked extension in an isolated ordinary Chrome profile.")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-p]{32}", args.extension_id):
        parser.error("Provide the actual 32-character Chrome extension ID.")
    server = None
    # Bind before creating even synthetic configuration; never choose another port.
    try:
        server = ThreadingHTTPServer(("127.0.0.1", 8765), app.TrackerHandler, bind_and_activate=False)
        server.allow_reuse_address = False
        server.allow_reuse_port = False
        if sys.platform == "win32":
            server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            server.server_bind()
            server.server_activate()
        except OSError:
            raise SystemExit("Port 8765 is unavailable. Stop the intended manager manually; no fallback or process termination was attempted.") from None
        with tempfile.TemporaryDirectory(prefix="tracker-extension-review-") as temporary:
            root = Path(temporary)
            security = SecurityRepository(root / "security", known_folder=lambda name: root, legacy_directory=None)
            security.permissions.make_private(root)
            security.initialize("synthetic-owner", "Synthetic browser passphrase 123!")
            repos = ConfigurationRepositories(root / "config")
            repos.candidates.save({"schemaVersion": 1, "activeCandidateId": None, "candidates": [
                {"id": "synthetic-candidate-a", "name": "Alex Synthetic", "extensionId": args.extension_id,
                 "historyFolder": str(root / "unopened-history-a"), "promptTemplate": "templates/unused-a.txt"},
                {"id": "synthetic-candidate-b", "name": "Blake Synthetic", "extensionId": args.extension_id,
                 "historyFolder": str(root / "unopened-history-b"), "promptTemplate": "templates/unused-b.txt"}
            ]}, expected_revision=None)
            repos.save_extension_settings("device", {"extensionId": args.extension_id}, expected_revision=None)
            app.CONFIG_FILE = repos.candidates.path
            app.TEMPLATE_DIR = root / "config" / "templates"
            app.sync_host_registration = lambda: {"ok": True, "fixture": True}
            app.browse_path = lambda *args: ""
            server.auth_service = AuthService(security)
            print("SYNTHETIC REVIEW ONLY: http://127.0.0.1:8765/extension-studio", flush=True)
            print("Synthetic username: synthetic-owner", flush=True)
            print("Synthetic password: Synthetic browser passphrase 123!", flush=True)
            print("Temporary configuration only. No production owner, binding or candidate data is used.", flush=True)
            print("Keep this fixture running throughout review; a new run has a different backend identity.", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
    finally:
        if server is not None:
            server.server_close()


if __name__ == "__main__":
    main()
