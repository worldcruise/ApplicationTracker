"""Small JSON repositories with per-file atomic writes and explicit recovery."""

from __future__ import annotations

import copy
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
import threading
import datetime as dt
import uuid

from .document_settings import builtin_document_templates

from .models import (
    ConfigurationError, RevisionConflict, empty_catalog, empty_profile, empty_registry,
    identifier, migrate_candidate_registry, validate_candidate_registry,
    validate_document_catalog, validate_profile, validate_prompt_catalog,
    validate_template_references,
    timestamp,
    empty_extension_preferences, validate_extension_preferences,
    empty_extension_device, validate_extension_device,
)


_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock(path: Path):
    key = os.path.normcase(str(path.resolve()))
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(key, threading.RLock())


def atomic_write_bytes(path: Path, content: bytes, *, before_replace=None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp",
                                         delete=False) as file:
            temporary_path = Path(file.name)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        if before_replace is not None:
            before_replace()
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def atomic_write_text(path: Path, content: str) -> None:
    atomic_write_bytes(path, content.encode("utf-8"))


def _revision(raw: bytes | None) -> str | None:
    return hashlib.sha256(raw).hexdigest() if raw is not None else None


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigurationError(f"Duplicate JSON property '{key}'.")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ConfigurationError(f"Invalid JSON constant '{value}'.")


def _validate_json_values(value) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ConfigurationError("JSON object property names must be text.")
            _validate_json_values(item)
    elif isinstance(value, list):
        for item in value:
            _validate_json_values(item)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ConfigurationError("JSON numbers must be finite.")
    elif value is not None and type(value) not in (str, bool, int):
        raise ConfigurationError("Configuration must contain only JSON values.")


def _decode(raw: bytes, path: Path, validator) -> dict:
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=_invalid_constant)
    except (UnicodeError, ValueError) as error:
        raise ConfigurationError(f"Invalid JSON in {path.name}: {error}") from error
    _validate_json_values(value)
    validator(value)
    return value


def _encode(value: dict, validator) -> bytes:
    _validate_json_values(value)
    validator(value)
    try:
        return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise ConfigurationError(f"Configuration must contain valid JSON values: {error}") from error


@dataclass(frozen=True)
class Snapshot:
    data: dict
    revision: str | None


class JsonRepository:
    def __init__(self, path: Path, validator, default_factory=None, *, atomic_writer=None):
        self.path = Path(path)
        self.validator = validator
        self.default_factory = default_factory
        self._atomic_writer = atomic_writer

    def _write(self, path, content, **options):
        # Security records can supply private-file creation. Other repositories
        # retain the existing writer and its runtime failure/recovery behavior.
        return (self._atomic_writer or atomic_write_bytes)(path, content, **options)

    @property
    def backup_path(self) -> Path:
        return self.path.with_name(self.path.name + ".bak")

    def _raw(self) -> bytes | None:
        try:
            return self.path.read_bytes()
        except FileNotFoundError:
            return None

    def _check_revision(self, expected_revision) -> None:
        if _revision(self._raw()) != expected_revision:
            raise RevisionConflict(f"{self.path.name} changed; reload before saving.")

    def read(self, *, missing_ok: bool = True) -> Snapshot:
        with _lock(self.path):
            raw = self._raw()
            if raw is None:
                if not missing_ok or self.default_factory is None:
                    raise FileNotFoundError(f"Configuration file is missing: {self.path.name}")
                data = self.default_factory()
                self.validator(data)
                return Snapshot(data, None)
            return Snapshot(_decode(raw, self.path, self.validator), _revision(raw))

    def save(self, data: dict, *, expected_revision: str | None) -> Snapshot:
        # Copy and validate before creating directories, backups, or temporary files.
        value = copy.deepcopy(data)
        encoded = _encode(value, self.validator)
        with _lock(self.path):
            old = self._raw()
            if old is not None:
                _decode(old, self.path, self.validator)
            self._check_revision(expected_revision)
            if old is not None:
                self._write(self.backup_path, old)
            self._write(self.path, encoded,
                               before_replace=lambda: self._check_revision(expected_revision))
            return Snapshot(value, _revision(encoded))

    def restore_backup(self, *, expected_revision: str | None) -> Snapshot:
        """Explicitly restore a validated backup; never recover silently on read."""
        with _lock(self.path):
            raw = self.backup_path.read_bytes()
            value = _decode(raw, self.backup_path, self.validator)
            self._check_revision(expected_revision)
            old = self._raw()
            if old is not None:
                # Retain the replaced bytes, even when the primary is malformed.
                retained = self.path.with_name(self.path.name + ".before-restore")
                self._write(retained, old)
            self._write(self.path, raw,
                               before_replace=lambda: self._check_revision(expected_revision))
            return Snapshot(value, _revision(raw))

    def current_revision(self) -> str | None:
        """Read only a digest, including for a malformed file awaiting explicit recovery."""
        with _lock(self.path):
            return _revision(self._raw())


