"""Installation-scoped owner sessions; synthetic private stores only."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace
import hashlib
import json
import secrets
import threading
from unittest.mock import patch

from auth_fixtures import AuthFixture, USERNAME, PASSWORD, NEW_PASSWORD
from tracker_config import auth
from tracker_config.auth import AuthError, AuthService
from tracker_config.browser_bindings import BrowserBindingRepository, BrowserPairingService
from tracker_config.repositories import CandidateRegistryRepository


ORIGIN = "chrome-extension://" + "a" * 32


class ExtensionAuthFixture(AuthFixture):
    def setUp(self):
        super().setUp()
        self.registry = self.root / "candidates.json"
        self.registry.write_text(json.dumps({"schemaVersion": 1, "activeCandidateId": "candidate-two", "candidates": [
            {"id": candidate, "name": candidate, "extensionId": "a" * 32,
             "historyFolder": str(self.root / candidate), "promptTemplate": "templates/synthetic.txt"}
            for candidate in ("candidate-one", "candidate-two")]}), encoding="utf-8")
        self.original_registry = self.registry.read_bytes()
        self.pairings = BrowserPairingService(BrowserBindingRepository(self.repository),
            CandidateRegistryRepository(self.registry), "workspace-one", ORIGIN, clock=self.clock)
        self.owner_id = self.record["users"][0]["id"]
        self.first = self.enroll("candidate-one")
        self.second = self.enroll("candidate-two")
        self.addCleanup(lambda: self.assertEqual(self.registry.read_bytes(), self.original_registry))

    def enroll(self, candidate):
        secret = secrets.token_urlsafe(32)
        row = self.pairings.create(self.owner_id, "Synthetic Chrome", ORIGIN, secret)
        self.pairings.decide(self.owner_id, row["id"], revision=1, candidate_id=candidate, approve=True)
        return self.pairings.claim(self.owner_id, row["id"], secret)

    def proof(self, installation=None, *, credential=None, origin=ORIGIN, pairings=None):
        installation = installation or self.first
        return (pairings or self.pairings, installation["installationId"],
                installation["installationCredential"] if credential is None else credential, origin)

    def sign_in(self, installation=None, **options):
        return self.service.login_extension(USERNAME, PASSWORD, *self.proof(installation), **options)

    def session(self, issued, installation=None, **options):
        return self.service.extension_session(issued.token, *self.proof(installation), **options)

    def assert_error(self, status, code, function, *args, **options):
        with self.assertRaises(AuthError) as caught:
            function(*args, **options)
        self.assertEqual((caught.exception.status, caught.exception.code), (status, code))
        return caught.exception

    def rebind(self, installation=None, **options):
        row = installation or self.first
        return self.pairings.update_binding(self.owner_id, row["installationId"], revision=1, **options)


class ExtensionAuthenticationTests(ExtensionAuthFixture):
    def test_verified_scope_and_only_token_digest_are_stored_without_writing_configuration(self):
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        with patch.object(auth.secrets, "token_urlsafe", wraps=secrets.token_urlsafe) as random:
            issued = self.sign_in()
        random.assert_called_once_with(32)
        self.assertEqual(issued.metadata["context"]["candidate"], {"id": "candidate-one", "name": "candidate-one"})
        self.assertEqual(issued.metadata["context"]["bindingRevision"], 1)
        self.assertEqual(issued.metadata["session"], {"audience": "extension", "idleRemainingSeconds": 1800, "absoluteRemainingSeconds": 28800})
        stored = self.service._sessions[hashlib.sha256(issued.token.encode()).digest()]
        self.assertEqual(stored.audience, "extension")
        self.assertEqual(stored.extension_scope.installationId, self.first["installationId"])
        for secret in (issued.token, PASSWORD, self.first["installationCredential"]):
            self.assertNotIn(secret, json.dumps(asdict(stored)))
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_incorrect_and_unknown_owner_are_generic_and_issue_no_session(self):
        for username, password in ((USERNAME, "wrong"), ("unknown", PASSWORD)):
            error = self.assert_error(401, "invalid-credentials", self.service.login_extension, username, password, *self.proof())
            self.assertEqual(error.message, "Invalid username or password.")
        self.assertFalse(self.service._sessions)

    def test_installation_alone_is_not_owner_authentication(self):
        self.assert_error(401, "authentication-required", self.service.extension_session, self.first["installationCredential"], *self.proof())
        self.assert_error(401, "authentication-required", self.service.extension_session, None, *self.proof())

    def test_invalid_installation_or_origin_rejected_before_password_work(self):
        with patch.object(auth, "verify_password", side_effect=AssertionError("Hash must not run")):
            for credential in ("wrong", secrets.token_urlsafe(32)):
                self.assert_error(403, "installation-unavailable", self.service.login_extension,
                                  USERNAME, PASSWORD, *self.proof(credential=credential))
            self.assert_error(403, "invalid-origin", self.service.login_extension, USERNAME, PASSWORD,
                              *self.proof(origin="chrome-extension://" + "b" * 32))
        self.assertFalse(self.service._sessions)

    def test_two_installations_get_independent_candidates_without_active_candidate(self):
        first, second = self.sign_in(), self.sign_in(self.second)
        self.assertEqual(self.session(first)["context"]["candidate"]["id"], "candidate-one")
        self.assertEqual(self.session(second, self.second)["context"]["candidate"]["id"], "candidate-two")
        self.assert_error(401, "authentication-required", self.session, first, self.second)
        self.assert_error(401, "authentication-required", self.session, second, self.first)
        self.assertTrue(self.session(first)["authenticated"])

    def test_audiences_are_isolated_for_status_activity_logout_and_previous_token(self):
        web, extension = self.login(), self.sign_in()
        self.assert_error(401, "authentication-required", self.service.session, extension.token)
        self.assert_error(401, "authentication-required", self.service.session, extension.token, touch=True)
        self.assert_error(401, "authentication-required", self.service.extension_session, web.token, *self.proof())
        self.assert_error(401, "authentication-required", self.service.logout_extension, web.token, *self.proof())
        self.service.logout(extension.token)
        self.assertTrue(self.session(extension)["authenticated"])
        self.login(previous_token=extension.token)
        self.assertTrue(self.session(extension)["authenticated"])
        self.service.logout_extension(extension.token, *self.proof())
        self.assertTrue(self.service.session(web.token)["authenticated"])

    def test_rotation_only_replaces_its_installation_and_not_web_or_other_browser(self):
        web, other, first = self.login(), self.sign_in(self.second), self.sign_in()
        replacement = self.sign_in()
        self.assert_error(401, "authentication-required", self.session, first)
        self.assertTrue(self.session(replacement)["authenticated"])
        self.assertTrue(self.session(other, self.second)["authenticated"])
        self.assertTrue(self.service.session(web.token)["authenticated"])

    def test_simultaneous_logins_leave_exactly_one_session_for_the_installation(self):
        barrier = threading.Barrier(2)
        original = auth.verify_password
        def verify(*args):
            result = original(*args)
            barrier.wait(timeout=10)
            return result
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(auth, "verify_password", side_effect=verify):
            futures = [pool.submit(self.sign_in) for _ in range(2)]
            results = [future.result(timeout=15) for future in futures]
        self.assertEqual(len(self.service._sessions), 1)
        self.assertEqual(sum(self.service._digest(row.token) in self.service._sessions for row in results), 1)

    def test_logout_of_rotated_token_does_not_remove_replacement(self):
        old, new = self.sign_in(), self.sign_in()
        self.assert_error(401, "authentication-required", self.service.logout_extension, old.token, *self.proof())
        self.assertTrue(self.session(new)["authenticated"])

    def test_logout_requires_matching_installation_proof(self):
        issued = self.sign_in()
        self.assert_error(401, "authentication-required", self.service.logout_extension, issued.token, *self.proof(self.second))
        self.assert_error(403, "installation-unavailable", self.service.logout_extension, issued.token,
                          *self.proof(credential=secrets.token_urlsafe(32)))
        self.assertTrue(self.session(issued)["authenticated"])

    def test_status_does_not_renew_and_idle_boundary_cannot_be_revived(self):
        issued = self.sign_in()
        self.clock.now = 1799
        self.assertEqual(self.session(issued)["session"]["idleRemainingSeconds"], 1)
        self.clock.now = 1800
        self.assert_error(401, "authentication-required", self.session, issued, touch=True)

    def test_activity_renews_idle_but_never_absolute_lifetime(self):
        issued = self.sign_in()
        for now in range(1700, 28800, 1700):
            self.clock.now = now
            self.assertEqual(self.session(issued, touch=True)["session"]["idleRemainingSeconds"], 1800)
        self.clock.now = 28800
        self.assert_error(401, "authentication-required", self.session, issued, touch=True)

    def test_reassignment_invalidates_old_scope_but_new_login_resolves_current_binding(self):
        first, other = self.sign_in(), self.sign_in(self.second)
        self.rebind(candidate_id="candidate-two")
        self.assert_error(409, "binding-changed", self.session, first)
        new = self.sign_in()
        self.assertEqual(new.metadata["context"]["candidate"]["id"], "candidate-two")
        self.assertEqual(new.metadata["context"]["bindingRevision"], 2)
        self.assertTrue(self.session(other, self.second)["authenticated"])

    def test_revocation_invalidates_only_affected_installation(self):
        first, other = self.sign_in(), self.sign_in(self.second)
        self.rebind(revoke=True)
        self.assert_error(403, "installation-unavailable", self.session, first)
        self.assert_error(403, "installation-unavailable", self.sign_in)
        self.assertTrue(self.session(other, self.second)["authenticated"])

    def test_logout_can_revoke_exact_old_scope_after_reassignment_or_revocation(self):
        for installation, options in ((self.first, {"candidate_id": "candidate-two"}), (self.second, {"revoke": True})):
            issued = self.sign_in(installation)
            self.rebind(installation, **options)
            self.service.logout_extension(issued.token, *self.proof(installation))
            self.assertNotIn(self.service._digest(issued.token), self.service._sessions)

    def test_targeted_revocation_preserves_newer_sessions_and_other_audiences(self):
        web, first, other = self.login(), self.sign_in(), self.sign_in(self.second)
        self.rebind(candidate_id="candidate-two")
        fresh = self.sign_in()
        self.service.revoke_installation(self.first["installationId"], binding_revision=2)
        self.assertTrue(self.session(fresh)["authenticated"])
        self.assertTrue(self.session(other, self.second)["authenticated"])
        self.assertTrue(self.service.session(web.token)["authenticated"])
        self.assert_error(401, "authentication-required", self.session, first)

    def test_reassignment_during_hash_never_issues_session_for_changed_context(self):
        original = auth.verify_password
        def verify(*args):
            result = original(*args)
            self.rebind(candidate_id="candidate-two")
            return result
        with patch.object(auth, "verify_password", side_effect=verify):
            self.assert_error(409, "binding-changed", self.sign_in)
        self.assertFalse(self.service._sessions)

    def test_revocation_during_hash_never_issues_session(self):
        original = auth.verify_password
        def verify(*args):
            result = original(*args)
            self.rebind(revoke=True)
            return result
        with patch.object(auth, "verify_password", side_effect=verify):
            self.assert_error(403, "installation-unavailable", self.sign_in)
        self.assertFalse(self.service._sessions)

    def test_reset_during_hash_never_issues_session_under_new_generation(self):
        original = auth.verify_password
        def verify(*args):
            result = original(*args)
            self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repository.read().revision)
            return result
        with patch.object(auth, "verify_password", side_effect=verify):
            self.assert_error(401, "invalid-credentials", self.sign_in)
        self.assertFalse(self.service._sessions)

    def test_restart_reset_and_recovery_revoke_sessions_and_reset_requires_pairing_again(self):
        issued = self.sign_in()
        restarted = AuthService(self.repository, clock=self.clock)
        self.assert_error(401, "authentication-required", restarted.extension_session, issued.token, *self.proof())
        self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repository.read().revision)
        self.assert_error(401, "authentication-required", self.session, issued)
        self.assert_error(403, "installation-unavailable", self.service.login_extension, USERNAME, NEW_PASSWORD, *self.proof())
        self.write(self.repository.path, b"corrupt")
        recovery = self.repository.recovery_snapshot()
        self.repository.recover_backup(USERNAME, NEW_PASSWORD, expected_revision=recovery.revision,
                                       expected_backup_revision=recovery.backup_revision)
        self.assert_error(401, "authentication-required", self.session, issued)

    def test_deleted_candidate_is_denied_without_falling_back_to_active(self):
        issued = self.sign_in()
        rows = json.loads(self.original_registry)
        rows["candidates"] = [row for row in rows["candidates"] if row["id"] != "candidate-one"]
        self.registry.write_text(json.dumps(rows), encoding="utf-8")
        try:
            self.assert_error(403, "candidate-unavailable", self.session, issued)
            self.assert_error(403, "candidate-unavailable", self.sign_in)
        finally:
            self.registry.write_bytes(self.original_registry)

    def test_missing_and_corrupt_binding_store_fail_closed_without_recreation(self):
        issued = self.sign_in()
        path = self.pairings.repository.path
        original, backup = path.read_bytes(), self.pairings.repository.record.backup_path.read_bytes()
        for raw in (b"corrupt", b'{"schemaVersion":2,"installations":[]}', b'{"schemaVersion":1,"installations":[]}'):
            self.write(path, raw)
            error = self.assert_error(503 if raw != b'{"schemaVersion":1,"installations":[]}' else 403,
                "authentication-unavailable" if raw != b'{"schemaVersion":1,"installations":[]}' else "installation-unavailable", self.sign_in)
            self.assertNotIn("corrupt", str(error))
        self.write(path, original)
        path.unlink()
        self.assert_error(503, "authentication-unavailable", self.sign_in)
        self.assertFalse(path.exists())
        self.write(path, original)
        self.write(self.pairings.repository.record.backup_path, backup)
        self.assert_error(401, "authentication-required", self.session, issued)

    def test_corrupt_owner_storage_revokes_sessions_without_credential_disclosure(self):
        issued = self.sign_in()
        self.write(self.repository.path, b"corrupt")
        self.assert_error(503, "authentication-unavailable", self.session, issued)
        self.assertFalse(self.service._sessions)

    def test_scope_mismatch_backend_workspace_candidate_revision_and_origin_are_denied(self):
        for field, value in (("backendId", "f" * 32), ("workspaceId", "other-workspace"),
                             ("candidateId", "candidate-two"), ("bindingRevision", 2),
                             ("extensionOrigin", "chrome-extension://" + "b" * 32)):
            issued = self.sign_in()
            session = self.service._sessions[self.service._digest(issued.token)]
            session.extension_scope = replace(session.extension_scope, **{field: value})
            self.assert_error(409, "binding-changed", self.session, issued)

    def test_web_and_extension_share_the_global_attempt_budget(self):
        for index in range(10):
            function = self.service.login if index % 2 == 0 else self.service.login_extension
            args = () if index % 2 == 0 else self.proof()
            self.assert_error(401, "invalid-credentials", function, "unknown", "wrong", *args)
        self.assert_error(429, "rate-limited", self.sign_in)
        self.assert_error(429, "rate-limited", self.login)
        self.clock.now = 300
        self.assertTrue(self.sign_in().metadata["authenticated"])

    def test_web_and_extension_share_the_two_verification_slots(self):
        entered, release = threading.Barrier(3), threading.Event()
        original = auth.verify_password
        def verify(*args):
            entered.wait(timeout=10)
            if not release.wait(10):
                raise AssertionError("Synthetic verification timed out")
            return original(*args)
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(auth, "verify_password", side_effect=verify):
            futures = [pool.submit(self.login), pool.submit(self.sign_in)]
            try:
                entered.wait(timeout=10)
                self.assert_error(429, "rate-limited", self.sign_in, self.second)
            finally:
                release.set()
            for future in futures:
                future.result(timeout=10)

    def test_capacity_is_shared_and_rotation_does_not_evict_other_installations(self):
        with patch.object(auth, "verify_password", return_value=True), patch.object(self.service, "_attempt"):
            first = self.sign_in()
            web = [self.login() for _ in range(127)]
            self.assert_error(503, "session-capacity", self.sign_in, self.second)
            new = self.sign_in()
            self.assertEqual(len(self.service._sessions), 128)
            self.assertTrue(self.session(new)["authenticated"])
            self.assertTrue(self.service.session(web[0].token)["authenticated"])
            self.assert_error(503, "session-capacity", self.login, previous_token=new.token)
            self.assert_error(401, "authentication-required", self.session, first)

    def test_expiration_is_rechecked_after_private_storage_validation(self):
        issued = self.sign_in()
        original = self.pairings.candidates.get
        def slow_read(candidate_id):
            value = original(candidate_id)
            self.clock.now = 1800
            return value
        with patch.object(self.pairings.candidates, "get", side_effect=slow_read):
            self.assert_error(401, "authentication-required", self.session, issued, touch=True)

    def test_concurrent_old_logout_and_new_login_cannot_revoke_replacement(self):
        issued = self.sign_in()
        barrier = threading.Barrier(2)
        def logout():
            barrier.wait(timeout=10)
            try:
                self.service.logout_extension(issued.token, *self.proof())
            except AuthError as error:
                self.assertEqual(error.code, "authentication-required")
        def login():
            barrier.wait(timeout=10)
            return self.sign_in()
        with ThreadPoolExecutor(max_workers=2) as pool:
            old = pool.submit(logout)
            new = pool.submit(login)
            replacement = new.result(timeout=10)
            old.result(timeout=10)
        self.assertTrue(self.session(replacement)["authenticated"])
        self.assertEqual(len(self.service._sessions), 1)

    def test_failed_token_issuance_preserves_previously_valid_installation_session(self):
        issued = self.sign_in()
        with patch.object(auth.secrets, "token_urlsafe", return_value=issued.token):
            self.assert_error(503, "authentication-unavailable", self.sign_in)
        self.assertTrue(self.session(issued)["authenticated"])
        self.assertEqual(len(self.service._sessions), 1)

    def test_validation_and_reassignment_are_serialized_by_binding_transaction(self):
        issued = self.sign_in()
        entered, release, writer_started = threading.Event(), threading.Event(), threading.Event()
        original = self.pairings.candidates.get
        def candidate(candidate_id):
            entered.set()
            if not release.wait(10):
                raise AssertionError("Synthetic candidate lookup timed out")
            return original(candidate_id)
        def reassign():
            writer_started.set()
            return self.rebind(candidate_id="candidate-two")
        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(self.pairings.candidates, "get", side_effect=candidate):
            validation = pool.submit(self.session, issued)
            try:
                self.assertTrue(entered.wait(10))
                mutation = pool.submit(reassign)
                self.assertTrue(writer_started.wait(10))
                self.assertFalse(mutation.done())
            finally:
                release.set()
            self.assertEqual(validation.result(timeout=10)["context"]["candidate"]["id"], "candidate-one")
            self.assertEqual(mutation.result(timeout=10)["bindingRevision"], 2)
        self.assert_error(409, "binding-changed", self.session, issued)
