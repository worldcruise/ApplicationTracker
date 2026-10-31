"""Opt-in visual-test server. Uses synthetic records in TemporaryDirectory only.

Never starts on import; never calls manager.main or native-host registration.
"""
import argparse
import copy
import importlib.util
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tracker_config.repositories import ConfigurationRepositories
from tracker_config.security import SecurityRepository
from tracker_config.auth import AuthService
from tracker_config.security_files import private_atomic_write


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port-file", type=Path, required=True)
    parser.add_argument("--owner-state", choices=("ready", "missing", "corrupt"), default="ready")
    args = parser.parse_args()
    fixture = json.loads((ROOT / "tests/fixtures/resume-data.json").read_text(encoding="utf-8"))
    spec = importlib.util.spec_from_file_location("synthetic_visual_manager", ROOT / "manager/app.py")
    manager = importlib.util.module_from_spec(spec); spec.loader.exec_module(manager)
    with tempfile.TemporaryDirectory(prefix="studio-visual-fixture-") as temporary:
        config = Path(temporary) / "config"
        repos = ConfigurationRepositories(config)
        registry = copy.deepcopy(fixture["registry"])
        candidate = registry["candidates"][0]
        candidate["historyFolder"] = str(Path(temporary) / "unopened-history")
        candidate["assignedPromptTemplateId"] = "synthetic-prompt"
        candidate["preferredDocumentTemplateId"] = "modern"
        repos.candidates.save(registry, expected_revision=None)
        security = SecurityRepository(Path(temporary) / "security", known_folder=lambda name: Path(temporary), legacy_directory=None)
        security.permissions.make_private(Path(temporary))
        if args.owner_state == "ready":
            security.initialize("synthetic-owner", "Synthetic browser passphrase 123!")
        elif args.owner_state == "corrupt":
            security.location.provision(security.permissions)
            private_atomic_write(security.path, b"{broken synthetic record", permissions=security.permissions)
        profile = copy.deepcopy(fixture["profile"])
        profile["personal"]["birthday"] = "1992-07-09"
        profile["contact"]["phone"] = "555-0100"
        profile["address"] = {"city": "Example City", "state": "EX"}
        repos.profiles.save(profile, expected_revision=None)
        repos.prompts.save({"schemaVersion": 1, "templates": [{"id": "synthetic-prompt", "name": "Engineering Resume", "description": "Synthetic visual-test instructions", "body": "Tailor the resume using verified profile information.\nReturn one JSON object with company, title, summary, skills, experience and education.\nUse plain text and retain accurate employment information.\n\nJob description:\n{{JOB_DESCRIPTION}}", "version": 1, "archived": False, "isDefault": False, "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"}]}, expected_revision=None)
        manager.CONFIG_FILE = config / "candidates.json"
        manager.TEMPLATE_DIR = config / "templates"
        manager.sync_host_registration = lambda: {"ok": True, "fixture": True}

        class FixtureHandler(manager.TrackerHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                if not self.check_local_request():
                    return
                path = urlsplit(self.path).path
                if path == "/":
                    body = (manager.UI_DIR / "index.html").read_text(encoding="utf-8").replace("</body>", '<script type="module" src="/__fixture/browser.mjs"></script></body>').encode("utf-8")
                    mime = "text/html; charset=utf-8"
                elif path == "/__fixture/browser.mjs":
                    body = (ROOT / "tests/web-studio-browser-fixture.mjs").read_bytes(); mime = "text/javascript; charset=utf-8"
                elif path == "/__fixture/data":
                    if not manager.auth_http.check_request(self, "GET", manager.SESSION_TOKEN):
                        return
                    try:
                        manager.auth_http.require_owner(self)
                    except manager.AuthError as error:
                        manager.auth_http.send_error(self, error)
                        return
                    self.send_json(200, fixture); return
                else:
                    super().do_GET(); return
                self.send_response(200); self.send_header("Content-Type", mime); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        server.auth_service = AuthService(security)
        args.port_file.write_text(str(server.server_port), encoding="utf-8")
        print(f"Synthetic Studio fixture: http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
