"""Owner/session service tests, with synthetic private storage and fake time."""
import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import copy
import hashlib
import json
import secrets
import threading
from unittest.mock import patch

from auth_fixtures import AuthFixture, PASSWORD, NEW_PASSWORD, USERNAME
from tracker_config import auth
from tracker_config.auth import AuthError, AuthService


class AuthenticationTests(AuthFixture):
    def assert_error(self, code, function, *args, **kwargs):
        with self.assertRaises(AuthError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_login_uses_verified_owner_and_exactly_32_random_token_bytes(self):
        with patch.object(auth.secrets, "token_urlsafe", wraps=secrets.token_urlsafe) as random:
            issued = self.login()
        random.assert_called_once_with(32)
        self.assertEqual(len(base64.urlsafe_b64decode(issued.token + "=")), 32)
        self.assertEqual(issued.metadata["user"], {"id": self.record["users"][0]["id"], "username": USERNAME, "role": "owner"})
        self.assertEqual(issued.metadata["session"], {"idleRemainingSeconds": 1800, "absoluteRemainingSeconds": 28800})
        self.assertEqual(len(self.service._sessions), 1)
        self.assertIn(hashlib.sha256(issued.token.encode()).digest(), self.service._sessions)
        self.assertNotIn(issued.token, repr(self.service._sessions))
        self.assertNotIn(PASSWORD, repr(self.service._sessions))
        self.assertNotIn("passwordVerifier", repr(self.service._sessions))
        session = next(iter(self.service._sessions.values()))
        self.assertNotIn(issued.token, json.dumps(asdict(session)))
        self.assertNotIn(PASSWORD, json.dumps(asdict(session)))
        self.assertEqual(set(asdict(session)), {"user_id", "backend_id", "auth_epoch", "generation", "created", "last_activity", "audience", "extension_scope"})
        self.assertEqual((session.audience, session.extension_scope), ("web", None))
        self.assertEqual((session.created, session.last_activity), (0, 0))

    def test_incorrect_unknown_and_disabled_credentials_have_identical_failures_and_hash_work(self):
        original = auth.verify_password
        with patch.object(auth, "verify_password", wraps=original) as verify:
            errors = [self.assert_error("invalid-credentials", self.service.login, username, password)
                      for username, password in ((USERNAME, "wrong"), ("unknown-owner", PASSWORD), ("invalid name", PASSWORD))]
            self.record["users"][0]["disabled"] = True
            self.write(self.repository.path, json.dumps(self.record).encode())
            errors.append(self.assert_error("invalid-credentials", self.service.login, USERNAME, PASSWORD))
        self.assertEqual(verify.call_count, 4)
        self.assertEqual({(error.status, error.message) for error in errors}, {(401, "Invalid username or password.")})
        self.assertFalse(self.service._sessions)

    def test_missing_wrong_type_empty_and_oversized_credentials_are_rejected(self):
        for username, password in ((None, PASSWORD), (USERNAME, None), (USERNAME, 4), ("", PASSWORD),
                                   (USERNAME, ""), ("a" * 65, PASSWORD), (USERNAME, "x" * 1025), (USERNAME, "\ud800")):
            self.assert_error("invalid-request", self.service.login, username, password)
        self.assertFalse(self.service._sessions)

    def test_global_rate_limit_cannot_be_bypassed_with_other_usernames_and_recovers_at_boundary(self):
        for index in range(10):
            self.assert_error("invalid-credentials", self.service.login, f"unknown-{index}", "wrong")
        error = self.assert_error("rate-limited", self.login)
        self.assertEqual((error.status, error.retry_after), (429, 300))
        self.clock.now = 299
        self.assertEqual(self.assert_error("rate-limited", self.login).retry_after, 1)
        self.clock.now = 300
        self.assertTrue(self.login().metadata["authenticated"])
        self.assertEqual(len(self.service._attempts), 1)

    def test_at_most_two_password_verifications_run_concurrently(self):
        entered, release = threading.Barrier(3), threading.Event()
        original = auth.verify_password

        def blocked(*args):
            entered.wait(timeout=5)
            if not release.wait(5):
                raise AssertionError("Synthetic verification barrier timed out")
            return original(*args)

        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(auth, "verify_password", side_effect=blocked) as verify:
            futures = [pool.submit(self.login) for _ in range(2)]
            try:
                entered.wait(timeout=5)
                self.assert_error("rate-limited", self.login)
                self.assertEqual(verify.call_count, 2)
            finally:
                release.set()
            self.assertEqual(len({future.result(timeout=5).token for future in futures}), 2)

    def test_failed_hash_releases_verification_slot(self):
        with patch.object(auth, "verify_password", side_effect=RuntimeError("Synthetic hashing failure")):
            with self.assertRaises(RuntimeError):
                self.login()
        self.assertTrue(self.login().metadata["authenticated"])

    def test_session_status_does_not_renew_idle_time(self):
        issued = self.login()
        for now in (100, 1000, 1799):
            self.clock.now = now
            self.assertEqual(self.service.session(issued.token)["session"]["idleRemainingSeconds"], 1800 - now)
        self.clock.now = 1800
        self.assert_error("authentication-required", self.service.session, issued.token)
        self.assertFalse(self.service._sessions)

    def test_explicit_activity_renews_idle_but_never_revives_expired_session(self):
        issued = self.login()
        self.clock.now = 1700
        metadata = self.service.session(issued.token, touch=True)
        self.assertEqual(metadata["session"], {"idleRemainingSeconds": 1800, "absoluteRemainingSeconds": 27100})
        self.clock.now = 3500
        self.assert_error("authentication-required", self.service.session, issued.token, touch=True)
        self.assertFalse(self.service._sessions)

    def test_absolute_boundary_expires_despite_regular_activity(self):
        issued = self.login()
        for now in range(1700, 28800, 1700):
            self.clock.now = now
            self.service.session(issued.token, touch=True)
        self.clock.now = 28799
        self.assertEqual(self.service.session(issued.token, touch=True)["session"]["absoluteRemainingSeconds"], 1)
        self.clock.now = 28800
        self.assert_error("authentication-required", self.service.session, issued.token, touch=True)

    def test_invalid_token_and_process_csrf_token_are_not_owner_authentication(self):
        self.login()
        for token in (None, "", "invalid", "a" * 43, "x" * 10000, object()):
            self.assert_error("authentication-required", self.service.session, token)

    def test_logout_is_idempotent_and_does_not_revoke_another_browser_session(self):
        first, second = self.login(), self.login()
        self.service.logout(first.token)
        self.service.logout(first.token)
        self.service.logout(None)
        self.assert_error("authentication-required", self.service.session, first.token)
        self.assertTrue(self.service.session(second.token)["authenticated"])

    def test_successful_relogin_rotates_only_presented_browser_session(self):
        first, other = self.login(), self.login()
        replacement = self.login(previous_token=first.token)
        self.assertNotEqual(replacement.token, first.token)
        self.assert_error("authentication-required", self.service.session, first.token)
        self.assertTrue(self.service.session(other.token)["authenticated"])
        self.assertTrue(self.service.session(replacement.token)["authenticated"])

    def test_password_reset_revokes_existing_in_memory_sessions(self):
        issued = self.login()
        self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repository.read().revision)
        self.assert_error("authentication-required", self.service.session, issued.token)
        self.assertFalse(self.service._sessions)
        self.assert_error("invalid-credentials", self.login)
        self.assertTrue(self.service.login(USERNAME, NEW_PASSWORD).metadata["authenticated"])

    def test_backup_recovery_changes_epoch_and_revokes_existing_sessions(self):
        issued = self.login()
        self.write(self.repository.backup_path, self.repository.path.read_bytes())
        self.write(self.repository.path, b"corrupt")
        recovery = self.repository.recovery_snapshot()
        self.repository.recover_backup(USERNAME, NEW_PASSWORD, expected_revision=recovery.revision,
                                       expected_backup_revision=recovery.backup_revision)
        self.assert_error("authentication-required", self.service.session, issued.token)

    def test_account_disablement_revokes_sessions(self):
        issued = self.login()
        self.record["users"][0]["disabled"] = True
        self.write(self.repository.path, json.dumps(self.record).encode())
        self.assert_error("authentication-required", self.service.session, issued.token)

    def test_restart_and_explicit_revoke_all_invalidate_sessions(self):
        issued = self.login()
        restarted = AuthService(self.repository, clock=self.clock)
        self.assert_error("authentication-required", restarted.session, issued.token)
        self.service.revoke_all()
        self.assert_error("authentication-required", self.service.session, issued.token)

    def test_login_reset_race_does_not_issue_a_session_from_old_credentials(self):
        original = auth.verify_password

        def reset_during_verification(password, verifier):
            result = original(password, verifier)
            self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repository.read().revision)
            return result

        with patch.object(auth, "verify_password", side_effect=reset_during_verification):
            self.assert_error("invalid-credentials", self.login)
        self.assertFalse(self.service._sessions)
        self.assertTrue(self.service.login(USERNAME, NEW_PASSWORD).metadata["authenticated"])

    def test_explicit_revocation_also_invalidates_a_pending_login(self):
        original = auth.verify_password

        def revoke_during_verification(*args):
            self.service.revoke_all()
            return original(*args)

        with patch.object(auth, "verify_password", side_effect=revoke_during_verification):
            self.assert_error("invalid-credentials", self.login)
        self.assertFalse(self.service._sessions)

    def test_corrupt_or_unreadable_security_fails_closed_and_clears_sessions(self):
        issued = self.login()
        original = self.repository.path.read_bytes()
        for raw in (b"corrupt", b'{"schemaVersion":2}', b'{"schemaVersion":1,"schemaVersion":1}', b"\xff"):
            self.write(self.repository.path, raw)
            self.assertEqual(self.service.status(), "unavailable")
            self.assert_error("authentication-unavailable", self.service.session, issued.token)
        self.write(self.repository.path, original)
        self.assert_error("authentication-required", self.service.session, issued.token)
        with patch.object(self.repository, "read", side_effect=PermissionError("Sensitive error details")):
            error = self.assert_error("authentication-unavailable", self.login)
        self.assertNotIn("Sensitive", str(error))

    def test_missing_owner_never_initializes_a_new_record(self):
        self.repository.path.unlink()
        self.assertEqual(self.service.status(), "setup-required")
        self.assert_error("owner-setup-required", self.login)
        self.assert_error("owner-setup-required", self.service.session, None)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_session_capacity_is_128_and_does_not_evict_valid_sessions(self):
        tokens = []
        # Isolate the session-capacity limit from the independently tested
        # password-work/rate limits; all 128 real session records remain valid.
        with patch.object(auth, "verify_password", return_value=True), patch.object(self.service, "_attempt"):
            for _ in range(128):
                tokens.append(self.login().token)
            original = set(self.service._sessions)
            self.assert_error("session-capacity", self.login)
            self.assertEqual(set(self.service._sessions), original)
            replacement = self.login(previous_token=tokens[0])
            self.assertEqual(len(self.service._sessions), 128)
            self.assert_error("authentication-required", self.service.session, tokens[0])
            self.assertTrue(self.service.session(replacement.token)["authenticated"])
            self.assertTrue(self.service.session(tokens[-1])["authenticated"])

    def test_expired_sessions_are_pruned_before_new_login(self):
        issued = self.login()
        self.clock.now = 1800
        new = self.login()
        self.assertEqual(len(self.service._sessions), 1)
        self.assert_error("authentication-required", self.service.session, issued.token)
        self.assertTrue(self.service.session(new.token)["authenticated"])

    def test_token_collision_cannot_replace_an_existing_session_or_loop_forever(self):
        issued = self.login()
        with patch.object(auth.secrets, "token_urlsafe", return_value=issued.token):
            self.assert_error("authentication-unavailable", self.login)
        self.assertEqual(len(self.service._sessions), 1)
        self.assertTrue(self.service.session(issued.token)["authenticated"])

    def test_concurrent_status_activity_and_logout_cannot_resurrect_a_session(self):
        issued = self.login()

        def operation(index):
            if index % 3 == 0:
                self.service.logout(issued.token)
            else:
                try:
                    self.service.session(issued.token, touch=index % 3 == 1)
                except AuthError as error:
                    self.assertEqual(error.code, "authentication-required")

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(operation, range(30)))
        self.assert_error("authentication-required", self.service.session, issued.token)
        self.assertFalse(self.service._sessions)

    def test_owner_identity_and_backend_generation_are_all_checked(self):
        for section, key in (("owner", "id"), ("root", "backendId"), ("root", "authEpoch"), ("owner", "authGeneration")):
            issued = self.login()
            data = copy.deepcopy(self.record)
            target = data["users"][0] if section == "owner" else data
            target[key] = 2 if key == "authGeneration" else "4" * 32
            self.write(self.repository.path, json.dumps(data).encode())
            self.assert_error("authentication-required", self.service.session, issued.token)
            self.write(self.repository.path, json.dumps(self.record).encode())
