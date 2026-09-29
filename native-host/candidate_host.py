from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import re
import struct
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
STATE_FILE = CONFIG_DIR / "candidates.json"
TEMPLATE_DIR = CONFIG_DIR / "templates"

MAX_INCOMING_BYTES = 64 * 1024 * 1024
MAX_OUTGOING_BYTES = 1024 * 1024

COMPANY_SUFFIXES = {
    "incorporated", "inc", "llc", "l.l.c", "ltd", "limited",
    "corp", "corporation", "co", "company", "technologies",
    "technology", "systems", "holdings", "group", "plc",
    "lp", "llp",
}


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(
        microsecond=0
    ).isoformat()


def read_exactly(size: int) -> bytes:
    chunks = []
    remaining = size

    while remaining:
        chunk = sys.stdin.buffer.read(remaining)
        if not chunk:
            raise EOFError("Native message ended unexpectedly.")
        chunks.append(chunk)
        remaining -= len(chunk)

    return b"".join(chunks)


def native_read() -> dict[str, Any] | None:
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError("Invalid native-message header.")

    size = struct.unpack("@I", header)[0]
    if size < 1 or size > MAX_INCOMING_BYTES:
        raise ValueError("Native message exceeds the permitted size.")

    message = json.loads(read_exactly(size).decode("utf-8"))
    if not isinstance(message, dict):
        raise ValueError("Native message must be a JSON object.")

    return message


def native_write(payload: dict[str, Any]) -> None:
    encoded = json.dumps(
        payload, ensure_ascii=False
    ).encode("utf-8")

    if len(encoded) > MAX_OUTGOING_BYTES:
        encoded = json.dumps({
            "ok": False,
            "error": "The generated prompt is too large to return to Chrome.",
        }).encode("utf-8")

    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def load_state() -> dict[str, Any]:
    if not STATE_FILE.is_file():
        raise FileNotFoundError(
            "Candidate settings are missing. Open Application Tracker "
            "and add a candidate."
        )

    state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    if state.get("schemaVersion") != 1:
        raise ValueError("Unsupported candidate settings version.")

    return state


def caller_extension_id(arguments: list[str]) -> str:
    origin = arguments[1] if len(arguments) > 1 else ""
    match = re.fullmatch(
        r"chrome-extension://([a-p]{32})/",
        origin,
    )

    if not match:
        raise PermissionError(
            "The native host was not called by a valid Chrome extension."
        )

    return match.group(1)


def verify_caller(state: dict[str, Any], extension_id: str) -> None:
    permitted_ids = {
        item.get("extensionId")
        for item in state.get("candidates", [])
    }

    if extension_id not in permitted_ids:
        raise PermissionError(
            "This extension ID is not configured in Application Tracker."
        )


def active_candidate(state: dict[str, Any]) -> dict[str, Any]:
    active_id = state.get("activeCandidateId")

    for candidate in state.get("candidates", []):
        if candidate.get("id") == active_id:
            return candidate

    raise ValueError(
        "No active candidate is selected. Open Application Tracker "
        "and select one."
    )


def candidate_root(candidate: dict[str, Any]) -> Path:
    root = Path(candidate["historyFolder"]).expanduser()

    if not root.is_absolute():
        raise ValueError("The candidate history folder must be absolute.")

    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def candidate_template(candidate: dict[str, Any]) -> str:
    if candidate.get("promptFilePath"):
        prompt_path = Path(candidate["promptFilePath"]).expanduser()
        if not prompt_path.is_absolute():
            raise ValueError("The candidate prompt file path must be absolute.")
        if prompt_path.suffix.lower() not in {".txt", ".md"} or not prompt_path.is_file():
            raise ValueError("The candidate prompt file is missing or is not .txt or .md.")
        prompt_text = prompt_path.read_text(encoding="utf-8").strip()
        if not prompt_text:
            raise ValueError("The candidate prompt file is empty.")
        return prompt_text

    relative_path = Path(candidate["promptTemplate"])
    template_path = (CONFIG_DIR / relative_path).resolve()
    allowed_dir = TEMPLATE_DIR.resolve()

    if not template_path.is_relative_to(allowed_dir):
        raise ValueError("Candidate template path is outside templates.")

    return template_path.read_text(encoding="utf-8").strip()


