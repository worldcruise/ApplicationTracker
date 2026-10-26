"""Versioned configuration contracts. Validation never opens candidate paths."""

from __future__ import annotations

import copy
import datetime as dt
import os
import math
from pathlib import Path
import re

from .document_settings import validate_document_settings


class ConfigurationError(ValueError):
    """Configuration is malformed, unsupported, or references a missing record."""


class RevisionConflict(ConfigurationError):
    """A caller attempted to replace a newer on-disk revision."""


IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")
EXTENSION_ID = re.compile(r"[a-p]{32}")
CANDIDATE_REFERENCES = ("assignedPromptTemplateId", "preferredDocumentTemplateId")
WINDOWS_DEVICES = {"con", "prn", "aux", "nul"} | {
    f"{prefix}{number}" for prefix in ("com", "lpt") for number in range(1, 10)
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ConfigurationError(message)


def object_value(value, label: str) -> dict:
    require(isinstance(value, dict), f"{label} must be an object.")
    return value


def text(value, label: str, *, nonempty: bool = False) -> str:
    require(isinstance(value, str), f"{label} must be text.")
    require(not nonempty or bool(value.strip()), f"{label} must not be empty.")
    return value


def identifier(value, label: str) -> str:
    text(value, label)
    require(bool(IDENTIFIER.fullmatch(value)) and value.casefold() not in WINDOWS_DEVICES,
            f"{label} must be a safe stable identifier.")
    return value


def version_one(record: dict, label: str) -> None:
    require(type(record.get("schemaVersion")) is int and record["schemaVersion"] == 1,
            f"Unsupported {label} schemaVersion; expected 1.")


def string_fields(record: dict, names, label: str) -> None:
    for name in names:
        if name in record:
            text(record[name], f"{label}.{name}")


def allowed_fields(record: dict, names, label: str) -> None:
    unknown = record.keys() - set(names)
    require(not unknown, f"{label} contains unsupported fields: {', '.join(sorted(unknown))}.")


def string_list(value, label: str) -> None:
    require(isinstance(value, list), f"{label} must be an array.")
    for item in value:
        text(item, label)


def unique_records(value, label: str) -> list:
    require(isinstance(value, list), f"{label} must be an array.")
    seen = set()
    for record in value:
        object_value(record, label)
        record_id = identifier(record.get("id"), f"{label}.id")
        require(record_id not in seen, f"{label} contains duplicate ID {record_id}.")
        seen.add(record_id)
    return value


def validate_candidate_registry(value) -> None:
    state = object_value(value, "Candidate registry")
    version_one(state, "candidate registry")
    candidates = unique_records(state.get("candidates"), "candidates")
    require("activeCandidateId" in state, "Candidate registry requires activeCandidateId.")
    identities = set()
    folders = set()
    for candidate in candidates:
        name = text(candidate.get("name"), "candidate.name", nonempty=True)
        require(len(name.strip()) <= 100, "Candidate name must be 1–100 characters.")
        extension_id = text(candidate.get("extensionId"), "candidate.extensionId")
        require(bool(EXTENSION_ID.fullmatch(extension_id)), "Invalid candidate extensionId.")
        history = text(candidate.get("historyFolder"), "candidate.historyFolder", nonempty=True)
        history_path = Path(history).expanduser()
        require(history_path.is_absolute(), "Candidate historyFolder must be absolute.")
        # Lexical checks only: do not inspect or resolve external history folders.
        folder_key = os.path.normcase(os.path.normpath(str(history_path)))
        require(folder_key not in folders, "Duplicate candidate historyFolder.")
        folders.add(folder_key)
        identity = (extension_id, name.strip().casefold())
        require(identity not in identities, "Duplicate candidate name and extensionId.")
        identities.add(identity)

        if candidate.get("promptFilePath"):
            linked = Path(text(candidate["promptFilePath"], "candidate.promptFilePath")).expanduser()
            require(linked.is_absolute() and linked.suffix.lower() in {".txt", ".md"},
                    "Candidate promptFilePath must be an absolute .txt or .md path.")
        else:
            relative = Path(text(candidate.get("promptTemplate"), "candidate.promptTemplate"))
            require(not relative.is_absolute() and len(relative.parts) >= 2
                    and relative.parts[0] == "templates" and ".." not in relative.parts,
                    "Candidate promptTemplate must stay under templates/.")
        for field in CANDIDATE_REFERENCES:
            if candidate.get(field) is not None:
                identifier(candidate[field], f"candidate.{field}")

    active_id = state["activeCandidateId"]
    require(active_id is None or (isinstance(active_id, str)
            and any(candidate["id"] == active_id for candidate in candidates)),
            "activeCandidateId does not reference an existing candidate.")


def migrate_candidate_registry(value) -> dict:
    """Version 1 is an identity migration. Other versions need explicit approval."""
    validate_candidate_registry(value)
    return copy.deepcopy(value)


def empty_registry() -> dict:
    return {"schemaVersion": 1, "activeCandidateId": None, "candidates": []}


def empty_catalog() -> dict:
    return {"schemaVersion": 1, "templates": []}


def empty_extension_preferences() -> dict:
    return {"schemaVersion": 1, "setupPage": "file-access", "confirmSetupCopy": True}


def validate_extension_preferences(value) -> None:
    record = object_value(value, "Extension preferences")
    version_one(record, "extension preferences")
    require(record.get("setupPage") in ("file-access", "legacy-popup"), "Choose file-access or legacy-popup as the setup page.")
    require(type(record.get("confirmSetupCopy")) is bool, "confirmSetupCopy must be boolean.")


def empty_extension_device() -> dict:
    return {"schemaVersion": 1, "label": "", "extensionId": "", "probeTimeoutMs": 4000}


def validate_extension_device(value) -> None:
    record = object_value(value, "Local extension settings")
    version_one(record, "local extension settings")
    if "id" in record:
        identifier(record["id"], "device.id")
    label = text(record.get("label"), "device.label")
    require(len(label) <= 80, "Device label must be at most 80 characters.")
    extension_id = text(record.get("extensionId"), "device.extensionId")
    require(not extension_id or bool(EXTENSION_ID.fullmatch(extension_id)), "Extension ID must contain 32 lowercase letters a–p, or be empty.")
    timeout = record.get("probeTimeoutMs")
    require(type(timeout) is int and 1000 <= timeout <= 15000, "Diagnostic timeout must be an integer from 1000 to 15000 milliseconds.")


ADDRESS_FIELDS = ("line1", "line2", "city", "state", "postalCode", "country")


def profile_extensions(value) -> None:
    """Keep JSON extension fields, but never turn profiles into credential stores."""
    if isinstance(value, dict):
        for key, item in value.items():
            require(isinstance(key, str), "Profile property names must be text.")
            require(key.casefold() not in {"password", "passwords", "credential", "credentials",
                                          "accesstoken", "refreshtoken", "secret"},
                    f"Profile credential field '{key}' is unsupported.")
            profile_extensions(item)
    elif isinstance(value, list):
        for item in value:
            profile_extensions(item)
    else:
        require(value is None or type(value) in (str, bool, int, float), "Profile extensions must be JSON values.")
        require(not isinstance(value, float) or math.isfinite(value), "Profile numbers must be finite.")


def address(value, label: str) -> None:
    record = object_value(value, label)
    string_fields(record, ADDRESS_FIELDS, label)


def period(value, label: str) -> None:
    record = object_value(value, label)
    string_fields(record, ("start", "end"), label)
    if "current" in record:
        require(type(record["current"]) is bool, f"{label}.current must be boolean.")


def empty_profile(candidate_id: str) -> dict:
    identifier(candidate_id, "candidateId")
    return {
        "schemaVersion": 1,
        "candidateId": candidate_id,
        "personal": {},
        "contact": {},
        "address": {},
        "workExperience": [],
        "education": [],
        "skills": [],
        "certifications": [],
        "customAnswers": {},
        "preferences": {},
    }


def validate_profile(value) -> None:
    record = object_value(value, "Profile")
    version_one(record, "profile")
    identifier(record.get("candidateId"), "profile.candidateId")
    profile_extensions(record)
    for field in ("personal", "contact", "address", "customAnswers", "preferences"):
        object_value(record.get(field), f"profile.{field}")
    personal = record["personal"]
    string_fields(personal, ("birthday", "headline", "summary"), "profile.personal")
    if personal.get("birthday"):
        try:
            dt.date.fromisoformat(personal["birthday"])
        except ValueError as error:
            raise ConfigurationError("profile.personal.birthday must be an ISO date.") from error
    contact = record["contact"]
    string_fields(contact, ("email", "phone"), "profile.contact")
    if "links" in contact:
        require(isinstance(contact["links"], list), "profile.contact.links must be an array.")
        for link in contact["links"]:
            object_value(link, "Contact link")
            text(link.get("label"), "Contact link.label")
            text(link.get("url"), "Contact link.url")
    address(record["address"], "profile.address")

    for work in unique_records(record.get("workExperience"), "profile.workExperience"):
        text(work.get("company"), "work.company")
        text(work.get("title"), "work.title")
        period(work.get("period"), "work.period")
        address(work.get("address"), "work.address")
        string_list(work.get("highlights"), "work.highlights")
    for education in unique_records(record.get("education"), "profile.education"):
        for field in ("university", "degree", "major"):
            text(education.get(field), f"education.{field}")
        period(education.get("period"), "education.period")
        address(education.get("address"), "education.address")
    require(isinstance(record.get("skills"), list), "profile.skills must be an array.")
    for skill in record["skills"]:
        object_value(skill, "Skill group")
        text(skill.get("category"), "skills.category")
        string_list(skill.get("items"), "skills.items")
    for certification in unique_records(record.get("certifications"), "profile.certifications"):
        text(certification.get("name"), "certification.name")
        string_fields(certification, ("issuer", "issuedOn", "expiresOn", "credentialUrl"),
                      "certification")
    answers = record["customAnswers"]
    string_fields(answers, ("reasonForLeaving", "noticePeriod"), "customAnswers")
    if "prompts" in answers:
        for prompt in unique_records(answers["prompts"], "customAnswers.prompts"):
            text(prompt.get("text"), "custom prompt.text")
    if "answers" in answers:
        for answer in unique_records(answers["answers"], "customAnswers.answers"):
            text(answer.get("question"), "custom answer.question", nonempty=True)
            text(answer.get("answer"), "custom answer.answer")
    string_fields(record["preferences"], ("startDate",), "preferences")


def timestamp(value, label: str) -> dt.datetime:
    text(value, label, nonempty=True)
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ConfigurationError(f"{label} must be an ISO timestamp.") from error
    require(parsed.tzinfo is not None, f"{label} must include a timezone.")
    return parsed


def catalog_records(value, label: str) -> list:
    record = object_value(value, label)
    version_one(record, label)
    records = unique_records(record.get("templates"), f"{label}.templates")
    for template in records:
        text(template.get("name"), f"{label}.name", nonempty=True)
        text(template.get("description"), f"{label}.description")
        require(type(template.get("version")) is int and template["version"] >= 1,
                f"{label}.version must be a positive integer.")
    return records


def validate_prompt_catalog(value) -> None:
    defaults = 0
    for template in catalog_records(value, "Prompt catalog"):
        text(template.get("body"), "prompt.body", nonempty=True)
        if "category" in template:
            text(template["category"], "prompt.category")
        for field in ("isDefault", "archived"):
            require(type(template.get(field)) is bool, f"prompt.{field} must be boolean.")
        require(not (template["isDefault"] and template["archived"]),
                "An archived prompt cannot be the default.")
        defaults += template["isDefault"]
        created = timestamp(template.get("createdAt"), "prompt.createdAt")
        updated = timestamp(template.get("updatedAt"), "prompt.updatedAt")
        require(updated >= created, "prompt.updatedAt must not precede createdAt.")
    require(defaults <= 1, "Prompt catalog may have only one default template.")


def validate_document_catalog(value) -> None:
    for template in catalog_records(value, "Document catalog"):
        identifier(template.get("layoutId"), "document.layoutId")
        if "rendererVersion" in template:
            require(type(template["rendererVersion"]) is int and template["rendererVersion"] == 1,
                    "Unsupported document rendererVersion; expected 1.")
        if "archived" in template:
            require(type(template["archived"]) is bool, "document.archived must be boolean.")
        for field in ("supportedSettings", "defaultSettings"):
            object_value(template.get(field), f"document.{field}")
        try:
            validate_document_settings(template)
        except ValueError as error:
            raise ConfigurationError(str(error)) from error
        if "thumbnail" in template:
            thumbnail = object_value(template["thumbnail"], "document.thumbnail")
            allowed_fields(thumbnail, ("reference", "generatedAt", "templateVersion"),
                           "document.thumbnail")
            string_fields(thumbnail, ("reference",), "document.thumbnail")
            if "generatedAt" in thumbnail:
                timestamp(thumbnail["generatedAt"], "thumbnail.generatedAt")
            if "templateVersion" in thumbnail:
                require(type(thumbnail["templateVersion"]) is int
                        and thumbnail["templateVersion"] >= 1,
                        "thumbnail.templateVersion must be a positive integer.")


def validate_template_references(candidate: dict, prompt_catalog: dict,
                                 document_catalog: dict) -> None:
    """Explicit Studio validation; legacy capture never resolves managed references."""
    object_value(candidate, "Candidate")
    for field, catalog, validator in (
        ("assignedPromptTemplateId", prompt_catalog, validate_prompt_catalog),
        ("preferredDocumentTemplateId", document_catalog, validate_document_catalog),
    ):
        reference = candidate.get(field)
        if reference is None:
            continue
        identifier(reference, field)
        validator(catalog)
        template = next((item for item in catalog["templates"] if item["id"] == reference), None)
        require(template is not None, f"{field} references missing template '{reference}'.")
        require(not template.get("archived", False),
                f"{field} references archived template '{reference}'.")
