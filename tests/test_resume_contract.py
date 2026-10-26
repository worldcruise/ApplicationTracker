"""Synthetic resume contracts; no live configuration, prompts, or services."""

import copy
import importlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from tracker_config import resume as contract


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests/fixtures/resume-data.json"


def fixtures():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


class ResumeContractTests(unittest.TestCase):
    def setUp(self):
        self.data = fixtures()
        # Block accidental operations; these tests should only read source/fixtures.
        self.enterContext(patch("subprocess.run", side_effect=AssertionError("No external operations")))
        self.enterContext(patch("webbrowser.open", side_effect=AssertionError("No browser")))
        self.enterContext(patch("http.server.ThreadingHTTPServer", side_effect=AssertionError("No server")))

    def assert_invalid(self, kind, value, path):
        with self.assertRaises(contract.DataContractError) as caught:
            contract.validate_data(kind, value)
        self.assertIn(path, [issue["path"] for issue in caught.exception.issues])

    def render_options(self):
        return dict(registry=self.data["registry"], candidate_id="candidate-one", profile=self.data["profile"],
                    resume=self.data["resume"], documents=self.data["documents"],
                    document_template={"id": "document-one", "version": 1}, bindings=self.data["bindings"])

    def test_module_import_does_not_open_files_or_start_services(self):
        with patch.object(Path, "open", side_effect=AssertionError("No import-time I/O")):
            importlib.reload(contract)

    def test_reference_shape_and_complete_text_are_preserved_without_version_injection(self):
        value = self.data["resume"]
        value["summary"] = "  Exact Unicode résumé text.\r\n<script>literal text</script>  "
        before = copy.deepcopy(value)
        self.assertIs(contract.validate_resume(value), value)
        self.assertEqual(contract.parse_resume_response(json.dumps(value)), before)
        self.assertEqual(value, before)
        self.assertEqual(set(value), {"company", "title", "summary", "skills", "experience", "education"})

    def test_exactly_one_json_code_block_or_raw_json_is_accepted(self):
        source = json.dumps(self.data["resume"])
        for response in (source, f"```json\n{source}\n```", f" \n```\r\n{source}\r\n``` \n"):
            self.assertEqual(contract.parse_resume_response(response), self.data["resume"])
        for response in (f"Explanation\n```json\n{source}\n```", f"```json\n{source}\n```\nExplanation",
                         f"```json\n{source}\n```\n```json\n{source}\n```", "<resume>legacy text</resume>"):
            with self.assertRaises(contract.DataContractError):
                contract.parse_resume_response(response)

    def test_malformed_duplicate_and_nonfinite_json_is_rejected(self):
        for source in ("{", "null", "[]", '{"company":"One","company":"Two"}',
                       '{"company":NaN}', '{"company":1e400}', "```json\n{}\n```"):
            with self.subTest(source=source), self.assertRaises(contract.DataContractError):
                contract.parse_data("resume", source)

    def test_every_top_level_field_is_required(self):
        for field in self.data["resume"]:
            value = copy.deepcopy(self.data["resume"])
            del value[field]
            self.assert_invalid("resume", value, f"/{field}")

    def test_incorrect_types_and_empty_required_text_have_field_paths(self):
        for field, values in (("company", [None, 12, "", " \r\n", "\u0085\ufeff"]),
                              ("title", [True, ""]), ("summary", [{}, " "]),
                              ("skills", [{}]), ("experience", ["invalid"]), ("education", [None])):
            for value in values:
                self.assert_invalid("resume", {**self.data["resume"], field: value}, f"/{field}")

    def test_skill_groups_require_nonblank_category_names_and_nonempty_text_items(self):
        for skills, path in (([{}], "/skills/0"), ([[]], "/skills/0"),
                             ([{" ": ["Skill"]}], "/skills/0/ "),
                             ([{"Engineering": "Skill"}], "/skills/0/Engineering"),
                             ([{"Engineering": []}], "/skills/0/Engineering"),
                             ([{"Engineering": [42]}], "/skills/0/Engineering/0"),
                             ([{"Engineering": [""]}], "/skills/0/Engineering/0")):
            self.assert_invalid("resume", {**self.data["resume"], "skills": skills}, path)
        value = {**self.data["resume"], "skills": [{"A/B~C": ["Skill"], "Another": ["Skill"]}]}
        contract.validate_resume(value)
        value["skills"][0]["A/B~C"] = [None]
        self.assert_invalid("resume", value, "/skills/0/A~1B~0C/0")

    def test_experience_entries_require_title_company_and_sentence_array(self):
        for entry, path in (({}, "/experience/0/title"), (None, "/experience/0"),
                            ({"title": "Role", "company": "Employer", "sentences": []}, "/experience/0/sentences"),
                            ({"title": "Role", "company": "", "sentences": ["Text"]}, "/experience/0/company"),
                            ({"title": "Role", "company": "Employer", "sentences": [False]}, "/experience/0/sentences/0")):
            self.assert_invalid("resume", {**self.data["resume"], "experience": [entry]}, path)

    def test_education_entries_require_only_a_nonblank_degree(self):
        for education, path in ((["Degree"], "/education/0"), ([{}], "/education/0/degree"),
                                ([{"degree": " "}], "/education/0/degree"),
                                ([{"degree": "Degree", "university": "Invented"}], "/education/0/university")):
            self.assert_invalid("resume", {**self.data["resume"], "education": education}, path)

    def test_prompt_specific_counts_employers_lengths_and_education_are_not_schema_rules(self):
        value = {**self.data["resume"], "skills": [], "experience": [], "education": []}
        contract.validate_resume(value)
        self.assertEqual(len(contract.resume_warnings(value)), 3)
        value["experience"] = [{"title": "Any level", "company": "Any employer", "sentences": ["Short.", "Long " * 300]}]
        contract.validate_resume(value)

    def test_unknown_is_valid_and_does_not_trigger_a_structural_error(self):
        value = {**self.data["resume"], "company": "Unknown"}
        contract.validate_resume(value)
        self.assertTrue(contract.company_naming_status("Unknown")["usable"])
        self.assertEqual(contract.resume_warnings(value)[0]["code"], "company-unknown")

    def test_unusable_folder_names_require_manual_entry_without_repairing_resume(self):
        for company in ("A/B", "C:\\Example", ".", "..", "CON", "nul.txt", "LPT¹", "Trailing.", "Trailing ", "x" * 256, "😀" * 128):
            value = {**self.data["resume"], "company": company}
            contract.validate_resume(value)
            self.assertTrue(contract.company_naming_status(company)["requiresManualEntry"])
            self.assertEqual(contract.resume_warnings(value)[0]["code"], "company-folder")
            self.assertEqual(value["company"], company)
        for company in (None, "", "  "):
            self.assertTrue(contract.company_naming_status(company)["requiresManualEntry"])
        self.assertTrue(contract.company_naming_status("Example, Inc.")["requiresManualEntry"])
        self.assertTrue(contract.company_naming_status("Example & Partners")["usable"])

    def test_resume_rejects_metadata_profile_settings_and_cover_letter_fields(self):
        for field, value in (("schemaVersion", 1), ("candidateId", "candidate-one"), ("contact", {}),
                             ("job", self.data["job"]), ("documentTemplate", {}), ("coverLetter", "Letter")):
            self.assert_invalid("resume", {**self.data["resume"], field: value}, f"/{field}")

    def test_job_record_is_versioned_and_preserves_original_jd_separately(self):
        job = self.data["job"]
        before = copy.deepcopy(job)
        contract.validate_job_record(job)
        self.assertEqual(contract.parse_data("job", json.dumps(job)), before)
        self.assertEqual(job, before)
        for key in ("sourceUrl", "promptTemplate", "documentTemplate"):
            job.pop(key)
        contract.validate_job_record(job)  # Unknown provenance is omitted, never invented.
        for field, value in (("schemaVersion", 2), ("schemaVersion", True), ("createdAt", "2026-02-30T00:00:00Z"),
                             ("createdAt", "2026-01-01T00:00:00"), ("id", "../escape"),
                             ("candidateId", "CON"), ("jobDescription", ""), ("sourceUrl", "javascript:alert(1)"),
                             ("promptTemplate", {"id": "prompt", "version": 0}),
                             ("documentTemplate", {"id": "document"}), ("resume", self.data["resume"]),
                             ("clipboardText", "Combined JD and prompt")):
            self.assert_invalid("job", {**job, field: value}, f"/{field}" if field not in ("promptTemplate", "documentTemplate") else f"/{field}/version")

    def test_cover_letter_is_separate_plain_text_with_candidate_and_job_association(self):
        value = self.data["coverLetter"]
        contract.validate_cover_letter(value)
        value["paragraphs"][0] = "<script>Plain text, never executable markup.</script>"
        contract.validate_cover_letter(value)
        for field, bad in (("schemaVersion", 2), ("paragraphs", []), ("paragraphs", [""]),
                           ("jobId", ""), ("resume", self.data["resume"])):
            self.assert_invalid("coverLetter", {**value, field: bad}, f"/{field}" if bad != [""] else "/paragraphs/0")

    def test_render_input_joins_registry_profile_and_resume_without_mutation_or_guesses(self):
        options = self.render_options()
        before = copy.deepcopy(options)
        result = contract.build_render_input(**options)
        self.assertEqual(result["candidate"], {"id": "candidate-one", "name": "Alex Example"})
        self.assertEqual(result["resume"], self.data["resume"])
        self.assertEqual(result["profile"]["workExperience"][0]["period"]["start"], "2020-01")
        self.assertNotIn("name", result["profile"])
        self.assertEqual(result["resumeContractVersion"], 1)
        result["profile"]["contact"]["email"] = "independent@example.test"
        self.assertEqual(options, before)

    def test_render_input_rejects_wrong_candidate_missing_bindings_stale_template_and_unsupported_settings(self):
        for overrides in ({"candidate_id": "missing"}, {"profile": {**self.data["profile"], "candidateId": "other"}},
                          {"bindings": {"experience": [], "education": ["education-one"]}},
                          {"bindings": {"experience": ["missing"], "education": ["education-one"]}},
                          {"document_template": {"id": "document-one", "version": 2}},
                          {"document_template": {"id": "document-one", "version": True}},
                          {"formatting_overrides": None},
                          {"formatting_overrides": {"fontSize": 12}}):
            with self.subTest(overrides=overrides), self.assertRaises(contract.DataContractError):
                contract.build_render_input(**{**self.render_options(), **overrides})


