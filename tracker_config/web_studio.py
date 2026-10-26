"""Web Studio application boundary; no filesystem work happens on import."""
import json
from pathlib import Path

from .models import ConfigurationError, identifier
from .repositories import ConfigurationRepositories
from .prompts import legacy_prompt_path


def legacy_prompt(candidate, config_directory: Path) -> str:
    """Resolve the existing linked/config-relative file contract, without changing it.

    This is an explicit read for Studio composition. Legacy capture retains its own
    established whitespace/composition behavior in the native host.
    """
    try:
        path = legacy_prompt_path(candidate, config_directory, config_directory / "templates")
        if path.stat().st_size > 512_000:
            raise ConfigurationError("Legacy prompt exceeds 512000 bytes.")
        with path.open("r", encoding="utf-8", newline="") as stream:
            body = stream.read()
    except (OSError, UnicodeError) as error:
        raise ConfigurationError("Legacy prompt cannot be read as UTF-8; check its configured file.") from error
    if not body.strip():
        raise ConfigurationError("Legacy prompt file is empty.")
    return body


class WebStudio:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.repositories = ConfigurationRepositories(self.directory)

    @staticmethod
    def envelope(snapshot):
        return {"data": snapshot.data, "revision": snapshot.revision}

    def state(self):
        repos = self.repositories
        return {"registry": self.envelope(repos.candidates.read()),
                "prompts": self.envelope(repos.prompts.read()),
                "documentCatalog": self.envelope(repos.documents.read()),
                "documents": repos.renderable_documents()}

    def profile(self, candidate_id):
        identifier(candidate_id, "candidateId")
        try:
            return {**self.envelope(self.repositories.profiles.read(candidate_id)), "exists": True}
        except FileNotFoundError:
            return {"data": self.repositories.profiles.new(candidate_id), "revision": None, "exists": False}

    def extension_settings(self, extension_directory):
        """Settings and package diagnostics, never an installed-browser claim."""
        package = {"status": "unavailable", "detail": "Extension package manifest is unavailable."}
        try:
            manifest = json.loads((Path(extension_directory) / "manifest.json").read_text(encoding="utf-8"))
            if (not isinstance(manifest, dict) or manifest.get("manifest_version") != 3
                    or not isinstance(manifest.get("name"), str) or not isinstance(manifest.get("version"), str)):
                raise ValueError("Invalid package manifest")
            external = manifest.get("externally_connectable", {})
            package = {"status": "available", "name": manifest["name"], "version": manifest["version"],
                       "diagnosticBridge": isinstance(external, dict) and isinstance(external.get("matches"), list) and "http://127.0.0.1/*" in external["matches"]}
        except (OSError, ValueError, UnicodeError):
            pass
        return {"preferences": self.envelope(self.repositories.extension_preferences.read()),
                "device": self.envelope(self.repositories.extension_device.read()),
                "diagnostics": {"backend": "reachable", "package": package,
                                "browserConnection": "not-checked", "nativeHost": "not-checked",
                                "perOperationCapture": "pending", "bidFolderSaving": "pending"}}

    def prompt(self, candidate_id):
        candidate = self.repositories.candidates.get(candidate_id)
        reference = candidate.get("assignedPromptTemplateId")
        if reference:
            record = self.repositories.prompts.get(reference)
            if record["archived"]:
                raise ConfigurationError("Assigned prompt is archived. Assign an active template or explicitly select the legacy source.")
            return {"source": "managed", "name": record["name"], "id": record["id"],
                    "version": record["version"], "body": record["body"]}
        return {"source": "legacy", "name": "Legacy linked prompt" if candidate.get("promptFilePath") else "Legacy stored prompt",
                "body": legacy_prompt(candidate, self.directory)}

    def save_profile(self, candidate_id, payload):
        self.check_payload(payload)
        data = payload.get("data")
        if not isinstance(data, dict) or data.get("candidateId") != candidate_id:
            raise ConfigurationError("Profile candidateId must match the selected candidate.")
        return {**self.envelope(self.repositories.profiles.save(data, expected_revision=payload["revision"])), "exists": True}

    @staticmethod
    def check_payload(payload):
        if payload.keys() - {"data", "revision"} or "data" not in payload or "revision" not in payload:
            raise ConfigurationError("Provide data and its revision; reload before saving stale changes.")
        if payload["revision"] is not None and not isinstance(payload["revision"], str):
            raise ConfigurationError("Revision must be text or null.")
