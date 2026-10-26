"""Shared renderer capabilities; definitions are read lazily, never at import."""

import copy
from functools import lru_cache
import json
import math
from pathlib import Path
import re

_UNSET = object()


@lru_cache(maxsize=1)
def _definitions():
    source = Path(__file__).resolve().parents[1] / "extension/shared/document-layouts-v1.json"
    value = json.loads(source.read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1:
        raise ValueError("Unsupported document layout definitions.")
    return value


def builtin_document_templates():
    return [{"id": layout["id"], "layoutId": layout["id"], "version": layout["version"],
             "name": layout["name"], "description": layout["description"],
             "supportedSettings": copy.deepcopy(_definitions()["supportedSettings"]),
             "defaultSettings": copy.deepcopy(layout["defaultSettings"])}
            for layout in _definitions()["layouts"]]


def validate_document_settings(template, overrides=_UNSET):
    overrides = {} if overrides is _UNSET else overrides
    supported, defaults = template.get("supportedSettings"), template.get("defaultSettings")
    if not isinstance(supported, dict) or not isinstance(defaults, dict) or not isinstance(overrides, dict):
        raise ValueError("Document settings and formatting overrides must be objects.")
    # Unknown legacy layouts remain valid metadata only with empty settings.
    layout = next((item for item in _definitions()["layouts"] if item["id"] == template.get("layoutId")), None)
    if layout is None:
        if supported or defaults or overrides:
            raise ValueError("Document settings must stay empty until a renderer supports this layout.")
        return {}
    capabilities = _definitions()["supportedSettings"]
    for key, rule in supported.items():
        if key not in capabilities or rule != capabilities[key]:
            raise ValueError(f"Unsupported setting definition: {key}. Use the shipped renderer capability.")
    for label, values in (("defaultSettings", defaults), ("formattingOverrides", overrides)):
        for key, value in values.items():
            if key not in supported:
                raise ValueError(f"{label}.{key} is unsupported by the selected template.")
            rule = capabilities[key]
            if rule["type"] == "number":
                valid = type(value) in (int, float) and rule["minimum"] <= value <= rule["maximum"] and math.isfinite(value)
            elif rule["type"] == "boolean":
                valid = type(value) is bool
            else:
                valid = isinstance(value, str) and bool(re.fullmatch(rule["pattern"], value))
            if not valid:
                raise ValueError(f"{label}.{key} has an invalid value for the documented renderer setting.")
    return {**layout["defaultSettings"], **defaults, **overrides}
