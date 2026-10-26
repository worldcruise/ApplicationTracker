"""Resume data boundaries. Importing this module performs no file operations.

The canonical schema lives inside the extension package so browser consumers
never need imports outside that package. No renderer or persistence is invoked.
"""

from __future__ import annotations

import copy
import datetime as dt
from functools import lru_cache
import ipaddress
import json
import math
from pathlib import Path
import re

from .models import validate_candidate_registry, validate_document_catalog, validate_profile, identifier
from .document_settings import validate_document_settings


RESUME_CONTRACT_VERSION = 1
_UNSET = object()
SCHEMA_FILE = Path(__file__).resolve().parents[1] / "extension/shared/data-contracts-v1.json"
KEYWORDS = {"$ref", "type", "required", "properties", "additionalProperties", "minItems",
            "items", "minProperties", "propertyNames", "pattern", "minimum", "maximum",
            "const", "format"}
DEVICE = re.compile(r"(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])", re.IGNORECASE)
TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})")
WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class DataContractError(ValueError):
    def __init__(self, issues):
        self.issues = issues
        super().__init__("\n".join(f"{item['path'] or '/'}: {item['message']}" for item in issues))


def _issue(path, code, message):
    return {"path": path, "code": code, "message": message}


def _fail(path, code, message):
    raise DataContractError([_issue(path, code, message)])


def _pointer(path, key):
    return f"{path}/{str(key).replace('~', '~0').replace('/', '~1')}"


@lru_cache(maxsize=1)
def _schema():
    schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
    if schema.get("$id") != "urn:resume-tailoring-studio:data-contracts:1":
        raise RuntimeError("Unsupported data-contract definitions.")
    return schema


def _valid_timestamp(value):
    if not TIMESTAMP.fullmatch(value):
        return False
    try:
        # datetime accepts oversized offset minutes by normalizing them. Reject
        # those explicitly to keep the browser and Python contract identical.
        if value[-1] != "Z" and (int(value[-5:-3]) > 23 or int(value[-2:]) > 59):
            return False
        dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _valid_url(value):
    if not re.fullmatch(r'https?://[\x21-\x7e]+', value) or re.search(r'[\\<>"`{}|^]', value):
        return False
    match = re.fullmatch(r'https?://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?([/?#][\x21-\x7e]*)?', value)
    if not match or (match[2] and int(match[2]) > 65535) or re.search(r'%(?![0-9A-Fa-f]{2})', value):
        return False
    host = match[1]
    if host.startswith("["):
        try:
            ipaddress.IPv6Address(host[1:-1])
            return True
        except ValueError:
            return False
    return len(host) <= 253 and all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', part)
                                    for part in host.removesuffix(".").split("."))