class CandidateRegistryRepository(JsonRepository):
    def __init__(self, path: Path):
        super().__init__(path, validate_candidate_registry, empty_registry)

    def read(self, *, missing_ok: bool = True) -> Snapshot:
        snapshot = super().read(missing_ok=missing_ok)
        return Snapshot(migrate_candidate_registry(snapshot.data), snapshot.revision)

    def get(self, candidate_id: str) -> dict:
        identifier(candidate_id, "candidateId")
        for candidate in self.read().data["candidates"]:
            if candidate["id"] == candidate_id:
                return candidate
        raise ConfigurationError(f"Unknown candidate ID '{candidate_id}'.")


class TemplateCatalogRepository(JsonRepository):
    def get(self, template_id: str) -> dict:
        identifier(template_id, "templateId")
        for template in self.read().data["templates"]:
            if template["id"] == template_id:
                return template
        raise ConfigurationError(f"Unknown template ID '{template_id}' in {self.path.name}.")


class PromptTemplateRepository(TemplateCatalogRepository):
    def __init__(self, path: Path):
        super().__init__(path, validate_prompt_catalog, empty_catalog)


class DocumentTemplateRepository(TemplateCatalogRepository):
    def __init__(self, path: Path):
        super().__init__(path, validate_document_catalog, empty_catalog)


class ProfileRepository:
    def __init__(self, directory: Path, candidates: CandidateRegistryRepository):
        self.directory = Path(directory)
        self.candidates = candidates

    def _record(self, candidate_id: str) -> JsonRepository:
        self.candidates.get(candidate_id)
        # Resolve only the config-side destination; never a candidate's history path.
        destination = (self.directory / f"{candidate_id}.json").resolve()
        if not destination.is_relative_to(self.directory.resolve()):
            raise ConfigurationError("Profile path is outside profiles/.")

        def validate_record(value):
            validate_profile(value)
            if value["candidateId"] != candidate_id:
                raise ConfigurationError("Profile candidateId does not match its filename.")

        return JsonRepository(destination, validate_record)

    def new(self, candidate_id: str) -> dict:
        self.candidates.get(candidate_id)
        return empty_profile(candidate_id)

    def read(self, candidate_id: str) -> Snapshot:
        return self._record(candidate_id).read()

    def save(self, profile: dict, *, expected_revision: str | None) -> Snapshot:
        validate_profile(profile)
        return self._record(profile["candidateId"]).save(profile, expected_revision=expected_revision)

    def restore_backup(self, candidate_id: str, *, expected_revision: str | None) -> Snapshot:
        return self._record(candidate_id).restore_backup(expected_revision=expected_revision)


