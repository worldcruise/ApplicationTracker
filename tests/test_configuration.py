"""Persistence/model tests using the Phase 1 synthetic-data safety fixture."""

import copy
import base64
import hashlib
import json
from pathlib import Path
from unittest.mock import patch

import test_regression as regression
from tracker_config import (
    ConfigurationError, ConfigurationRepositories, RevisionConflict,
    empty_catalog, empty_profile, migrate_candidate_registry,
    validate_candidate_registry, validate_document_catalog, validate_profile,
    validate_prompt_catalog,
)
from tracker_config import repositories as persistence


class ConfigurationTests(regression.IsolatedApplicationTestCase):
    def setUp(self):
        super().setUp()
        self.repositories = ConfigurationRepositories(self.config)

    def prompt(self, template_id="prompt-one"):
        return {
            "id": template_id, "name": "Synthetic instructions", "description": "Test only",
            "body": "  Exact instructions.\r\n```json\n{\"example\": \"résumé\"}\n```\n",
            "version": 1, "category": "test", "isDefault": False, "archived": False,
            "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z",
        }

    def document(self, template_id="document-one"):
        return {
            "id": template_id, "name": "Future layout", "description": "Metadata only",
            "layoutId": "future-layout", "version": 1,
            "supportedSettings": {}, "defaultSettings": {},
        }

    def save_catalog(self, repository, *templates):
        return repository.save({"schemaVersion": 1, "templates": list(templates)},
                               expected_revision=repository.read().revision)

    def profile(self, candidate_id):
        record = empty_profile(candidate_id)
        record["personal"] = {"birthday": "1995-02-03", "headline": "Example role"}
        record["contact"] = {"email": "example@example.test", "phone": "555-0100",
                             "links": [{"label": "Portfolio", "url": "https://example.test"}]}
        record["address"] = {"line1": "1 Example Street", "line2": "", "city": "Example",
                             "state": "EX", "postalCode": "00000", "country": "US"}
        record["workExperience"] = [{
            "id": "work-one", "company": "Example Employer", "title": "Example role",
            "period": {"start": "2020-01", "end": "", "current": True},
            "address": {"city": "Example City"}, "highlights": ["Verified fixture text."],
        }]
        record["education"] = [{
            "id": "education-one", "university": "Example University",
            "degree": "Example degree", "major": "Example major",
            "period": {"start": "2015", "end": "2019", "current": False},
            "address": {"city": "Example City"},
        }]
        record["skills"] = [{"category": "Example skills", "items": ["Example skill"]}]
        record["certifications"] = [{"id": "certification-one", "name": "Example certificate",
                                     "issuer": "Example issuer"}]
        record["customAnswers"] = {"reasonForLeaving": "Example reason", "noticePeriod": "2 weeks",
                                    "prompts": [{"id": "custom-one", "text": "Exact custom text."}]}
        record["preferences"] = {"startDate": "2026-11-09"}
        return record

    def test_repositories_do_not_create_configuration_on_construction_or_missing_catalog_read(self):
        before = set(self.config.rglob("*"))
        self.assertEqual(self.repositories.prompts.read().data, empty_catalog())
        self.assertEqual(self.repositories.documents.read().data, empty_catalog())
        self.assertEqual(set(self.config.rglob("*")), before)
        self.registration.assert_not_called()

    def test_version_one_round_trip_preserves_both_legacy_modes_and_unknown_data(self):
        first = self.create_candidate()
        linked = self.root / "external-to-config.md"
        linked.write_text("Linked fixture instructions", encoding="utf-8")
        payload = self.payload("Jordan Example", "jordan")
        payload["promptFilePath"] = str(linked)
        second = self.manager.save_candidate(payload)["candidate"]
        state = self.manager.load_state()
        state["activeCandidateId"] = second["id"]
        state["futureRegistryMetadata"] = {"nested": [1, True, None, "unchanged"]}
        state["candidates"][0]["futureCandidateSettings"] = {"nested": ["keep"]}
        self.manager.save_state(state)
        original = self.registry.read_bytes()
        snapshot = self.repositories.candidates.read()
        self.assertEqual(snapshot.data, state)
        self.assertEqual(self.host.load_state(), state)
        self.assertEqual(self.registry.read_bytes(), original)
        result = self.repositories.candidates.save(snapshot.data, expected_revision=snapshot.revision)
        self.assertEqual(result.data, state)
        self.assertEqual(result.data["candidates"][0]["promptTemplate"], first["promptTemplate"])
        self.assertEqual(result.data["candidates"][1]["promptFilePath"], str(linked))

    def test_edit_preserves_nested_unknown_fields_and_optional_references(self):
        candidate = self.create_candidate()
        state = self.manager.load_state()
        additions = {
            "futureSettings": {"nested": [1, {"value": "unchanged"}]},
            "assignedPromptTemplateId": "future-prompt",
            "preferredDocumentTemplateId": "future-document",
        }
        state["candidates"][0].update(copy.deepcopy(additions))
        state["futureRegistryField"] = "keep"
        self.manager.save_state(state)
        result = self.manager.save_candidate(self.payload("Alex Renamed"), candidate["id"])
        self.assertEqual(result["candidate"]["id"], candidate["id"])
        for field, expected in additions.items():
            self.assertEqual(result["candidate"][field], expected)
        self.assertEqual(result["state"]["futureRegistryField"], "keep")

    def test_prompt_mode_switch_preserves_unknown_fields(self):
        candidate = self.create_candidate()
        state = self.manager.load_state()
        state["candidates"][0]["futureField"] = ["keep"]
        self.manager.save_state(state)
        linked = self.root / "linked.md"
        linked.write_text("Do not rewrite this linked prompt.\r\n", encoding="utf-8")
        original = linked.read_bytes()
        payload = self.payload()
        payload["promptFilePath"] = str(linked)
        switched = self.manager.save_candidate(payload, candidate["id"])["candidate"]
        self.assertNotIn("promptTemplate", switched)
        self.assertEqual(switched["futureField"], ["keep"])
        self.assertEqual(linked.read_bytes(), original)
        restored = self.manager.save_candidate(self.payload(), candidate["id"])["candidate"]
        self.assertNotIn("promptFilePath", restored)
        self.assertEqual(restored["futureField"], ["keep"])
        self.assertEqual(linked.read_bytes(), original)

    def test_registry_validation_rejects_bad_shapes_ids_and_active_references(self):
        candidate = self.create_candidate()
        good = self.manager.load_state()
        invalid = [None, [], {}, {**good, "schemaVersion": True},
                   {**good, "candidates": {}}, {**good, "activeCandidateId": "missing"},
                   {**good, "candidates": [candidate, candidate]}]
        for field, value in (("id", "../escape"), ("name", 42), ("extensionId", "q" * 32),
                             ("historyFolder", "relative"), ("promptTemplate", "../outside.txt"),
                             ("assignedPromptTemplateId", "../escape")):
            changed = copy.deepcopy(good)
            changed["candidates"][0][field] = value
            invalid.append(changed)
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(ConfigurationError):
                    validate_candidate_registry(value)

    def test_identity_migration_preserves_every_field_and_does_not_mutate_input(self):
        self.create_candidate()
        value = self.manager.load_state()
        value["future"] = {"nested": ["keep"]}
        original = copy.deepcopy(value)
        migrated = migrate_candidate_registry(value)
        self.assertEqual(migrated, original)
        migrated["future"]["nested"].append("separate copy")
        self.assertEqual(value, original)
        for version in (0, 2, "1", True):
            with self.subTest(version=version):
                with self.assertRaisesRegex(ConfigurationError, "schemaVersion"):
                    migrate_candidate_registry({**value, "schemaVersion": version})

    def test_invalid_registry_save_leaves_original_and_backup_untouched(self):
        self.create_candidate()
        repository = self.repositories.candidates
        snapshot = repository.read()
        original = self.registry.read_bytes()
        invalid = copy.deepcopy(snapshot.data)
        invalid["activeCandidateId"] = "missing"
        with self.assertRaises(ConfigurationError):
            repository.save(invalid, expected_revision=snapshot.revision)
        self.assertEqual(self.registry.read_bytes(), original)
        self.assertFalse(repository.backup_path.exists())

    def test_non_json_python_values_are_rejected_without_coercing_future_fields(self):
        repository = self.repositories.prompts
        for value in ({1: "not a JSON property name"}, ("not", "an array"), float("inf")):
            with self.subTest(value=value):
                invalid = {**empty_catalog(), "future": value}
                with self.assertRaises(ConfigurationError):
                    repository.save(invalid, expected_revision=None)
                self.assertFalse(repository.path.exists())

    def test_duplicate_properties_and_non_json_constants_are_not_silently_consumed(self):
        for raw in (b'{"schemaVersion":1,"schemaVersion":1,"templates":[]}',
                    b'{"schemaVersion":1,"templates":[],"future":NaN}',
                    b'{"schemaVersion":1,"templates":[],"future":1e400}', b"\xff"):
            with self.subTest(raw=raw):
                repository = self.repositories.prompts
                repository.path.write_bytes(raw)
                with self.assertRaises(ConfigurationError):
                    repository.read()
                with self.assertRaises(ConfigurationError):
                    repository.save(empty_catalog(), expected_revision=repository.current_revision())
                self.assertEqual(repository.path.read_bytes(), raw)
                self.assertFalse(repository.backup_path.exists())

    def test_stale_revision_is_rejected_across_repository_instances(self):
        self.create_candidate()
        original = self.repositories.candidates.read()
        other = ConfigurationRepositories(self.config).candidates
        changed = copy.deepcopy(original.data)
        changed["future"] = "newer"
        current = other.save(changed, expected_revision=original.revision)
        with self.assertRaisesRegex(RevisionConflict, "reload"):
            self.repositories.candidates.save(original.data, expected_revision=original.revision)
        self.assertEqual(self.repositories.candidates.read(), current)

    def test_create_requires_an_absent_file_revision(self):
        repository = self.repositories.prompts
        repository.save(empty_catalog(), expected_revision=None)
        with self.assertRaises(RevisionConflict):
            repository.save(empty_catalog(), expected_revision=None)

    def test_revision_is_rechecked_immediately_before_primary_replacement(self):
        repository = self.repositories.prompts
        original = repository.save(empty_catalog(), expected_revision=None)
        concurrent = json.dumps({"schemaVersion": 1, "templates": [], "future": "external"}).encode()
        real_replace = persistence.os.replace

        def external_write_after_backup(source, destination):
            real_replace(source, destination)
            if Path(destination) == repository.backup_path:
                repository.path.write_bytes(concurrent)

        with patch.object(persistence.os, "replace", side_effect=external_write_after_backup):
            with self.assertRaises(RevisionConflict):
                self.save_catalog(repository, self.prompt())
        self.assertEqual(repository.path.read_bytes(), concurrent)
        self.assertEqual(repository.backup_path.read_bytes(),
                         json.dumps(original.data, indent=2).encode() + b"\n")
        self.assertEqual(list(self.config.glob("*.tmp")), [])

    def test_primary_replace_failure_keeps_original_and_valid_backup(self):
        repository = self.repositories.prompts
        snapshot = repository.save(empty_catalog(), expected_revision=None)
        original = repository.path.read_bytes()
        real_replace = persistence.os.replace

        def fail_primary(source, destination):
            if Path(destination) == repository.path:
                raise PermissionError("primary is busy")
            return real_replace(source, destination)

        with patch.object(persistence.os, "replace", side_effect=fail_primary):
            with self.assertRaisesRegex(PermissionError, "primary is busy"):
                repository.save({"schemaVersion": 1, "templates": [self.prompt()]},
                                expected_revision=snapshot.revision)
        self.assertEqual(repository.path.read_bytes(), original)
        self.assertEqual(repository.backup_path.read_bytes(), original)
        self.assertEqual(list(self.config.glob("*.tmp")), [])

    def test_flush_failure_keeps_original_and_removes_temporary_file(self):
        repository = self.repositories.prompts
        snapshot = repository.save(empty_catalog(), expected_revision=None)
        original = repository.path.read_bytes()
        with patch.object(persistence.os, "fsync", side_effect=OSError("disk failure")):
            with self.assertRaisesRegex(OSError, "disk failure"):
                repository.save(empty_catalog(), expected_revision=snapshot.revision)
        self.assertEqual(repository.path.read_bytes(), original)
        self.assertEqual(list(self.config.glob("*.tmp")), [])

    def test_explicit_recovery_validates_backup_and_retains_malformed_primary(self):
        repository = self.repositories.prompts
        repository.save(empty_catalog(), expected_revision=None)
        self.save_catalog(repository, self.prompt())
        repository.path.write_bytes(b"{broken primary")
        with self.assertRaises(ConfigurationError):
            repository.read()
        self.assertEqual(repository.path.read_bytes(), b"{broken primary")
        revision = hashlib.sha256(b"{broken primary").hexdigest()
        restored = repository.restore_backup(expected_revision=revision)
        self.assertEqual(restored.data, empty_catalog())
        retained = repository.path.with_name(repository.path.name + ".before-restore")
        self.assertEqual(retained.read_bytes(), b"{broken primary")
        self.assertEqual(repository.read(), restored)

    def test_recovery_rejects_invalid_backup_and_stale_revision(self):
        repository = self.repositories.prompts
        original = repository.save(empty_catalog(), expected_revision=None)
        repository.backup_path.write_bytes(b"{broken backup")
        with self.assertRaises(ConfigurationError):
            repository.restore_backup(expected_revision=original.revision)
        self.assertEqual(repository.read(), original)
        repository.backup_path.write_bytes(repository.path.read_bytes())
        with self.assertRaises(RevisionConflict):
            repository.restore_backup(expected_revision="stale")
        self.assertEqual(repository.read(), original)

    def test_profile_round_trip_is_associated_with_registry_without_duplicate_identity(self):
        candidate = self.create_candidate()
        original_registry = self.registry.read_bytes()
        profile = self.profile(candidate["id"])
        self.repositories.profiles.save(profile, expected_revision=None)
        self.assertEqual(self.repositories.profiles.read(candidate["id"]).data, profile)
        self.assertTrue((self.config / "profiles" / f"{candidate['id']}.json").is_file())
        self.assertEqual(self.registry.read_bytes(), original_registry)
        self.assertNotIn("name", profile)
        self.assertNotIn("historyFolder", profile)
        self.assertNotIn("extensionId", profile)

    def test_new_profile_is_empty_and_does_not_read_prompt_or_write_files(self):
        candidate = self.create_candidate()
        # This factory may read the registry but must not open the candidate's prompt.
        with patch.object(self.host, "candidate_template", side_effect=AssertionError("No prompt import")):
            profile = self.repositories.profiles.new(candidate["id"])
        self.assertEqual(profile, empty_profile(candidate["id"]))
        self.assertFalse((self.config / "profiles").exists())

    def test_profile_validation_rejects_invalid_sections_and_plaintext_password_field(self):
        candidate = self.create_candidate()
        profile = self.profile(candidate["id"])
        validate_profile(profile)
        changes = (
            ("schemaVersion", 2), ("candidateId", "../escape"), ("skills", "not an array"),
            ("contact", {"password": "must not be accepted"}),
            ("personal", {"birthday": "not-a-date"}),
            ("address", {"city": 42}), ("preferences", {"startDate": 42}),
            ("workExperience", [{"id": "work-one"}]),
            ("education", profile["education"] * 2),
            ("certifications", [{"id": "cert-one", "name": False}]),
            ("customAnswers", {"prompts": "not an array"}),
        )
        for field, value in changes:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(profile)
                changed[field] = value
                with self.assertRaises(ConfigurationError):
                    self.repositories.profiles.save(changed, expected_revision=None)
        self.assertFalse((self.config / "profiles").exists())

    def test_profile_rejects_unknown_candidate_and_filename_mismatch(self):
        candidate = self.create_candidate()
        with self.assertRaisesRegex(ConfigurationError, "Unknown candidate"):
            self.repositories.profiles.new("missing")
        with self.assertRaises(ConfigurationError):
            self.repositories.profiles.read("../escape")
        directory = self.config / "profiles"
        directory.mkdir()
        wrong = empty_profile("different-candidate")
        (directory / f"{candidate['id']}.json").write_text(json.dumps(wrong), encoding="utf-8")
        with self.assertRaisesRegex(ConfigurationError, "filename"):
            self.repositories.profiles.read(candidate["id"])
        # A write must not silently repair an existing cross-candidate mismatch.
        with self.assertRaisesRegex(ConfigurationError, "filename"):
            self.repositories.profiles.save(empty_profile(candidate["id"]),
                                             expected_revision=hashlib.sha256(
                                                 (directory / f"{candidate['id']}.json").read_bytes()
                                             ).hexdigest())

    def test_profile_path_rejects_windows_device_identifiers(self):
        for candidate_id in ("CON", "nul", "COM1", "LPT9"):
            with self.subTest(candidate_id=candidate_id):
                with self.assertRaisesRegex(ConfigurationError, "safe stable identifier"):
                    empty_profile(candidate_id)

    def test_profile_preferences_are_isolated_by_candidate(self):
        first = self.create_candidate()
        second = self.create_candidate("Jordan Example", "jordan")
        for candidate, start_date in ((first, "2026-11-09"), (second, "2027-01-01")):
            record = empty_profile(candidate["id"])
            record["preferences"]["startDate"] = start_date
            self.repositories.profiles.save(record, expected_revision=None)
        first_snapshot = self.repositories.profiles.read(first["id"])
        first_snapshot.data["preferences"]["startDate"] = "2026-12-01"
        self.repositories.profiles.save(first_snapshot.data, expected_revision=first_snapshot.revision)
        self.assertEqual(self.repositories.profiles.read(second["id"]).data["preferences"],
                         {"startDate": "2027-01-01"})

    def test_profile_recovery_preserves_candidate_association(self):
        candidate = self.create_candidate()
        record = empty_profile(candidate["id"])
        initial = self.repositories.profiles.save(record, expected_revision=None)
        updated = copy.deepcopy(record)
        updated["preferences"]["startDate"] = "2026-11-09"
        self.repositories.profiles.save(updated, expected_revision=initial.revision)
        path = self.config / "profiles" / f"{candidate['id']}.json"
        path.write_bytes(b"{broken profile")
        restored = self.repositories.profiles.restore_backup(
            candidate["id"], expected_revision=hashlib.sha256(b"{broken profile").hexdigest()
        )
        self.assertEqual(restored.data, record)
        backup = path.with_name(path.name + ".bak")
        backup.write_text(json.dumps(empty_profile("different-candidate")), encoding="utf-8")
        with self.assertRaisesRegex(ConfigurationError, "filename"):
            self.repositories.profiles.restore_backup(candidate["id"],
                                                       expected_revision=restored.revision)
        self.assertEqual(self.repositories.profiles.read(candidate["id"]), restored)

    def test_prompt_catalog_round_trip_preserves_complete_body_exactly(self):
        prompt = self.prompt()
        original = copy.deepcopy(prompt)
        self.save_catalog(self.repositories.prompts, prompt)
        loaded = self.repositories.prompts.get(prompt["id"])
        self.assertEqual(loaded, original)
        self.assertEqual(loaded["body"], prompt["body"])
        self.assertEqual(prompt, original)

    def test_prompt_catalog_rejects_invalid_versions_timestamps_status_and_bodies(self):
        for field, value in (("id", "../escape"), ("name", " "), ("body", " "),
                             ("body", {}), ("version", True), ("version", 0),
                             ("isDefault", "true"), ("archived", 1),
                             ("createdAt", "2026-01-01"), ("updatedAt", "2025-01-01T00:00:00Z")):
            with self.subTest(field=field, value=value):
                prompt = self.prompt()
                prompt[field] = value
                with self.assertRaises(ConfigurationError):
                    validate_prompt_catalog({"schemaVersion": 1, "templates": [prompt]})
        prompt = self.prompt()
        with self.assertRaisesRegex(ConfigurationError, "duplicate ID"):
            validate_prompt_catalog({"schemaVersion": 1, "templates": [prompt, prompt]})
        first, second = self.prompt(), self.prompt("prompt-two")
        first["isDefault"] = second["isDefault"] = True
        with self.assertRaisesRegex(ConfigurationError, "only one default"):
            validate_prompt_catalog({"schemaVersion": 1, "templates": [first, second]})
        first["archived"] = True
        with self.assertRaisesRegex(ConfigurationError, "archived"):
            validate_prompt_catalog({"schemaVersion": 1, "templates": [first]})

    def test_document_catalog_accepts_only_metadata_and_empty_renderer_settings(self):
        document = self.document()
        document["thumbnail"] = {"reference": "future-thumbnail.png",
                                  "generatedAt": "2026-01-01T00:00:00Z", "templateVersion": 1}
        self.save_catalog(self.repositories.documents, document)
        self.assertEqual(self.repositories.documents.get(document["id"]), document)
        for field, value in (("layoutId", ""), ("version", 0),
                             ("supportedSettings", {"fontSize": "number"}),
                             ("defaultSettings", {"fontSize": 12}),
                             ("thumbnail", {"templateVersion": True})):
            with self.subTest(field=field, value=value):
                changed = {**document, field: value}
                with self.assertRaises(ConfigurationError):
                    validate_document_catalog({"schemaVersion": 1, "templates": [changed]})

    def test_reference_resolution_is_explicit_and_reports_missing_or_archived_templates(self):
        candidate = self.create_candidate()
        candidate["assignedPromptTemplateId"] = "prompt-one"
        candidate["preferredDocumentTemplateId"] = "document-one"
        with self.assertRaisesRegex(ConfigurationError, "assignedPromptTemplateId.*missing"):
            self.repositories.validate_references(candidate)
        self.save_catalog(self.repositories.prompts, self.prompt())
        with self.assertRaisesRegex(ConfigurationError, "preferredDocumentTemplateId.*missing"):
            self.repositories.validate_references(candidate)
        self.save_catalog(self.repositories.documents, self.document())
        self.repositories.validate_references(candidate)
        archived = self.prompt()
        archived["archived"] = True
        self.save_catalog(self.repositories.prompts, archived)
        with self.assertRaisesRegex(ConfigurationError, "archived"):
            self.repositories.validate_references(candidate)
        with self.assertRaisesRegex(ConfigurationError, "Unknown template ID"):
            self.repositories.documents.get("missing")

    def test_studio_registry_write_resolves_references_before_changing_files(self):
        self.create_candidate()
        snapshot = self.repositories.candidates.read()
        original = self.registry.read_bytes()
        snapshot.data["candidates"][0]["assignedPromptTemplateId"] = "prompt-one"
        with self.assertRaisesRegex(ConfigurationError, "missing template"):
            self.repositories.save_registry(snapshot.data, expected_revision=snapshot.revision)
        self.assertEqual(self.registry.read_bytes(), original)
        self.save_catalog(self.repositories.prompts, self.prompt())
        saved = self.repositories.save_registry(snapshot.data, expected_revision=snapshot.revision)
        self.assertEqual(saved.data, snapshot.data)

    def test_native_host_ignores_managed_references_and_keeps_legacy_prompt_authority(self):
        candidate = self.create_candidate()
        state = self.manager.load_state()
        state["activeCandidateId"] = candidate["id"]
        state["candidates"][0].update({"assignedPromptTemplateId": "missing-managed-prompt",
                                        "preferredDocumentTemplateId": "missing-managed-document",
                                        "future": {"keep": True}})
        self.manager.save_state(state)
        # Even malformed optional catalogs must not stop the independent legacy host.
        self.repositories.prompts.path.write_bytes(b"{broken optional catalog")
        self.registration.reset_mock()
        self.host.verify_caller(self.host.load_state(), regression.EXTENSION_ID, {
            "action": "check_company", "candidateName": candidate["name"].upper()
        })
        response = self.host.handle_get_active_profile({}, self.host.load_state())
        self.assertEqual(response["candidateId"], candidate["id"])
        self.assertEqual(response["promptTemplate"], "Tailor this synthetic resume.")
        self.registration.assert_not_called()
        self.process_guard.assert_not_called()

    def test_linked_prompt_is_not_imported_or_replaced_by_managed_catalog(self):
        linked = self.root / "external-linked.md"
        linked.write_text("Legacy tagged text contract", encoding="utf-8")
        payload = self.payload()
        payload["promptFilePath"] = str(linked)
        candidate = self.manager.save_candidate(payload)["candidate"]
        original = linked.read_bytes()
        managed = self.prompt()
        managed["body"] = "A different JSON-only contract"
        self.save_catalog(self.repositories.prompts, managed)
        self.assertEqual(self.host.candidate_template(candidate), "Legacy tagged text contract")
        self.assertEqual(linked.read_bytes(), original)
        linked.write_text("Updated legacy instructions", encoding="utf-8")
        self.assertEqual(self.host.candidate_template(candidate), "Updated legacy instructions")

    def test_host_save_function_keeps_archive_metadata_and_prompt_with_optional_fields(self):
        candidate = self.create_candidate()
        state = self.manager.load_state()
        state["activeCandidateId"] = candidate["id"]
        state["candidates"][0]["preferredDocumentTemplateId"] = "future-document"
        self.manager.save_state(state)
        state = self.host.load_state()
        message = {
            "action": "save_application", "candidateName": candidate["name"],
            "companyName": "Synthetic Company", "jobUrl": "https://example.test/job",
            "jobDescription": "Synthetic job text", "pageTitle": "Synthetic page",
            "mhtmlBase64": base64.b64encode(b"Synthetic MHTML bytes").decode("ascii"),
        }
        self.registration.reset_mock()
        self.host.verify_caller(state, regression.EXTENSION_ID, message)
        response = self.host.handle_save_application(message, state)
        folder = Path(response["folderPath"])
        self.assertTrue(folder.is_relative_to(self.root))
        self.assertEqual((folder / "job_description.mhtml").read_bytes(), b"Synthetic MHTML bytes")
        metadata = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["candidateId"], candidate["id"])
        self.assertEqual(metadata["jobUrl"], message["jobUrl"])
        self.assertEqual(metadata["files"], {"text": None, "mhtml": "job_description.mhtml", "prompt": None})
        self.assertEqual(response["finalPrompt"], self.host.build_final_prompt(
            "Tailor this synthetic resume.", "Synthetic Company", "Synthetic job text"
        ))
        self.registration.assert_not_called()
        self.process_guard.assert_not_called()

    def test_manager_detects_registry_changed_during_candidate_edit(self):
        candidate = self.create_candidate()
        snapshot = self.repositories.candidates.read()
        changed = copy.deepcopy(snapshot.data)
        changed["future"] = "concurrent change"
        original_writer = self.manager.write_text_atomic

        def update_registry_before_prompt_write(path, content):
            self.repositories.candidates.save(changed, expected_revision=snapshot.revision)
            original_writer(path, content)

        self.registration.reset_mock()
        with patch.object(self.manager, "write_text_atomic", side_effect=update_registry_before_prompt_write):
            with self.assertRaises(RevisionConflict):
                self.manager.save_candidate(self.payload("Attempted rename"), candidate["id"])
        self.assertEqual(self.manager.load_state(), changed)
        self.registration.assert_not_called()