def _walk(value, rule, path, issues):
    """Only the vocabulary used in our checked-in schema; not a general engine."""
    unknown = rule.keys() - KEYWORDS
    if unknown:
        raise RuntimeError(f"Unsupported contract keywords: {sorted(unknown)}")
    if "$ref" in rule:
        reference = rule["$ref"]
        if not reference.startswith("#/$defs/") or reference[8:] not in _schema()["$defs"]:
            raise RuntimeError("Invalid local contract reference.")
        return _walk(value, _schema()["$defs"][reference[8:]], path, issues)
    kind = rule["type"]
    integer = (type(value) in (int, float) and abs(value) <= 9007199254740991
               and value == int(value))
    valid_type = {"object": isinstance(value, dict), "array": isinstance(value, list),
                  "string": isinstance(value, str), "integer": integer}[kind]
    if not valid_type:
        issues.append(_issue(path, "type", f"Expected {kind}."))
        return
    add = lambda code, message: issues.append(_issue(path, code, message))
    if "const" in rule and value != rule["const"]:
        add("const", f"Expected {rule['const']}.")
    if kind == "string":
        try:
            value.encode("utf-8")
        except UnicodeError:
            add("unicode", "Text must contain valid Unicode characters.")
        if "pattern" in rule and not re.search(rule["pattern"], value):
            add("pattern", "Text must be nonblank and match the documented field format.")
        if rule.get("format") == "stable-id" and (DEVICE.fullmatch(value)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", value)):
            add("format", "Use a safe stable identifier, not a Windows device name.")
        if rule.get("format") == "date-time" and not _valid_timestamp(value):
            add("format", "Use YYYY-MM-DDTHH:MM:SS[.ffffff]Z or a numeric timezone offset.")
        if rule.get("format") == "http-url" and not _valid_url(value):
            add("format", "Use an absolute ASCII HTTP(S) URL without credentials.")
    elif kind == "integer":
        if value < rule.get("minimum", float("-inf")) or value > rule.get("maximum", float("inf")):
            add("range", "Integer is outside the supported range.")
    elif kind == "array":
        if len(value) < rule.get("minItems", 0):
            add("empty", "Array must contain at least one entry.")
        for index, entry in enumerate(value):
            _walk(entry, rule["items"], _pointer(path, index), issues)
    else:
        if len(value) < rule.get("minProperties", 0):
            add("empty", "Object must contain at least one category.")
        for key in rule.get("required", []):
            if key not in value:
                issues.append(_issue(_pointer(path, key), "required", "Required field is missing."))
        for key, entry in value.items():
            entry_path = _pointer(path, key)
            if not isinstance(key, str):
                issues.append(_issue(entry_path, "type", "JSON property names must be text."))
                continue
            if "propertyNames" in rule:
                _walk(key, rule["propertyNames"], entry_path, issues)
            if key in rule.get("properties", {}):
                _walk(entry, rule["properties"][key], entry_path, issues)
            elif rule.get("additionalProperties") is False:
                issues.append(_issue(entry_path, "unsupported", "Field is not part of this contract."))
            elif isinstance(rule.get("additionalProperties"), dict):
                _walk(entry, rule["additionalProperties"], entry_path, issues)


def validate_data(kind, value):
    if kind not in ("resume", "job", "coverLetter"):
        raise ValueError("Unknown data contract.")
    issues = []
    _walk(value, _schema()["$defs"][kind], "", issues)
    if issues:
        raise DataContractError(issues)
    return value


def validate_resume(value):
    return validate_data("resume", value)


def validate_job_record(value):
    return validate_data("job", value)


def validate_cover_letter(value):
    return validate_data("coverLetter", value)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON property.")
        result[key] = value
    return result


def parse_data(kind, source):
    if not isinstance(source, str):
        _fail("", "json", "Provide JSON text.")
    try:
        value = json.loads(source, object_pairs_hook=_unique_object, parse_float=_finite_number,
                           parse_constant=lambda value: _fail("", "json", "JSON numbers must be finite."))
    except (ValueError, RecursionError) as error:
        raise DataContractError([_issue("", "json", "Invalid JSON: check syntax, duplicate properties, and finite numbers.")]) from error
    return validate_data(kind, value)


def _finite_number(source):
    value = float(source)
    if not math.isfinite(value):
        raise ValueError("JSON numbers must be finite.")
    return value


def parse_resume_response(source):
    if not isinstance(source, str):
        _fail("", "json", "Provide the JSON response as text.")
    match = re.fullmatch(r"[ \t\r\n]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t\r\n]*", source)
    return parse_data("resume", match[1] if match else source)


def company_naming_status(value):
    reason = None
    if not isinstance(value, str) or not value.strip(WHITESPACE):
        reason = "Enter a company name."
    else:
        try:
            length = len(value.encode("utf-16-le")) // 2
        except UnicodeError:
            length = 256
        if (re.search(r'[<>:"/\\|?*\x00-\x1f]', value) or value.endswith((".", " "))
                or length > 255 or DEVICE.fullmatch(value.split(".")[0].rstrip(" "))):
            reason = "Enter a company name usable as one Windows folder component."
    return {"usable": reason is None, "requiresManualEntry": reason is not None, "reason": reason}


def resume_warnings(resume):
    validate_resume(resume)
    warnings = []
    naming = company_naming_status(resume["company"])
    if not naming["usable"]:
        warnings.append(_issue("/company", "company-folder", naming["reason"]))
    if resume["company"].strip(WHITESPACE).lower() == "unknown":
        warnings.append(_issue("/company", "company-unknown", "Company is Unknown; confirm it before saving."))
    for key in ("skills", "experience", "education"):
        if not resume[key]:
            warnings.append(_issue(f"/{key}", "empty-section", "Section is empty; review document readiness."))
    return warnings


def validate_render_input(value):
    keys = {"schemaVersion", "resumeContractVersion", "candidate", "profile", "resume",
            "documentTemplate", "formattingOverrides", "bindings"}
    if not isinstance(value, dict) or value.keys() != keys:
        _fail("", "type", "Provide the complete versioned rendering input from build_render_input.")
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
            or type(value["resumeContractVersion"]) is not int or value["resumeContractVersion"] != RESUME_CONTRACT_VERSION):
        _fail("/schemaVersion", "version", "Unsupported rendering input or resume contract version; expected 1.")
    candidate, profile, resume = value["candidate"], value["profile"], value["resume"]
    document_template, overrides, bindings = value["documentTemplate"], value["formattingOverrides"], value["bindings"]
    def guard(path, operation):
        try:
            operation()
        except ValueError as error:
            raise DataContractError([_issue(path, "configuration", "Provide a valid, associated configuration record.")]) from error

    if not isinstance(candidate, dict) or candidate.keys() != {"id", "name"}:
        _fail("/candidate", "configuration", "Provide a valid candidate identity from the registry.")
    guard("/candidate", lambda: identifier(candidate["id"], "candidate.id"))
    if not isinstance(candidate["name"], str) or not candidate["name"].strip():
        _fail("/candidate", "configuration", "Provide a candidate name from the registry.")
    try:
        candidate["name"].encode("utf-8")
    except UnicodeError:
        _fail("/candidate", "configuration", "Candidate name must contain valid Unicode.")
    guard("/profile", lambda: validate_profile(profile))
    if profile["candidateId"] != candidate["id"]:
        _fail("/profile", "configuration", "Provide a valid, associated configuration record.")
    validate_resume(resume)
    guard("/documentTemplate", lambda: validate_document_catalog({"schemaVersion": 1, "templates": [document_template]}))
    if document_template.get("archived"):
        _fail("/documentTemplate", "reference", "Select an available document template.")
    try:
        if not isinstance(overrides, dict):
            raise ValueError("Formatting overrides must be an object.")
        validate_document_settings(document_template, overrides)
    except ValueError as error:
        _fail("/formattingOverrides", "unsupported", str(error))
    if not isinstance(bindings, dict) or bindings.keys() - {"experience", "education"}:
        _fail("/bindings", "reference", "Provide explicit experience and education profile-ID bindings.")
    for section, profile_section in (("experience", "workExperience"), ("education", "education")):
        ids = bindings.get(section)
        if not isinstance(ids, list) or len(ids) != len(resume[section]):
            _fail(f"/bindings/{section}", "reference", "Bind every generated entry explicitly to a profile entry ID.")
        for index, entry_id in enumerate(ids):
            if not isinstance(entry_id, str) or not any(entry["id"] == entry_id for entry in profile[profile_section]):
                _fail(f"/bindings/{section}/{index}", "reference", "Profile entry ID is missing; resolve the association explicitly.")
    return value


