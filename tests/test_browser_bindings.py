"""Synthetic browser enrollments; all credentials and files stay in temporary roots."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import os
from pathlib import Path
import secrets
from unittest.mock import patch

from auth_fixtures import AuthFixture, NEW_PASSWORD, USERNAME
from tracker_config.auth import AuthError
from tracker_config.browser_bindings import BrowserBindingRepository, BrowserPairingService, PAIRING_SECONDS, validate_bindings
from tracker_config.models import ConfigurationError, RevisionConflict
from tracker_config.repositories import CandidateRegistryRepository
from tracker_config.security_files import private_atomic_write


ORIGIN = "chrome-extension://" + "a" * 32


class BrowserBindingTests(AuthFixture):
    def setUp(self):
        super().setUp()
        self.registry = self.root / "candidates.json"
        self.registry.write_text(json.dumps({"schemaVersion": 1, "activeCandidateId": "candidate-one", "candidates": [
            {"id": name, "name": name, "extensionId": "a" * 32, "historyFolder": str(self.root / name), "promptTemplate": "templates/synthetic.txt"}
            for name in ("candidate-one", "candidate-two")]}), encoding="utf-8")
        self.original_registry = self.registry.read_bytes()
        self.candidates = CandidateRegistryRepository(self.registry)
        self.bindings = BrowserBindingRepository(self.repository)
        self.service = BrowserPairingService(self.bindings, self.candidates, "workspace-one", ORIGIN, clock=self.clock)
        self.owner_id = self.record["users"][0]["id"]
        self.addCleanup(lambda: self.assertEqual(self.registry.read_bytes(), self.original_registry))

    def create(self, service=None):
        secret = secrets.token_urlsafe(32)
        request = (service or self.service).create(self.owner_id, "Synthetic Chrome profile", ORIGIN, secret)
        return request, secret

    def enroll(self, candidate="candidate-one", service=None):
        service = service or self.service
        request, secret = self.create(service)
        service.decide(self.owner_id, request["id"], revision=1, candidate_id=candidate, approve=True)
        return service.claim(self.owner_id, request["id"], secret)

    def authorize(self, enrolled, revision=1, service=None):
        return (service or self.service).authorize_installation(self.owner_id, enrolled["installationId"], enrolled["installationCredential"], revision)

    def test_read_only_empty_listing_and_pending_creation_do_not_write_files(self):
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(self.service.listing(self.owner_id)["installations"], [])
        request, secret = self.create()
        self.assertEqual(self.service.claim(self.owner_id, request["id"], secret), {"state": "pending"})
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_one_time_claim_stores_only_digest_and_safe_views(self):
        request, secret = self.create()
        approval = self.service.decide(self.owner_id, request["id"], revision=1, candidate_id="candidate-one", approve=True)
        self.assertNotIn("credential", json.dumps(approval).lower())
        claimed = self.service.claim(self.owner_id, request["id"], secret)
        self.assertEqual(len(claimed["installationCredential"]), 43)
        raw = self.bindings.path.read_text()
        self.assertNotIn(secret, raw); self.assertNotIn(claimed["installationCredential"], raw)
        safe = self.service.listing(self.owner_id)
        self.assertNotIn("credentialDigest", json.dumps(safe)); self.assertNotIn(secret, json.dumps(safe))
        self.assertEqual(self.authorize(claimed)["candidateId"], "candidate-one")
        with self.assertRaises(AuthError) as failure:
            self.service.claim(self.owner_id, request["id"], secret)
        self.assertEqual(failure.exception.code, "pairing-consumed")

    def test_wrong_secret_and_approval_code_cannot_claim(self):
        request, secret = self.create()
        self.service.decide(self.owner_id, request["id"], revision=1, candidate_id="candidate-one", approve=True)
        for wrong in (secrets.token_urlsafe(32), request["approvalCode"]):
            with self.subTest(wrong_length=len(wrong)), self.assertRaises(AuthError):
                self.service.claim(self.owner_id, request["id"], wrong)
        self.assertFalse(self.bindings.path.exists())
        self.assertEqual(self.service.claim(self.owner_id, request["id"], secret)["state"], "claimed")

    def test_five_minute_boundary_expires_pending_and_approved_requests(self):
        for approve in (False, True):
            request, secret = self.create()
            if approve:
                self.service.decide(self.owner_id, request["id"], revision=1, candidate_id="candidate-one", approve=True)
            self.clock.now += PAIRING_SECONDS
            with self.assertRaises(AuthError) as failure:
                self.service.claim(self.owner_id, request["id"], secret)
            self.assertEqual((failure.exception.status, failure.exception.code), (410, "pairing-expired"))
        self.assertEqual(self.service.listing(self.owner_id)["requests"], [])
        self.assertFalse(self.bindings.path.exists())

    def test_denial_is_terminal_and_revision_conflicts_do_not_write(self):
        request, secret = self.create()
        with self.assertRaises(RevisionConflict):
            self.service.decide(self.owner_id, request["id"], revision=2, candidate_id="candidate-one", approve=True)
        self.service.decide(self.owner_id, request["id"], revision=1)
        with self.assertRaises(AuthError): self.service.claim(self.owner_id, request["id"], secret)
        with self.assertRaises(AuthError): self.service.decide(self.owner_id, request["id"], revision=2, candidate_id="candidate-one", approve=True)
        self.assertFalse(self.bindings.path.exists())

    def test_two_profiles_bind_different_candidates_and_reassignment_invalidates_old_context(self):
        first, second = self.enroll(), self.enroll("candidate-two")
        self.assertNotEqual(first["installationId"], second["installationId"])
        self.assertNotEqual(first["installationCredential"], second["installationCredential"])
        self.service.update_binding(self.owner_id, first["installationId"], revision=1, candidate_id="candidate-two")
        with self.assertRaises(RevisionConflict): self.authorize(first)
        self.assertEqual(self.authorize(first, 2)["candidateId"], "candidate-two")
        self.assertEqual(self.authorize(second)["candidateId"], "candidate-two")
        with self.assertRaises(AuthError):
            self.service.authorize_installation(self.owner_id, first["installationId"], second["installationCredential"], 2)

    def test_revocation_invalidates_all_previous_revisions_without_changing_other_profile(self):
        first, second = self.enroll(), self.enroll("candidate-two")
        row = self.service.update_binding(self.owner_id, first["installationId"], revision=1, revoke=True)
        self.assertEqual(row["bindingRevision"], 2)
        for revision in (1, 2):
            with self.assertRaises(AuthError): self.authorize(first, revision)
        with self.assertRaises(AuthError):
            self.service.update_binding(self.owner_id, first["installationId"], revision=2, candidate_id="candidate-two")
        self.assertTrue(self.authorize(second)["usable"])

    def test_invalid_owner_candidate_origin_and_types_are_rejected(self):
        with self.assertRaises(AuthError): self.service.listing("f" * 32)
        with self.assertRaises(AuthError): self.service.create(self.owner_id, "Browser", "chrome-extension://" + "b" * 32, secrets.token_urlsafe(32))
        for label in ("", "A" * 81, "Bad\nlabel", None):
            with self.assertRaises(AuthError): self.service.create(self.owner_id, label, ORIGIN, secrets.token_urlsafe(32))
        request, _ = self.create()
        for candidate in ("missing", "../escape", [], None):
            with self.assertRaises(AuthError): self.service.decide(self.owner_id, request["id"], revision=1, candidate_id=candidate, approve=True)
        with self.assertRaises(AuthError): self.service.decide(self.owner_id, request["id"], revision=True)
        self.assertFalse(self.bindings.path.exists())

    def test_authentication_reset_invalidates_credentials_and_pending_exchanges(self):
        enrolled = self.enroll(); request, secret = self.create()
        self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repository.read().revision)
        with self.assertRaises(AuthError): self.authorize(enrolled)
        with self.assertRaises(AuthError): self.service.claim(self.owner_id, request["id"], secret)
        self.assertFalse(self.service.listing(self.owner_id)["installations"][0]["usable"])

    def test_process_restart_loses_pending_exchanges_but_keeps_installations(self):
        enrolled = self.enroll(); request, secret = self.create()
        restarted = BrowserPairingService(BrowserBindingRepository(self.repository), self.candidates, "workspace-one", ORIGIN, clock=self.clock)
        self.assertTrue(self.authorize(enrolled, service=restarted)["usable"])
        with self.assertRaises(AuthError): restarted.claim(self.owner_id, request["id"], secret)

    def test_workspace_isolation_in_shared_private_store(self):
        first = self.enroll()
        other = BrowserPairingService(self.bindings, self.candidates, "workspace-two", ORIGIN, clock=self.clock)
        self.assertEqual(other.listing(self.owner_id)["installations"], [])
        with self.assertRaises(AuthError): self.authorize(first, service=other)
        self.enroll("candidate-two", other)
        self.assertEqual(len(self.service.listing(self.owner_id)["installations"]), 1)
        self.assertEqual(len(other.listing(self.owner_id)["installations"]), 1)

    def test_concurrent_claims_issue_exactly_one_credential(self):
        request, secret = self.create()
        self.service.decide(self.owner_id, request["id"], revision=1, candidate_id="candidate-one", approve=True)
        def claim(_):
            try: return self.service.claim(self.owner_id, request["id"], secret)["state"]
            except AuthError as error: return error.code
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(claim, range(6)))
        self.assertEqual(results.count("claimed"), 1)
        self.assertEqual(results.count("pairing-consumed"), 5)
        self.assertEqual(len(self.service.listing(self.owner_id)["installations"]), 1)

    def test_concurrent_reassignments_obey_binding_revision(self):
        enrolled = self.enroll()
        other = BrowserPairingService(BrowserBindingRepository(self.repository), self.candidates, "workspace-one", ORIGIN, clock=self.clock)
        def update(service):
            try:
                service.update_binding(self.owner_id, enrolled["installationId"], revision=1, candidate_id="candidate-two")
                return "saved"
            except RevisionConflict: return "conflict"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(update, (self.service, other)))
        self.assertCountEqual(results, ("saved", "conflict"))

    def test_failed_atomic_write_keeps_original_registry_and_retryable_claim(self):
        self.enroll(); original = self.bindings.path.read_bytes()
        request, secret = self.create()
        self.service.decide(self.owner_id, request["id"], revision=1, candidate_id="candidate-two", approve=True)
        with patch("tracker_config.security_files.os.replace", side_effect=OSError("Synthetic replacement failure")):
            with self.assertRaises(OSError): self.service.claim(self.owner_id, request["id"], secret)
        self.assertEqual(self.bindings.path.read_bytes(), original)
        self.assertEqual(self.service.claim(self.owner_id, request["id"], secret)["state"], "claimed")
        self.assertFalse(list(self.directory.glob(".security.json.*.tmp")))

    def test_corrupt_primary_backup_and_missing_primary_fail_closed(self):
        self.enroll(); self.enroll()
        original = self.bindings.path.read_bytes()
        for path in (self.bindings.path, self.bindings.record.backup_path):
            saved = path.read_bytes()
            private_atomic_write(path, b"{corrupt", permissions=self.repository.permissions)
            with self.assertRaises(ConfigurationError): self.service.listing(self.owner_id)
            self.assertEqual(path.read_bytes(), b"{corrupt")
            private_atomic_write(path, saved, permissions=self.repository.permissions)
        self.bindings.path.unlink()
        with self.assertRaises(ConfigurationError): self.service.listing(self.owner_id)
        self.assertFalse(self.bindings.path.exists())
        private_atomic_write(self.bindings.path, original, permissions=self.repository.permissions)

    def test_post_commit_failure_never_reissues_a_claim_credential(self):
        request, secret = self.create()
        self.service.decide(self.owner_id, request["id"], revision=1, candidate_id="candidate-one", approve=True)
        replace = os.replace
        def committed_failure(source, destination):
            replace(source, destination)
            if Path(destination) == self.bindings.path:
                raise OSError("Synthetic lost result after atomic commit")
        with patch("tracker_config.security_files.os.replace", side_effect=committed_failure):
            with self.assertRaises(OSError): self.service.claim(self.owner_id, request["id"], secret)
        with self.assertRaises(AuthError) as failure:
            self.service.claim(self.owner_id, request["id"], secret)
        self.assertEqual(failure.exception.code, "pairing-consumed")
        self.assertEqual(len(self.service.listing(self.owner_id)["installations"]), 1)

    def test_schema_rejects_plaintext_unknown_versions_and_duplicate_records(self):
        self.enroll()
        record = json.loads(self.bindings.path.read_text())
        for change in (lambda value: value.update(schemaVersion=2),
                       lambda value: value["installations"][0].update(installationCredential="plaintext"),
                       lambda value: value["installations"].append(copy.deepcopy(value["installations"][0])),
                       lambda value: value["installations"][0].update(bindingRevision=True)):
            invalid = copy.deepcopy(record); change(invalid)
            with self.assertRaises(ConfigurationError): validate_bindings(invalid)

    def test_private_permissions_protect_primary_and_backup_and_reject_broad_access(self):
        self.enroll(); self.enroll()
        for path in (self.bindings.path, self.bindings.record.backup_path): self.repository.permissions.validate(path)
        if os.name == "nt":
            from test_security_location import PrivateSecurityLocationTests
            helper = PrivateSecurityLocationTests(); helper.policy = self.repository.permissions
            helper.grant(self.bindings.path, "GR")
        else:
            self.bindings.path.chmod(0o644)
        with self.assertRaises(PermissionError): self.service.listing(self.owner_id)

    def test_request_rate_limit_does_not_write_and_recovers_after_window(self):
        for _ in range(10): self.create()
        with self.assertRaises(AuthError) as failure: self.create()
        self.assertEqual(failure.exception.status, 429)
        self.clock.now += PAIRING_SECONDS
        self.create()
        self.assertFalse(self.bindings.path.exists())
