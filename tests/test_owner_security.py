"""Owner setup only: private temporary files, synthetic credentials, no server."""
import base64
from contextlib import redirect_stderr, redirect_stdout
import copy
import getpass
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings

from tracker_config.models import ConfigurationError, RevisionConflict
from tracker_config.security import (
    MIN_ITERATIONS, SecurityRepository, create_password_verifier,
    normalize_username, validate_password_verifier, validate_security_record, verify_password,
)
from tracker_config import security_files


ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "Synthetic review passphrase 123!"
NEW_PASSWORD = "Different synthetic passphrase 456!"
RECOVERED_PASSWORD = "Recovered synthetic passphrase 789!"


def owner_cli():
    spec = importlib.util.spec_from_file_location("owner_cli_test", ROOT / "manager/owner.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OwnerSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.verifier = create_password_verifier(PASSWORD)

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tracker-owner-tests-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.repository = SecurityRepository(self.directory)
        self.policy = self.repository.permissions
        # Test fixtures explicitly own their private directory. The production
        # repository never repairs an existing directory's permissions.
        self.policy.make_private(self.directory)
        self.record = {
            "schemaVersion": 1, "backendId": "1" * 32, "authEpoch": "2" * 32,
            "users": [{"id": "3" * 32, "username": "review-owner", "role": "owner",
                       "passwordVerifier": copy.deepcopy(self.verifier), "authGeneration": 1,
                       "disabled": False, "createdAt": "2026-01-01T00:00:00Z", "passwordChangedAt": "2026-01-01T00:00:00Z"}],
        }

    def write_raw(self, path, content):
        security_files.private_atomic_write(path, content, permissions=self.policy)

    def seed(self):
        self.write_raw(self.repository.path, json.dumps(self.record).encode())
        return self.repository.read()

    def grant_unsafe_access(self, path, *, directory=False):
        """Change only this test's temporary ACL/mode; never a real config path."""
        if os.name == "nt":
            windows = self.policy.windows
            c, w = windows.c, windows.w
            descriptor = c.c_void_p()
            right = "GW" if directory else "GR"
            sddl = f"D:P(A;;FA;;;{windows.user_sid})(A;;FA;;;SY)(A;;FA;;;BA)(A;;{right};;;WD)"
            windows._require(windows.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), None))
            try:
                present, defaulted, dacl = w.BOOL(), w.BOOL(), c.c_void_p()
                windows._require(windows.advapi.GetSecurityDescriptorDacl(descriptor, c.byref(present), c.byref(dacl), c.byref(defaulted)))
                error = windows.advapi.SetNamedSecurityInfoW(str(path), 1, 0x80000004, None, None, dacl, None)
                self.assertEqual(error, 0)
            finally:
                windows.kernel.LocalFree(descriptor)
        else:
            os.chmod(path, 0o777 if directory else 0o644)

    def run_cli(self, command, *, passwords=(), confirmation=""):
        module = owner_cli()
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(module.getpass, "getpass", side_effect=list(passwords)) as hidden, \
             patch("builtins.input", return_value=confirmation), redirect_stdout(output), redirect_stderr(errors):
            result = module.main([command, "--config-dir", str(self.directory), "--username", "review-owner"])
        for password in (PASSWORD, NEW_PASSWORD, RECOVERED_PASSWORD):
            self.assertNotIn(password, output.getvalue() + errors.getvalue())
        return result, output.getvalue(), errors.getvalue(), hidden

    def test_constructor_missing_read_and_import_do_not_create_files_or_start_services(self):
        with patch.object(Path, "open", side_effect=AssertionError("Import cannot open configuration")), \
             patch("webbrowser.open", side_effect=AssertionError("Browser forbidden")), \
             patch("http.server.ThreadingHTTPServer", side_effect=AssertionError("Server forbidden")), \
             patch("subprocess.run", side_effect=AssertionError("Registration forbidden")):
            owner_cli()
            SecurityRepository(self.directory)
        with self.assertRaises(FileNotFoundError):
            self.repository.read()
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_create_owner_uses_random_immutable_identifiers_and_private_verifier(self):
        saved = self.repository.initialize(" Review-Owner ", PASSWORD)
        validate_security_record(saved.data)
        owner = saved.data["users"][0]
        self.assertEqual(owner["username"], "review-owner")
        self.assertRegex(owner["id"], r"^[0-9a-f]{32}$")
        self.assertNotEqual(owner["id"], saved.data["backendId"])
        self.assertNotEqual(saved.data["authEpoch"], saved.data["backendId"])
        self.assertEqual(owner["passwordVerifier"]["iterations"], 600000)
        self.assertNotIn(PASSWORD.encode(), self.repository.path.read_bytes())
        self.assertTrue(verify_password(PASSWORD, owner["passwordVerifier"]))
        self.policy.validate(self.repository.path)
        self.assertEqual([item.name for item in self.directory.iterdir()], ["security.json"])

    def test_correct_and_incorrect_passwords_use_real_pbkdf2_without_normalization(self):
        self.assertTrue(verify_password(PASSWORD, self.verifier))
        for value in ("incorrect", PASSWORD.upper(), PASSWORD + " ", None, 7, "x" * 1025, "\ud800"):
            with self.subTest(value_type=type(value).__name__):
                self.assertFalse(verify_password(value, self.verifier))
        with patch("tracker_config.security.hmac.compare_digest", wraps=__import__("hmac").compare_digest) as comparison:
            self.assertTrue(verify_password(PASSWORD, self.verifier))
            comparison.assert_called_once()

    def test_each_password_verifier_has_a_new_32_byte_salt(self):
        other = create_password_verifier(PASSWORD)
        self.assertNotEqual(other["salt"], self.verifier["salt"])
        self.assertNotEqual(other["digest"], self.verifier["digest"])
        self.assertEqual(len(base64.b64decode(other["salt"])), 32)

    def test_invalid_passwords_costs_and_usernames_do_not_write(self):
        for password in ("short", "", "x" * 1025, "\ud800", None):
            with self.assertRaises(ConfigurationError):
                self.repository.initialize("review-owner", password)
        for iterations in (599999, True, 2000001, 600000.0):
            with self.assertRaises(ConfigurationError):
                create_password_verifier(PASSWORD, iterations=iterations)
        for username in ("ab", "has space", "../owner", "a" * 65, None):
            with self.assertRaises(ConfigurationError):
                normalize_username(username)
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_malformed_verifiers_are_rejected_instead_of_falling_back(self):
        for key, value in (("algorithm", "sha256"), ("iterations", 1), ("iterations", True),
                           ("salt", "bad"), ("digest", "!" * 44), ("salt", ""), ("password", PASSWORD)):
            invalid = {**self.verifier, key: value}
            with self.assertRaises(ConfigurationError):
                validate_password_verifier(invalid)
            with self.assertRaises(ConfigurationError):
                verify_password(PASSWORD, invalid)

    def test_schema_rejects_unknown_versions_plaintext_and_invalid_owner_fields(self):
        cases = []
        for field, value in (("schemaVersion", 2), ("schemaVersion", True), ("users", []),
                             ("users", [self.record["users"][0]] * 2), ("password", PASSWORD), ("authEpoch", "bad")):
            cases.append({**copy.deepcopy(self.record), field: value})
        for field, value in (("id", "candidate-one"), ("username", "Review-Owner"), ("role", "admin"),
                             ("disabled", 0), ("authGeneration", True), ("password", PASSWORD), ("passwordChangedAt", "2025-01-01T00:00:00Z")):
            invalid = copy.deepcopy(self.record)
            invalid["users"][0][field] = value
            cases.append(invalid)
        for invalid in cases:
            with self.assertRaises(ConfigurationError):
                validate_security_record(invalid)

    def test_duplicate_initialization_never_replaces_existing_owner(self):
        self.seed()
        before = self.repository.path.read_bytes()
        with self.assertRaisesRegex(ConfigurationError, "already exists"):
            self.repository.initialize("different-owner", NEW_PASSWORD)
        self.assertEqual(before, self.repository.path.read_bytes())
        self.assertFalse(self.repository.backup_path.exists())

    def test_corrupt_records_fail_closed_and_are_not_reinitialized_or_reset(self):
        for raw in (b'{"schemaVersion":', b'{}', b'{"schemaVersion":2}', b'\xff',
                    b'{"schemaVersion":1,"schemaVersion":1}', b'{"schemaVersion":NaN}'):
            with self.subTest(raw=raw):
                self.write_raw(self.repository.path, raw)
                with self.assertRaises(ConfigurationError):
                    self.repository.read()
                with self.assertRaises(ConfigurationError):
                    self.repository.initialize("review-owner", PASSWORD)
                with self.assertRaises(ConfigurationError):
                    self.repository.reset_password("review-owner", NEW_PASSWORD, expected_revision=None)
                self.assertEqual(raw, self.repository.path.read_bytes())
                self.assertFalse(self.repository.backup_path.exists())

    def test_reset_preserves_identity_and_rotates_future_session_revocation_fields(self):
        original = self.seed()
        result = self.repository.reset_password("review-owner", NEW_PASSWORD, expected_revision=original.revision)
        before, after = original.data["users"][0], result.data["users"][0]
        for field in ("id", "username", "role", "createdAt", "disabled"):
            self.assertEqual(before[field], after[field])
        self.assertEqual(original.data["backendId"], result.data["backendId"])
        self.assertNotEqual(original.data["authEpoch"], result.data["authEpoch"])
        self.assertEqual(after["authGeneration"], before["authGeneration"] + 1)
        self.assertTrue(verify_password(NEW_PASSWORD, after["passwordVerifier"]))
        self.assertFalse(verify_password(PASSWORD, after["passwordVerifier"]))
        self.policy.validate(self.repository.backup_path)
        self.assertNotIn(NEW_PASSWORD.encode(), self.repository.path.read_bytes())

    def test_stale_reset_and_wrong_owner_are_rejected_without_writes(self):
        original = self.seed()
        with self.assertRaises(ConfigurationError):
            self.repository.reset_password("wrong-owner", NEW_PASSWORD, expected_revision=original.revision)
        current = SecurityRepository(self.directory).reset_password("review-owner", NEW_PASSWORD, expected_revision=original.revision)
        before = self.repository.path.read_bytes()
        with self.assertRaises(RevisionConflict):
            self.repository.reset_password("review-owner", RECOVERED_PASSWORD, expected_revision=original.revision)
        self.assertEqual(self.repository.read().revision, current.revision)
        self.assertEqual(before, self.repository.path.read_bytes())

    def test_failed_primary_replacement_preserves_valid_original_and_private_backup(self):
        original = self.seed()
        before = self.repository.path.read_bytes()
        replace = os.replace

        def fail_primary(source, destination):
            if Path(destination) == self.repository.path:
                raise OSError("Synthetic primary replacement failure")
            replace(source, destination)

        with patch.object(security_files.os, "replace", side_effect=fail_primary):
            with self.assertRaises(OSError):
                self.repository.reset_password("review-owner", NEW_PASSWORD, expected_revision=original.revision)
        self.assertEqual(before, self.repository.path.read_bytes())
        self.assertEqual(before, self.repository.backup_path.read_bytes())
        self.policy.validate(self.repository.backup_path)
        self.assertEqual(list(self.directory.glob("*.tmp")), [])

    def test_permission_setup_and_flush_failure_never_commit_secret_bytes(self):
        for failure in ("permissions", "flush"):
            with self.subTest(failure=failure):
                target = patch.object(self.policy, "make_private", side_effect=PermissionError("Synthetic ACL failure")) if failure == "permissions" else patch.object(security_files.os, "fsync", side_effect=OSError("Synthetic flush failure"))
                with target, self.assertRaises(OSError):
                    self.repository.initialize("review-owner", PASSWORD)
                self.assertEqual(list(self.directory.iterdir()), [])

    def test_missing_configuration_directory_is_never_created(self):
        missing = self.directory / "missing" / "config"
        with self.assertRaises(FileNotFoundError):
            SecurityRepository(missing).initialize("review-owner", PASSWORD)
        self.assertFalse(missing.parent.exists())

    def test_recovery_always_requires_new_password_preserves_corrupt_bytes_and_identity(self):
        original = self.seed()
        self.repository.reset_password("review-owner", NEW_PASSWORD, expected_revision=original.revision)
        backup_bytes = self.repository.backup_path.read_bytes()
        corrupt = b'{"schemaVersion":1,"users":BROKEN'
        self.write_raw(self.repository.path, corrupt)
        plan = self.repository.recovery_snapshot()
        restored = self.repository.recover_backup("review-owner", RECOVERED_PASSWORD,
                                                  expected_revision=plan.revision, expected_backup_revision=plan.backup_revision)
        self.assertEqual(restored.data["users"][0]["id"], original.data["users"][0]["id"])
        self.assertEqual(restored.data["backendId"], original.data["backendId"])
        self.assertNotEqual(restored.data["authEpoch"], original.data["authEpoch"])
        verifier = restored.data["users"][0]["passwordVerifier"]
        self.assertTrue(verify_password(RECOVERED_PASSWORD, verifier))
        self.assertFalse(verify_password(PASSWORD, verifier))
        self.assertFalse(verify_password(NEW_PASSWORD, verifier))
        retained = list(self.directory.glob(".security.json.before-restore.*"))
        self.assertEqual(len(retained), 1)
        self.assertEqual(retained[0].read_bytes(), corrupt)
        self.policy.validate(retained[0])
        self.assertEqual(backup_bytes, self.repository.backup_path.read_bytes())

    def test_missing_primary_with_backup_cannot_be_claimed_by_initialization(self):
        self.write_raw(self.repository.backup_path, json.dumps(self.record).encode())
        with self.assertRaises(ConfigurationError):
            self.repository.initialize("new-owner", NEW_PASSWORD)
        with self.assertRaises(FileNotFoundError):
            self.repository.read()
        plan = self.repository.recovery_snapshot()
        self.assertIsNone(plan.revision)
        self.repository.recover_backup("review-owner", NEW_PASSWORD, expected_revision=None, expected_backup_revision=plan.backup_revision)
        self.assertEqual(self.repository.read().data["users"][0]["id"], self.record["users"][0]["id"])

    def test_recovery_rejects_invalid_backup_newer_schema_and_stale_observations(self):
        self.seed()
        self.write_raw(self.repository.path, b"corrupt")
        self.write_raw(self.repository.backup_path, b"not JSON")
        with self.assertRaises(ConfigurationError):
            self.repository.recovery_snapshot()
        self.write_raw(self.repository.backup_path, json.dumps(self.record).encode())
        self.write_raw(self.repository.path, b'{"schemaVersion":2}')
        with self.assertRaisesRegex(ConfigurationError, "downgrade"):
            self.repository.recovery_snapshot()
        self.write_raw(self.repository.path, b"corrupt")
        plan = self.repository.recovery_snapshot()
        self.write_raw(self.repository.path, b"newer corrupt bytes")
        with self.assertRaises(RevisionConflict):
            self.repository.recover_backup("review-owner", NEW_PASSWORD, expected_revision=plan.revision, expected_backup_revision=plan.backup_revision)
        self.assertEqual(self.repository.path.read_bytes(), b"newer corrupt bytes")

    def test_recovery_refuses_to_replace_a_valid_primary_or_a_changed_backup(self):
        original = self.seed()
        self.repository.reset_password("review-owner", NEW_PASSWORD, expected_revision=original.revision)
        before = self.repository.path.read_bytes()
        with self.assertRaisesRegex(ConfigurationError, "reset-password"):
            self.repository.recovery_snapshot()
        self.assertEqual(before, self.repository.path.read_bytes())
        self.write_raw(self.repository.path, b"corrupt")
        plan = self.repository.recovery_snapshot()
        backup = copy.deepcopy(self.record)
        backup["authEpoch"] = "4" * 32
        self.write_raw(self.repository.backup_path, json.dumps(backup).encode())
        with self.assertRaises(RevisionConflict):
            self.repository.recover_backup("review-owner", NEW_PASSWORD, expected_revision=plan.revision,
                                           expected_backup_revision=plan.backup_revision)
        self.assertEqual(self.repository.path.read_bytes(), b"corrupt")
        self.assertEqual(list(self.directory.glob(".security.json.before-restore.*")), [])

    def test_broadly_readable_security_file_is_rejected_without_automatic_repair(self):
        self.seed()
        before = self.repository.path.read_bytes()
        self.grant_unsafe_access(self.repository.path)
        for operation in (self.repository.read, self.repository.ensure_uninitialized):
            with self.assertRaises(PermissionError):
                operation()
        with self.assertRaises(PermissionError):
            self.policy.validate(self.repository.path)
        self.assertEqual(before, self.repository.path.read_bytes())

    def test_shared_writable_parent_is_rejected_before_creating_credentials(self):
        self.grant_unsafe_access(self.directory, directory=True)
        try:
            with self.assertRaises(PermissionError):
                self.repository.initialize("review-owner", PASSWORD)
            self.assertEqual(list(self.directory.iterdir()), [])
            with self.assertRaises(PermissionError):
                self.policy.validate(self.directory, directory=True)
        finally:
            self.policy.make_private(self.directory)

    def test_unsafe_backup_prevents_reset_or_recovery_and_is_not_repaired(self):
        original = self.seed()
        self.repository.reset_password("review-owner", NEW_PASSWORD, expected_revision=original.revision)
        before = self.repository.path.read_bytes()
        self.grant_unsafe_access(self.repository.backup_path)
        with self.assertRaises(PermissionError):
            self.repository.reset_password("review-owner", RECOVERED_PASSWORD, expected_revision=self.repository._record.current_revision())
        with self.assertRaises(PermissionError):
            self.repository.recovery_snapshot()
        self.assertEqual(before, self.repository.path.read_bytes())

    def test_hard_linked_security_records_are_rejected(self):
        self.seed()
        alias = self.directory / "security-alias.json"
        os.link(self.repository.path, alias)
        with self.assertRaisesRegex(PermissionError, "hard links"):
            self.repository.read()

    def test_symbolic_links_and_reparse_points_fail_before_reading_contents(self):
        for attributes in ({"st_mode": 0o120600, "st_file_attributes": 0},
                           {"st_mode": 0o100600, "st_file_attributes": 0x400}):
            with self.subTest(attributes=attributes):
                from types import SimpleNamespace
                with patch.object(Path, "lstat", return_value=SimpleNamespace(**attributes)), \
                     self.assertRaisesRegex(PermissionError, "reparse points"):
                    self.policy.validate(self.repository.path)

    def test_orphan_private_temp_file_blocks_new_account_claim(self):
        artifact = self.directory / ".security.json.interrupted.tmp"
        artifact.write_bytes(b"")
        self.policy.make_private(artifact)
        with self.assertRaisesRegex(ConfigurationError, "recovery artifacts"):
            self.repository.initialize("review-owner", PASSWORD)
        self.assertEqual(list(self.directory.iterdir()), [artifact])

    def test_backup_write_failure_leaves_both_previous_valid_files_unchanged(self):
        original = self.seed()
        self.repository.reset_password("review-owner", NEW_PASSWORD, expected_revision=original.revision)
        current = self.repository.read()
        before = self.repository.path.read_bytes(), self.repository.backup_path.read_bytes()
        with patch.object(security_files.os, "replace", side_effect=OSError("Synthetic backup replacement failure")):
            with self.assertRaises(OSError):
                self.repository.reset_password("review-owner", RECOVERED_PASSWORD, expected_revision=current.revision)
        self.assertEqual(before, (self.repository.path.read_bytes(), self.repository.backup_path.read_bytes()))
        self.assertEqual(list(self.directory.glob("*.tmp")), [])

    def test_unreadable_record_is_not_treated_as_an_empty_store(self):
        self.seed()
        before = self.repository.path.read_bytes()
        with patch.object(Path, "read_bytes", side_effect=PermissionError("Synthetic read refusal")):
            with self.assertRaises(PermissionError):
                self.repository.read()
        self.assertEqual(before, self.repository.path.read_bytes())

    def test_failed_recovery_keeps_primary_backup_and_recovery_evidence(self):
        self.write_raw(self.repository.backup_path, json.dumps(self.record).encode())
        self.write_raw(self.repository.path, b"corrupt primary")
        plan = self.repository.recovery_snapshot()
        backup = self.repository.backup_path.read_bytes()
        replace = os.replace

        def fail_primary(source, destination):
            if Path(destination) == self.repository.path:
                raise OSError("Synthetic recovery replacement failure")
            replace(source, destination)

        with patch.object(security_files.os, "replace", side_effect=fail_primary):
            with self.assertRaises(OSError):
                self.repository.recover_backup("review-owner", NEW_PASSWORD, expected_revision=plan.revision, expected_backup_revision=plan.backup_revision)
        self.assertEqual(self.repository.path.read_bytes(), b"corrupt primary")
        self.assertEqual(self.repository.backup_path.read_bytes(), backup)
        self.assertEqual(list(self.directory.glob("*.tmp")), [])
        self.assertEqual(len(list(self.directory.glob(".security.json.before-restore.*"))), 1)

    def test_candidate_and_profile_files_are_never_opened_migrated_or_modified(self):
        candidate = self.directory / "candidates.json"
        profile_dir = self.directory / "profiles"
        profile_dir.mkdir()
        profile = profile_dir / "synthetic.json"
        candidate.write_bytes(b"Synthetic candidate sentinel")
        profile.write_bytes(b"Synthetic profile sentinel")
        original_open = Path.open

        def guarded_open(path, *args, **kwargs):
            if Path(path) in (candidate, profile):
                raise AssertionError("Owner setup must not read candidate/profile data")
            return original_open(path, *args, **kwargs)

        with patch.object(Path, "open", guarded_open):
            created = self.repository.initialize("review-owner", PASSWORD)
            self.repository.reset_password("review-owner", NEW_PASSWORD, expected_revision=created.revision)
        self.assertEqual(candidate.read_bytes(), b"Synthetic candidate sentinel")
        self.assertEqual(profile.read_bytes(), b"Synthetic profile sentinel")

    def test_cli_setup_verify_wrong_password_and_duplicate_setup(self):
        result, output, errors, _ = self.run_cli("init", passwords=[PASSWORD, PASSWORD])
        self.assertEqual(result, 0, errors)
        self.assertIn("manager authorization is not yet enabled", output)
        self.assertEqual(self.run_cli("verify-password", passwords=[PASSWORD])[0], 0)
        self.assertEqual(self.run_cli("verify-password", passwords=[NEW_PASSWORD])[0], 1)
        before = self.repository.path.read_bytes()
        result, _, _, hidden = self.run_cli("init")
        self.assertEqual(result, 1)
        hidden.assert_not_called()
        self.assertEqual(before, self.repository.path.read_bytes())

    def test_cli_refuses_mismatched_passwords_echo_fallback_and_password_arguments(self):
        self.assertEqual(self.run_cli("init", passwords=[PASSWORD, NEW_PASSWORD])[0], 1)
        self.assertEqual(list(self.directory.iterdir()), [])
        module = owner_cli()

        def unavailable(prompt):
            warnings.warn("No safe terminal", getpass.GetPassWarning)
            raise AssertionError("Must abort before any echoed input")

        with patch.object(module.getpass, "getpass", side_effect=unavailable), redirect_stderr(io.StringIO()):
            self.assertEqual(module.main(["init", "--username", "review-owner", "--config-dir", str(self.directory)]), 1)
        error = io.StringIO()
        with redirect_stderr(error), self.assertRaises(SystemExit) as stopped:
            module.main(["init", "--username", "review-owner", "--password", PASSWORD])
        self.assertEqual(stopped.exception.code, 2)
        self.assertNotIn(PASSWORD, error.getvalue())
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_cli_reset_and_recovery_require_typed_confirmation(self):
        original = self.seed()
        self.assertEqual(self.run_cli("reset-password", confirmation="wrong")[0], 1)
        self.assertEqual(self.repository.read().revision, original.revision)
        result = self.run_cli("reset-password", passwords=[NEW_PASSWORD, NEW_PASSWORD], confirmation="RESET review-owner")
        self.assertEqual(result[0], 0, result[2])
        self.write_raw(self.repository.path, b"corrupt")
        self.assertEqual(self.run_cli("recover-backup", confirmation="wrong")[0], 1)
        result = self.run_cli("recover-backup", passwords=[RECOVERED_PASSWORD, RECOVERED_PASSWORD], confirmation="RECOVER review-owner")
        self.assertEqual(result[0], 0, result[2])
        self.assertTrue(verify_password(RECOVERED_PASSWORD, self.repository.read().data["users"][0]["passwordVerifier"]))

    def test_concurrent_initialization_in_two_processes_creates_only_one_owner(self):
        program = (
            "from pathlib import Path; import sys; "
            f"sys.path.insert(0, {str(ROOT)!r}); "
            "from tracker_config.security import SecurityRepository; "
            "from tracker_config.models import ConfigurationError\n"
            "password = sys.stdin.readline().rstrip('\\n')\n"
            "try:\n SecurityRepository(Path(sys.argv[1])).initialize('review-owner', password)\n"
            "except ConfigurationError:\n sys.exit(7)\n"
        )
        processes = []
        try:
            for _ in range(2):
                process = subprocess.Popen([sys.executable, "-B", "-c", program, str(self.directory)],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, encoding="utf-8")
                processes.append(process)
            for process in processes:
                process.stdin.write(PASSWORD + "\n")
                process.stdin.close()
                process.stdin = None
            outputs = [process.communicate(timeout=20) for process in processes]
            self.assertEqual(sorted(process.returncode for process in processes), [0, 7], outputs)
            validate_security_record(self.repository.read().data)
            self.assertFalse(self.repository.backup_path.exists())
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait()
