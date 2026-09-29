from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
HOST_DIR = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "config" / "candidates.json"

HOST_NAME = "com.kevin.candidate_host"
MANIFEST_FILE = HOST_DIR / f"{HOST_NAME}.json"
RUNNER_FILE = HOST_DIR / "_run_host.bat"

REGISTRY_KEY = (
    rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"
)
EXTENSION_ID_PATTERN = re.compile(r"[a-p]{32}")


def extension_ids_from(candidates: list[dict]) -> list[str]:
    ids = []

    for candidate in candidates:
        extension_id = str(
            candidate.get("extensionId") or ""
        ).strip().lower()

        if not EXTENSION_ID_PATTERN.fullmatch(extension_id):
            name = candidate.get("name", "Unnamed candidate")
            raise ValueError(
                f"{name} has an invalid Chrome extension ID."
            )

        ids.append(extension_id)

    if not ids:
        raise ValueError("Add a candidate before registering the host.")

    if len(ids) != len(set(ids)):
        raise ValueError(
            "Each candidate must have a different extension ID."
        )

    return sorted(ids)


def write_json_atomic(path: Path, data: dict) -> None:
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
        json.dump(data, file, indent=2, ensure_ascii=False)
        file.write("\n")

    try:
        os.replace(temporary_path, path)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def sync_registration(candidates: list[dict]) -> dict:
    """
    Update the host manifest and register its location for this Windows user.

    Called by manager/app.py after adding or editing a candidate.
    """
    if sys.platform != "win32":
        raise RuntimeError(
            "Automatic native-host registration is available on Windows."
        )

    if not RUNNER_FILE.is_file():
        raise FileNotFoundError(
            f"Native-host runner is missing: {RUNNER_FILE}"
        )

    extension_ids = extension_ids_from(candidates)

    manifest = {
        "name": HOST_NAME,
        "description": "Application Tracker local candidate host",
        "path": str(RUNNER_FILE.resolve()),
        "type": "stdio",
        "allowed_origins": [
            f"chrome-extension://{extension_id}/"
            for extension_id in extension_ids
        ],
    }

    write_json_atomic(MANIFEST_FILE, manifest)

    import winreg

    with winreg.CreateKey(
        winreg.HKEY_CURRENT_USER,
        REGISTRY_KEY,
    ) as key:
        winreg.SetValueEx(
            key,
            "",
            0,
            winreg.REG_SZ,
            str(MANIFEST_FILE.resolve()),
        )

    return {
        "manifestPath": str(MANIFEST_FILE.resolve()),
        "extensionIds": extension_ids,
    }


def registration_status() -> dict:
    """Report whether Chrome's registry entry points to this host."""
    if sys.platform != "win32":
        return {
            "registered": False,
            "reason": "This registration check is for Windows.",
        }

    import winreg

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            REGISTRY_KEY,
        ) as key:
            registered_path, _ = winreg.QueryValueEx(key, "")
    except FileNotFoundError:
        return {
            "registered": False,
            "reason": "Native host is not registered.",
        }

    expected_path = str(MANIFEST_FILE.resolve())
    matches = os.path.normcase(registered_path) == os.path.normcase(
        expected_path
    )

    return {
        "registered": matches and MANIFEST_FILE.is_file(),
        "manifestPath": registered_path,
        "reason": (
            None
            if matches and MANIFEST_FILE.is_file()
            else "Registry path does not point to this host manifest."
        ),
    }


def main() -> int:
    if not CONFIG_FILE.is_file():
        print(f"Candidate configuration is missing: {CONFIG_FILE}")
        return 1

    try:
        state = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        result = sync_registration(state.get("candidates", []))
    except Exception as error:
        print(f"Registration failed: {error}")
        return 1

    print(f"Registered {HOST_NAME}")
    print(f"Manifest: {result['manifestPath']}")
    print(f"Allowed candidate extensions: {len(result['extensionIds'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())