def sanitize_folder_name(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", name)
    cleaned = re.sub(r"\s+", " ", cleaned).strip().rstrip(".")
    return cleaned[:150] or "Unknown Company"


def normalize_company_name(name: str) -> str:
    text = name.strip().lower().replace("&", " and ")
    text = re.sub(r"[^\w\s.-]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    parts = text.split()
    while parts and parts[-1].strip(".") in COMPANY_SUFFIXES:
        parts.pop()

    return " ".join(parts).strip() or text


def find_company_folder(root: Path, company_name: str) -> Path | None:
    target = normalize_company_name(company_name)

    for child in root.iterdir():
        if child.is_dir() and normalize_company_name(child.name) == target:
            return child

    return None


def get_or_create_company_folder(
    root: Path,
    company_name: str,
) -> tuple[Path, bool]:
    existing = find_company_folder(root, company_name)
    if existing:
        return existing, False

    folder = root / sanitize_folder_name(company_name)
    folder.mkdir(parents=True, exist_ok=True)
    return folder, True


def build_final_prompt(
    template: str,
    company_name: str,
    job_description: str,
) -> str:
    parts = [template.strip(), f"Company:\n{company_name}"]

    if job_description.strip():
        parts.append(
            f"Job Description:\n{job_description.strip()}"
        )

    return "\n\n".join(part for part in parts if part)


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8", newline="\n")


def handle_ping(
    message: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    return {
        "ok": True,
        "message": "Application Tracker native host is connected.",
        "timestamp": utc_now_iso(),
    }


def handle_get_active_profile(
    message: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    candidate = active_candidate(state)

    return {
        "ok": True,
        "candidateId": candidate["id"],
        "candidateName": candidate["name"],
        "promptTemplate": candidate_template(candidate),
    }


def handle_check_company(
    message: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    company_name = str(
        message.get("companyName") or ""
    ).strip()

    if not company_name:
        raise ValueError("Select a company name first.")

    candidate = active_candidate(state)
    folder = find_company_folder(
        candidate_root(candidate), company_name
    )

    return {
        "ok": True,
        "candidateId": candidate["id"],
        "candidateName": candidate["name"],
        "exists": folder is not None,
        "companyName": company_name,
        "normalizedCompanyName": normalize_company_name(
            company_name
        ),
        "folderPath": str(folder) if folder else None,
    }


def handle_save_application(
    message: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    company_name = str(
        message.get("companyName") or ""
    ).strip()

    if not company_name:
        raise ValueError("Missing company name.")

    candidate = active_candidate(state)

    if message.get("expectedCandidateId") != candidate["id"]:
        raise ValueError(
            "The active candidate changed while the job was being captured. "
            "Run the extension again so the job is checked and saved "
            "under the same candidate."
        )

    root = candidate_root(candidate)

    job_title = str(message.get("jobTitle") or "").strip()
    job_url = str(message.get("jobUrl") or "").strip()
    page_title = str(message.get("pageTitle") or "").strip()
    selected_text = str(message.get("selectedText") or "")
    job_description = str(message.get("jobDescription") or "")
    mhtml_base64 = str(message.get("mhtmlBase64") or "")

    mhtml_bytes = (
        base64.b64decode(mhtml_base64, validate=True)
        if mhtml_base64 else None
    )

    final_prompt = build_final_prompt(
        candidate_template(candidate),
        company_name,
        job_description,
    )

    folder, created = get_or_create_company_folder(
        root, company_name
    )

    if job_description:
        write_text(
            folder / "job_description.txt",
            job_description,
        )

    if mhtml_bytes is not None:
        (folder / "job_description.mhtml").write_bytes(
            mhtml_bytes
        )

    write_text(folder / "resume_prompt.txt", final_prompt)

    old_meta = {}
    meta_path = folder / "meta.json"

    if meta_path.is_file():
        try:
            old_meta = json.loads(
                meta_path.read_text(encoding="utf-8")
            )
        except (ValueError, OSError):
            old_meta = {}

    timestamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    snapshot_hash = hashlib.sha1(
        (company_name + job_url).encode("utf-8")
    ).hexdigest()[:10]

    meta = {
        **old_meta,
        "candidateId": candidate["id"],
        "companyName": company_name,
        "normalizedCompanyName": normalize_company_name(
            company_name
        ),
        "jobTitle": job_title,
        "pageTitle": page_title,
        "jobUrl": job_url,
        "selectedText": selected_text,
        "savedAtLocal": dt.datetime.now().isoformat(
            timespec="seconds"
        ),
        "savedAtUtc": utc_now_iso(),
        "createdFolderThisRun": created,
        "files": {
            "text": (
                "job_description.txt"
                if job_description else None
            ),
            "mhtml": (
                "job_description.mhtml"
                if mhtml_bytes is not None else None
            ),
            "prompt": "resume_prompt.txt",
        },
        "snapshotId": f"{timestamp}_{snapshot_hash}",
    }

    write_text(
        meta_path,
        json.dumps(meta, indent=2, ensure_ascii=False),
    )

    return {
        "ok": True,
        "candidateId": candidate["id"],
        "candidateName": candidate["name"],
        "createdFolder": created,
        "folderPath": str(folder),
        "promptPath": str(folder / "resume_prompt.txt"),
        "savedFiles": meta["files"],
        "finalPrompt": final_prompt,
    }


HANDLERS = {
    "ping": handle_ping,
    "get_active_profile": handle_get_active_profile,
    "check_company": handle_check_company,
    "save_application": handle_save_application,
}


def main() -> int:
    try:
        extension_id = caller_extension_id(sys.argv)

        while True:
            message = native_read()
            if message is None:
                break

            try:
                state = load_state()
                verify_caller(state, extension_id)

                action = message.get("action")
                handler = HANDLERS.get(action)

                if handler is None:
                    raise ValueError(
                        f"Unsupported action: {action}"
                    )

                response = handler(message, state)
            except Exception as error:
                print(
                    f"[Application Tracker host] {error}",
                    file=sys.stderr,
                    flush=True,
                )
                response = {
                    "ok": False,
                    "error": str(error),
                }

            native_write(response)

    except Exception as error:
        print(
            f"[Application Tracker host] Fatal: {error}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
