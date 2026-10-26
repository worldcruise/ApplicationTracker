"""Run dependency-free browser-service tests without Chrome or live config."""

import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from tracker_config.models import (
    empty_profile, validate_candidate_registry, validate_profile,
    validate_prompt_catalog, validate_document_catalog,
)


ROOT = Path(__file__).resolve().parents[1]


class ExtensionAccessTests(unittest.TestCase):
    def setUp(self):
        self.node = shutil.which("node")
        if self.node is None:
            installed = Path("C:/Program Files/nodejs/node.exe")
            self.node = str(installed) if installed.is_file() else None
        if self.node is None:
            self.skipTest("Node.js is unavailable; no software will be installed.")
        temporary = tempfile.TemporaryDirectory(prefix="studio-access-tests-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()

    def run_node(self, arguments, source=None):
        result = subprocess.run(
            [self.node, *arguments], cwd=self.directory,
            input=source, capture_output=True, text=True, encoding="utf-8",
            timeout=45, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_javascript_access_services_with_in_memory_files_and_indexeddb(self):
        self.run_node(["--test", str(ROOT / "tests/extension-access.test.mjs")])

    def test_python_and_browser_contracts_agree_on_synthetic_records_and_name_matching(self):
        candidate = {
            "id": "candidate-one", "name": "Alex Example", "extensionId": "a" * 32,
            "historyFolder": str(self.directory / "history"),
            "promptTemplate": "templates/candidate-one.txt",
        }
        registry = {"schemaVersion": 1, "activeCandidateId": candidate["id"], "candidates": [candidate]}
        prompt = {"id": "prompt-one", "name": "Synthetic", "description": "Fixture",
                  "body": "  Complete instructions\r\n```json\n{}\n```", "version": 1,
                  "isDefault": False, "archived": False,
                  "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"}
        document = {"id": "document-one", "name": "Future layout", "description": "Fixture",
                    "version": 1, "layoutId": "future-layout", "supportedSettings": {}, "defaultSettings": {}}
        fixtures = []

        def add(kind, value):
            fixtures.append({"kind": kind, "value": value, "candidateId": candidate["id"]})

        add("registry", registry)
        add("profile", empty_profile(candidate["id"]))
        for birthday in ("2026-01-05", "20260105", "2026-W02-1", "2026W02", "2026-0105", "2025-W53-1"):
            add("profile", {**empty_profile(candidate["id"]), "personal": {"birthday": birthday}})
        add("prompt", {"schemaVersion": 1, "templates": [prompt]})
        for updated in ("2026-01-01T00:00:00.000001Z", "2026-01-01T01:00:00+01:00", "20260101T000000+0000"):
            add("prompt", {"schemaVersion": 1, "templates": [{**prompt, "updatedAt": updated}]})
        add("prompt", {"schemaVersion": 1, "templates": [{**prompt,
            "createdAt": "2026-01-01T00:00:00.000002Z", "updatedAt": "2026-01-01T00:00:00.000001Z"}]})
        add("document", {"schemaVersion": 1, "templates": [document]})
        for field, value in (("schemaVersion", 2), ("schemaVersion", True),
                             ("activeCandidateId", "missing"), ("candidates", {})):
            add("registry", {**registry, field: value})
        for field, value in (("name", 42), ("extensionId", "q" * 32),
                             ("historyFolder", "relative"), ("promptTemplate", "../escape.txt")):
            add("registry", {**registry, "candidates": [{**candidate, field: value}]})
        linked = {**candidate, "promptFilePath": str(self.directory / "linked.md")}
        linked.pop("promptTemplate")
        add("registry", {**registry, "candidates": [linked]})
        for field, value in (("skills", "invalid"), ("personal", {"birthday": "2026-02-30"}),
                             ("contact", {"password": "unsupported"}), ("preferences", {"startDate": 42})):
            add("profile", {**empty_profile(candidate["id"]), field: value})
        for field, value in (("version", True), ("body", "  "), ("updatedAt", "2025-01-01T00:00:00Z")):
            add("prompt", {"schemaVersion": 1, "templates": [{**prompt, field: value}]})
        add("document", {"schemaVersion": 1, "templates": [{**document, "defaultSettings": {"fontSize": 12}}]})
        unknown = copy.deepcopy(registry)
        unknown["candidates"][0]["future"] = {"nested": [True, None, "keep"]}
        add("registry", unknown)

        expected = []
        validators = {"registry": validate_candidate_registry, "profile": validate_profile,
                      "prompt": validate_prompt_catalog, "document": validate_document_catalog}
        for record in fixtures:
            try:
                validators[record["kind"]](record["value"])
                expected.append(True)
            except ValueError:
                expected.append(False)

        # Test equivalence classes rather than output casing (Cherokee folding
        # uses uppercase in Python). No real candidate names are involved.
        names = [chr(value) for value in range(0x110000)
                 if chr(value).upper() != chr(value) or chr(value).lower() != chr(value)]
        output = json.loads(self.run_node([str(ROOT / "tests/extension-contract-parity.mjs")],
                                         json.dumps({"records": fixtures, "names": names})))
        self.assertEqual(output["results"], expected)
        python_to_browser, browser_to_python = {}, {}
        for name, browser_key in zip(names, output["names"], strict=True):
            python_key = name.casefold()
            self.assertEqual(python_to_browser.setdefault(python_key, browser_key), browser_key,
                             f"Casefold mismatch at U+{ord(name):04X}")
            self.assertEqual(browser_to_python.setdefault(browser_key, python_key), python_key,
                             f"Casefold collision at U+{ord(name):04X}")
