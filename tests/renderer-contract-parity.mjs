import { validateCatalog } from "../extension/studio/contracts.mjs";
import { validateDocumentSettings } from "../extension/shared/document-settings.mjs";
import schema from "../extension/shared/data-contracts-v1.json" with { type: "json" };
import { createDataContracts, validateRenderInput } from "../extension/shared/data-contracts.mjs";
const contracts = createDataContracts(schema);
let source = "";
for await (const chunk of process.stdin) source += chunk;
const fixtures = JSON.parse(source);
const results = fixtures.map(record => {
  try {
    if (record.input !== undefined) validateRenderInput(contracts, record.input);
    else {
      validateCatalog({ schemaVersion: 1, templates: [record.template] }, "document");
      validateDocumentSettings(record.template, record.overrides);
    }
    return true;
  } catch { return false; }
});
process.stdout.write(JSON.stringify(results));