class ResumeJavaScriptTests(unittest.TestCase):
    def setUp(self):
        self.node = shutil.which("node")
        if not self.node:
            installed = Path("C:/Program Files/nodejs/node.exe")
            self.node = str(installed) if installed.is_file() else None
        if not self.node:
            self.skipTest("Node.js unavailable; no software will be installed.")
        temporary = tempfile.TemporaryDirectory(prefix="resume-contract-tests-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def run_node(self, arguments, source=None):
        result = subprocess.run([self.node, *arguments], cwd=self.directory, input=source,
                                capture_output=True, text=True, encoding="utf-8", timeout=45, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_new_javascript_contract_suite(self):
        self.run_node(["--test", str(ROOT / "tests/resume-contract.test.mjs")])

    def test_python_and_javascript_agree_on_shared_schemas_errors_company_checks_and_render_inputs(self):
        data = fixtures()
        records = []
        for kind in ("resume", "job", "coverLetter"):
            good = data[kind]
            records.append({"kind": kind, "value": good})
            for field in good:
                missing = copy.deepcopy(good)
                missing.pop(field)
                records.append({"kind": kind, "value": missing})
                for bad in (None, True, 42, "", "\u0085\ufeff", [], {}):
                    records.append({"kind": kind, "value": {**good, field: bad}})
            records.append({"kind": kind, "value": {**good, "extra": "unsupported"}})
        for key, values in (("skills", [[{}], [{"A/B~C": [None]}], [{"One": ["Skill"], "Two": ["Skill"]}]]),
                            ("experience", [[{}], [None], [{"title": "Role", "company": "Employer", "sentences": [""]}]]),
                            ("education", [[{}], [{"degree": False}]])):
            for value in values:
                records.append({"kind": "resume", "value": {**data["resume"], key: value}})
        for date in ("2024-02-29T12:30:00.123456+01:30", "2026-02-29T00:00:00Z", "2026-01-01T00:00:00+01:60", "0000-01-01T00:00:00Z"):
            records.append({"kind": "job", "value": {**data["job"], "createdAt": date}})
        for url in ("https://example.test:65536/a", "http://[::1]/job", "https://user:password@example.test/", "https://example.test/has space",
                    "https://%/", "https://example.test/%ZZ", "https://-invalid.test/", "https://example.test/a%20b",
                    "https://example.test../job", "https://999.999.999.999/job"):
            records.append({"kind": "job", "value": {**data["job"], "sourceUrl": url}})
        for source in ("{", '{"company":"A","company":"B"}', '{"company":NaN}', '{"company":1e400}', json.dumps(data["resume"])):
            records.append({"kind": "resume", "source": source})
        for response in (f"```json\n{json.dumps(data['resume'])}\n```", "prose\n```json\n{}\n```", "```json\n{}\n```\n```json\n{}\n```"):
            records.append({"response": response})
        expected = []
        for record in records:
            try:
                if "response" in record:
                    contract.parse_resume_response(record["response"])
                elif "source" in record:
                    contract.parse_data(record["kind"], record["source"])
                else:
                    contract.validate_data(record["kind"], record["value"])
                expected.append({"valid": True, "issues": []})
            except contract.DataContractError as error:
                expected.append({"valid": False, "issues": [{"path": item["path"], "code": item["code"]} for item in error.issues]})
        companies = [None, "", "  ", "\u0085\ufeff", "Unknown", "Example & Partners", "A/B", "CON", "nul.txt", "LPT¹", "Trailing ", "😀" * 128]
        resumes = [data["resume"], {**data["resume"], "company": "Unknown"},
                   {**data["resume"], "company": "A/B", "skills": [], "experience": [], "education": []}]
        options = dict(registry=data["registry"], candidateId="candidate-one", profile=data["profile"],
                       resume=data["resume"], documents=data["documents"], documentTemplate={"id": "document-one", "version": 1}, bindings=data["bindings"])
        output = json.loads(self.run_node([str(ROOT / "tests/resume-contract-parity.mjs")],
                                         json.dumps(dict(records=records, companies=companies, resumes=resumes, renderOptions=options))))
        self.assertEqual(output["results"], expected)
        self.assertEqual(output["companies"], [contract.company_naming_status(company) for company in companies])
        self.assertEqual(output["warnings"], [contract.resume_warnings(resume) for resume in resumes])
        self.assertEqual(output["renderInput"], contract.build_render_input(
            registry=data["registry"], candidate_id="candidate-one", profile=data["profile"], resume=data["resume"],
            documents=data["documents"], document_template=options["documentTemplate"], bindings=data["bindings"]))
