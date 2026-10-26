import definitions from "./document-layouts-v1.json" with { type: "json" };

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const equalRule = (value, expected) => object(value) && Object.keys(value).length === Object.keys(expected).length
  && Object.entries(expected).every(([key, entry]) => Object.hasOwn(value, key) && value[key] === entry);

export function getBuiltInDocumentTemplates() {
  return definitions.layouts.map(layout => ({ id: layout.id, layoutId: layout.id, version: layout.version,
    name: layout.name, description: layout.description, supportedSettings: structuredClone(definitions.supportedSettings),
    defaultSettings: structuredClone(layout.defaultSettings) }));
}

export function validateDocumentSettings(template, overrides = {}) {
  requireValue(object(template.supportedSettings) && object(template.defaultSettings), "Document settings must be objects.");
  requireValue(object(overrides), "Formatting overrides must be an object.");
  const layout = definitions.layouts.find(item => item.id === template.layoutId);
  if (!layout) {
    requireValue(!Object.keys(template.supportedSettings).length && !Object.keys(template.defaultSettings).length && !Object.keys(overrides).length,
      "Document settings must stay empty until a renderer supports this layout.");
    return {};
  }
  for (const [key, rule] of Object.entries(template.supportedSettings)) {
    requireValue(Object.hasOwn(definitions.supportedSettings, key) && equalRule(rule, definitions.supportedSettings[key]),
      `Unsupported setting definition: ${key}. Use the shipped renderer capability.`);
  }
  for (const [label, values] of [["defaultSettings", template.defaultSettings], ["formattingOverrides", overrides]]) {
    for (const [key, value] of Object.entries(values)) {
      requireValue(Object.hasOwn(template.supportedSettings, key), `${label}.${key} is unsupported by the selected template.`);
      const rule = definitions.supportedSettings[key];
      const valid = rule.type === "number" ? typeof value === "number" && Number.isFinite(value) && value >= rule.minimum && value <= rule.maximum
        : rule.type === "boolean" ? typeof value === "boolean"
        : typeof value === "string" && new RegExp(rule.pattern).exec(value)?.[0] === value;
      requireValue(valid, `${label}.${key} has an invalid value for the documented renderer setting.`);
    }
  }
  return { ...layout.defaultSettings, ...template.defaultSettings, ...overrides };
}
