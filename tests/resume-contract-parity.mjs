// Only synthetic standard-input fixtures and checked-in contract definitions.
import { readFile } from "node:fs/promises";
import { createDataContracts, companyNamingStatus, resumeWarnings, buildRenderInput } from "../extension/shared/data-contracts.mjs";
const contracts = createDataContracts(JSON.parse(await readFile(new URL("../extension/shared/data-contracts-v1.json", import.meta.url), "utf8")));
let input = "";
for await (const chunk of process.stdin) input += chunk;
const fixtures = JSON.parse(input);
const results = fixtures.records.map(record => {
  try {
    if (record.response !== undefined) contracts.parseResumeResponse(record.response);
    else if (record.source !== undefined) contracts.parse(record.kind, record.source);
    else contracts.validate(record.kind, record.value);
    return { valid: true, issues: [] };
  } catch (error) {
    if (!error.issues) throw error;
    return { valid: false, issues: error.issues.map(({path, code}) => ({path, code})) };
  }
});
process.stdout.write(JSON.stringify({ results,
  companies: fixtures.companies.map(companyNamingStatus),
  warnings: fixtures.resumes.map(value => resumeWarnings(contracts, value)),
  renderInput: buildRenderInput(contracts, fixtures.renderOptions),
}));