class ConfigurationRepositories:
    """Explicit construction has no filesystem side effects; records are saved lazily."""

    def __init__(self, directory: Path):
        directory = Path(directory)
        self.candidates = CandidateRegistryRepository(directory / "candidates.json")
        self.profiles = ProfileRepository(directory / "profiles", self.candidates)
        self.prompts = PromptTemplateRepository(directory / "prompt-templates.json")
        self.documents = DocumentTemplateRepository(directory / "document-templates.json")
        self.extension_preferences = JsonRepository(directory / "extension-studio.json", validate_extension_preferences, empty_extension_preferences)
        self.extension_device = JsonRepository(directory / "local" / "extension-studio.json", validate_extension_device, empty_extension_device)

    def save_extension_settings(self, scope: str, fields: dict, *, expected_revision) -> Snapshot:
        allowed = {"preferences": {"setupPage", "confirmSetupCopy"}, "device": {"label", "extensionId", "probeTimeoutMs"}}
        if scope not in allowed or not isinstance(fields, dict) or fields.keys() - allowed[scope]:
            raise ConfigurationError("Only documented extension preference/device fields may be changed.")
        repository = self.extension_preferences if scope == "preferences" else self.extension_device
        snapshot = repository.read()
        snapshot.data.update(copy.deepcopy(fields))
        if scope == "device":
            snapshot.data.setdefault("id", uuid.uuid4().hex)
        return repository.save(snapshot.data, expected_revision=expected_revision)

    def validate_references(self, candidate: dict) -> None:
        if not isinstance(candidate, dict):
            raise ConfigurationError("Candidate must be an object.")
        prompts = self.prompts.read().data if candidate.get("assignedPromptTemplateId") else empty_catalog()
        documents = self.renderable_documents() if candidate.get("preferredDocumentTemplateId") else empty_catalog()
        validate_template_references(candidate, prompts, documents)

    def renderable_documents(self) -> dict:
        """Built-ins are memory defaults, never implicitly written to a catalog."""
        catalog = copy.deepcopy(self.documents.read().data)
        existing = {item["id"] for item in catalog["templates"]}
        catalog["templates"].extend(item for item in builtin_document_templates() if item["id"] not in existing)
        return catalog

    def update_candidate_settings(self, candidate_id: str, changes: dict, *, expected_revision) -> Snapshot:
        identifier(candidate_id, "candidateId")
        if not isinstance(changes, dict) or not changes or changes.keys() - {"assignedPromptTemplateId", "preferredDocumentTemplateId"}:
            raise ConfigurationError("Only prompt assignment and document preference may be changed here.")
        snapshot = self.candidates.read()
        candidate = next((item for item in snapshot.data["candidates"] if item["id"] == candidate_id), None)
        if candidate is None:
            raise ConfigurationError("Unknown candidate ID.")
        candidate.update(self.candidate_settings(changes, candidate))
        return self.candidates.save(snapshot.data, expected_revision=expected_revision)

    def candidate_settings(self, changes: dict, previous: dict) -> dict:
        if not isinstance(changes, dict) or changes.keys() - {"assignedPromptTemplateId", "preferredDocumentTemplateId"}:
            raise ConfigurationError("Invalid candidate template settings.")
        for field, reference in changes.items():
            if reference is not None and reference != previous.get(field):
                self.validate_references({field: reference})
                if field == "preferredDocumentTemplateId":
                    selected = next(item for item in self.renderable_documents()["templates"] if item["id"] == reference)
                    builtin = any(item["id"] == reference for item in builtin_document_templates())
                    if selected["layoutId"] not in {"classic", "modern"} or (selected["version"] != 1 if builtin else selected.get("rendererVersion") != 1):
                        raise ConfigurationError("This document template is not supported by the renderer.")
        return copy.deepcopy(changes)

    def save_document(self, fields: dict, *, template_id: str | None, expected_revision) -> Snapshot:
        if not isinstance(fields, dict) or fields.keys() - {"name", "description", "layoutId", "defaultSettings", "archived"}:
            raise ConfigurationError("Unsupported document template fields.")
        snapshot = self.documents.read()
        builtin_ids = {item["id"] for item in builtin_document_templates()}
        if template_id in builtin_ids:
            raise ConfigurationError("Built-in layouts are read-only. Duplicate one to customize it.")
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        if template_id is None:
            record = {"id": uuid.uuid4().hex, "version": 1, "description": "", "defaultSettings": {},
                      "rendererVersion": 1, "archived": False, "createdAt": now}
            snapshot.data["templates"].append(record)
        else:
            identifier(template_id, "templateId")
            record = next((item for item in snapshot.data["templates"] if item["id"] == template_id), None)
            if record is None:
                raise ConfigurationError("Unknown document template ID.")
            record["version"] += 1
        record.update(copy.deepcopy(fields))
        layout = next((item for item in builtin_document_templates() if item["layoutId"] == record.get("layoutId")), None)
        if layout is None:
            raise ConfigurationError("Choose the supported Classic or Modern layout.")
        record["rendererVersion"] = 1
        record.setdefault("createdAt", now)
        record["supportedSettings"] = layout["supportedSettings"]
        record["updatedAt"] = max(timestamp(now, "updatedAt"), timestamp(record["createdAt"], "createdAt")).isoformat()
        return self.documents.save(snapshot.data, expected_revision=expected_revision)

    def save_prompt(self, fields: dict, *, template_id: str | None, expected_revision) -> Snapshot:
        if not isinstance(fields, dict) or fields.keys() - {"name", "description", "body", "category", "isDefault", "archived"}:
            raise ConfigurationError("Unsupported prompt template fields.")
        snapshot = self.prompts.read()
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        if template_id is None:
            record = {"id": uuid.uuid4().hex, "version": 1, "createdAt": now,
                      "description": "", "category": "", "isDefault": False, "archived": False}
            snapshot.data["templates"].append(record)
        else:
            identifier(template_id, "templateId")
            record = next((item for item in snapshot.data["templates"] if item["id"] == template_id), None)
            if record is None:
                raise ConfigurationError("Unknown prompt template ID.")
            record["version"] += 1
        record.update(copy.deepcopy(fields))
        record["updatedAt"] = max(timestamp(now, "updatedAt"), timestamp(record["createdAt"], "createdAt")).isoformat()
        if record.get("archived"):
            record["isDefault"] = False
        if record.get("isDefault"):
            for other in snapshot.data["templates"]:
                if other is not record and other["isDefault"]:
                    other["isDefault"] = False
                    other["version"] += 1
                    other["updatedAt"] = max(timestamp(now, "updatedAt"), timestamp(other["createdAt"], "createdAt")).isoformat()
        return self.prompts.save(snapshot.data, expected_revision=expected_revision)

    def save_registry(self, data: dict, *, expected_revision: str | None) -> Snapshot:
        """Studio writes resolve references; legacy CRUD preserves inert reference IDs."""
        validate_candidate_registry(data)
        for candidate in data["candidates"]:
            self.validate_references(candidate)
        return self.candidates.save(data, expected_revision=expected_revision)