def build_render_input(*, registry, candidate_id, profile, resume, documents,
                       document_template, bindings, formatting_overrides=_UNSET):
    try:
        validate_candidate_registry(registry)
        validate_document_catalog(documents)
    except ValueError as error:
        raise DataContractError([_issue("/candidate", "configuration", "Provide a valid registry and document catalog.")]) from error
    candidate = next((item for item in registry["candidates"] if item["id"] == candidate_id), None)
    if candidate is None:
        _fail("/candidate/id", "reference", "Candidate is absent from the authoritative registry.")
    reference_issues = []
    _walk(document_template, _schema()["$defs"]["templateReference"], "/documentTemplate", reference_issues)
    if reference_issues:
        raise DataContractError(reference_issues)
    selected = next((item for item in documents["templates"] if item["id"] == document_template["id"]
                     and item["version"] == document_template["version"] and not item.get("archived")), None)
    if selected is None:
        _fail("/documentTemplate", "reference", "Select an available document template with its current version.")
    result = {"schemaVersion": 1, "resumeContractVersion": RESUME_CONTRACT_VERSION,
              "candidate": {"id": candidate["id"], "name": candidate["name"]},
              "profile": profile, "resume": resume, "documentTemplate": selected,
              "formattingOverrides": {} if formatting_overrides is _UNSET else formatting_overrides, "bindings": bindings}
    validate_render_input(result)
    return copy.deepcopy(result)
