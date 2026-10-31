"""Private-location discovery/provisioning: only bounded synthetic temporary roots."""
from contextlib import redirect_stdout, redirect_stderr
import ctypes
import io
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from manager import app
from test_owner_security import owner_cli
from auth_fixtures import PASSWORD, NEW_PASSWORD, USERNAME
from tracker_config import security_location
from tracker_config.auth import AuthService, AuthError
from tracker_config.models import ConfigurationError
from tracker_config.security import SecurityRepository, owner_repository, verify_password
from tracker_config.security_files import SecurityPermissions, private_atomic_write


KNOWN_FOLDER_API = security_location.windows_known_folder


class PrivateSecurityLocationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tracker-private-location-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.policy = SecurityPermissions()
        self.policy.make_private(self.root)
        self.legacy = self.root / "legacy"
        self.enterContext(patch.object(security_location, "windows_known_folder", lambda name: self.root))
        self.enterContext(patch.object(security_location, "LEGACY_DIRECTORY", self.legacy))
        self.repo = owner_repository()
        self.service = AuthService(self.repo)

    def initialize(self):
        return self.repo.initialize(USERNAME, PASSWORD)

    def grant(self, path, right="GR", *, protected=True):
        if os.name != "nt":
            os.chmod(path, 0o777 if path.is_dir() else 0o644)
            return
        windows = self.policy.windows
        c, w = windows.c, windows.w
        descriptor, dacl = c.c_void_p(), c.c_void_p()
        sddl = f"D:{'P' if protected else ''}(A;;FA;;;{windows.user_sid})(A;;FA;;;SY)(A;;FA;;;BA)(A;;{right};;;WD)"
        windows._require(windows.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), None))
        try:
            present, defaulted = w.BOOL(), w.BOOL()
            windows._require(windows.advapi.GetSecurityDescriptorDacl(descriptor, c.byref(present), c.byref(dacl), c.byref(defaulted)))
            self.assertEqual(windows.advapi.SetNamedSecurityInfoW(str(path), 1, 0x80000004 if protected else 0x20000004, None, None, dacl, None), 0)
        finally:
            windows.kernel.LocalFree(descriptor)

    def test_default_uses_known_folder_not_environment_or_working_directory(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root / "untrusted-env")}), \
             patch.object(Path, "cwd", side_effect=AssertionError("CWD must not select credentials")):
            self.assertEqual(self.repo.directory, self.root / "ApplicationTracker/security")
            self.assertEqual(self.service.status(), "setup-required")
        self.assertEqual(list(self.root.iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "Windows Known Folder binding")
    def test_known_folder_binding_uses_current_user_zero_creation_flags_and_frees_memory(self):
        value = ctypes.create_unicode_buffer(str(self.root))
        def lookup(identifier, flags, token, output):
            self.assertEqual(flags, 0); self.assertIsNone(token)
            ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.cast(value, ctypes.c_void_p).value
            return 0
        shell = SimpleNamespace(SHGetKnownFolderPath=Mock(side_effect=lookup))
        ole = SimpleNamespace(CoInitializeEx=Mock(return_value=0), CoUninitialize=Mock(), CoTaskMemFree=Mock())
        with patch("ctypes.WinDLL", side_effect=lambda name, **kwargs: {"shell32": shell, "ole32": ole}[name]):
            self.assertEqual(KNOWN_FOLDER_API("local"), self.root)
            self.assertEqual(KNOWN_FOLDER_API("profile"), self.root)
        self.assertEqual(ole.CoTaskMemFree.call_count, 2)
        self.assertEqual(ole.CoUninitialize.call_count, 2)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_resolution_failure_is_unavailable_without_config_fallback(self):
        with patch.object(security_location, "windows_known_folder", side_effect=ConfigurationError("Synthetic resolution failure")):
            self.assertEqual(self.service.status(), "unavailable")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_invalid_known_folder_result_is_unavailable_not_missing_owner(self):
        with patch.object(security_location, "windows_known_folder", return_value=None):
            self.assertEqual(self.service.status(), "unavailable")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_missing_localappdata_is_unavailable_and_never_provisioned(self):
        repository = owner_repository(known_folder=lambda name: self.root / "missing-local" if name == "local" else self.root)
        self.assertEqual(AuthService(repository).status(), "unavailable")
        with self.assertRaisesRegex(PermissionError, "Known Folder"):
            repository.initialize(USERNAME, PASSWORD)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_relative_and_traversal_overrides_are_rejected_without_writes(self):
        for value in ("relative/security", self.root / ".." / "escaped"):
            self.assertEqual(AuthService(owner_repository(value)).status(), "unavailable")
        if os.name == "nt":
            for value in (r"\\server\share\security", r"\\?\C:\security", self.root / "NUL", self.root / "file:stream", self.root / "alias."):
                self.assertEqual(AuthService(owner_repository(value)).status(), "unavailable")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_explicit_override_is_shared_and_does_not_resolve_localappdata(self):
        requested = self.root / "separate" / "owner"
        def known(name):
            self.assertEqual(name, "profile")
            return self.root
        repository = owner_repository(requested, known_folder=known)
        self.assertEqual(AuthService(repository).status(), "setup-required")
        repository.initialize(USERNAME, PASSWORD)
        self.assertEqual(repository.path, requested / "security.json")
        self.assertEqual(AuthService(repository).status(), "ready")
        self.assertFalse((self.root / "ApplicationTracker").exists())

    def test_setup_provisions_private_directories_and_verifier(self):
        self.assertEqual(self.service.status(), "setup-required")
        self.initialize()
        for path in (self.repo.directory.parent, self.repo.directory):
            self.policy.validate(path, directory=True, private=True)
        self.policy.validate(self.repo.path)
        self.assertTrue(verify_password(PASSWORD, self.repo.read().data["users"][0]["passwordVerifier"]))
        self.assertEqual(self.service.status(), "ready")

    @unittest.skipUnless(os.name == "nt", "Native Windows directory ACL creation")
    def test_native_creation_supplies_protected_acl_before_directory_exists(self):
        windows = self.policy.windows
        original = windows.kernel.CreateDirectoryW
        seen = []
        class Attributes(ctypes.Structure):
            _fields_ = [("length", windows.w.DWORD), ("descriptor", ctypes.c_void_p), ("inherit", windows.w.BOOL)]
        def create(path, raw):
            self.assertFalse(Path(path).exists())
            attributes = ctypes.cast(raw, ctypes.POINTER(Attributes)).contents
            self.assertTrue(attributes.descriptor); self.assertFalse(attributes.inherit)
            control, revision = windows.w.WORD(), windows.w.DWORD()
            windows._require(windows.advapi.GetSecurityDescriptorControl(attributes.descriptor, ctypes.byref(control), ctypes.byref(revision)))
            self.assertTrue(control.value & 0x1000); seen.append(path)
            return original(path, raw)
        with patch.object(windows.kernel, "CreateDirectoryW", side_effect=create):
            self.policy.create_private_directory(self.root / "private-child")
        self.assertEqual(len(seen), 1)
        self.policy.validate(self.root / "private-child", directory=True, private=True)

    def test_readable_parent_does_not_leak_inherited_access_into_new_private_children(self):
        self.grant(self.root)
        self.initialize()
        self.policy.validate(self.repo.directory.parent, directory=True, private=True)
        self.policy.validate(self.repo.directory, directory=True, private=True)
        self.policy.validate(self.repo.path)

    def test_unsafe_existing_application_directory_is_rejected_not_repaired(self):
        path = self.root / "ApplicationTracker"
        self.policy.create_private_directory(path); self.grant(path)
        self.assertEqual(self.service.status(), "unavailable")
        with self.assertRaises(PermissionError): self.initialize()
        self.assertFalse((path / "security").exists())
        with self.assertRaises(PermissionError): self.policy.validate(path, directory=True, private=True)

    def test_unsafe_existing_security_directory_is_rejected_on_every_read(self):
        self.initialize(); before = self.repo.path.read_bytes()
        self.grant(self.repo.directory)
        self.assertEqual(self.service.status(), "unavailable")
        with self.assertRaises(PermissionError): self.repo.read()
        self.assertEqual(before, self.repo.path.read_bytes())

    def test_unsafe_ancestor_is_not_hidden_by_missing_owner(self):
        self.grant(self.root, "GW")
        self.assertEqual(self.service.status(), "unavailable")
        with self.assertRaises(PermissionError): self.repo.ensure_uninitialized()
        self.assertEqual(list(self.root.iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "Windows create-access check")
    def test_parent_without_explicit_create_rights_is_unavailable(self):
        windows = self.policy.windows
        descriptor, dacl = ctypes.c_void_p(), ctypes.c_void_p()
        sddl = f"D:P(A;;GR;;;{windows.user_sid})(A;;FA;;;SY)(A;;FA;;;BA)"
        windows._require(windows.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None))
        try:
            present, defaulted = windows.w.BOOL(), windows.w.BOOL()
            windows._require(windows.advapi.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)))
            self.assertEqual(windows.advapi.SetNamedSecurityInfoW(str(self.root), 1, 0x80000004, None, None, dacl, None), 0)
            self.assertEqual(self.service.status(), "unavailable")
        finally:
            windows.kernel.LocalFree(descriptor)
            self.policy.make_private(self.root)
        self.assertEqual(list(self.root.iterdir()), [])

    @unittest.skipUnless(os.name == "nt", "Windows protected-DACL validation")
    def test_private_directory_cannot_reenable_acl_inheritance(self):
        self.initialize(); self.grant(self.repo.directory, protected=False)
        with self.assertRaisesRegex(PermissionError, "protected DACL"):
            self.repo.read()
        self.assertEqual(self.service.status(), "unavailable")

    def test_reparse_ancestor_is_rejected_before_reading_or_creating_files(self):
        original = Path.lstat
        def redirected(path):
            if path == self.root:
                return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
            return original(path)
        with patch.object(Path, "lstat", redirected):
            self.assertEqual(self.service.status(), "unavailable")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_partial_creation_failure_leaves_only_private_empty_parent(self):
        original = self.policy.create_private_directory
        def interrupted(path):
            if path.name == "security": raise OSError("Synthetic directory failure")
            return original(path)
        self.repo.permissions = self.policy
        with patch.object(self.policy, "create_private_directory", side_effect=interrupted), self.assertRaises(OSError):
            self.initialize()
        self.policy.validate(self.repo.directory.parent, directory=True, private=True)
        self.assertFalse(self.repo.directory.exists()); self.assertFalse(self.repo.path.exists())
        self.assertEqual(self.service.status(), "setup-required")
        self.initialize(); self.assertEqual(self.service.status(), "ready")

    def test_invalid_setup_input_does_not_provision_directories(self):
        for username, password in (("?", PASSWORD), (USERNAME, "short")):
            with self.assertRaises(ConfigurationError): self.repo.initialize(username, password)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_duplicate_setup_preserves_identity_and_credentials(self):
        self.initialize(); before = self.repo.path.read_bytes()
        with self.assertRaises(ConfigurationError): self.repo.initialize("other-owner", NEW_PASSWORD)
        self.assertEqual(before, self.repo.path.read_bytes()); self.assertFalse(self.repo.backup_path.exists())

    def test_two_setup_processes_provision_missing_tree_and_create_only_one_owner(self):
        program = """
import sys
from pathlib import Path
from tracker_config.security import owner_repository
from tracker_config.models import ConfigurationError
root = Path(sys.argv[1])
repository = owner_repository(known_folder=lambda name: root, legacy_directory=root / 'legacy')
try:
    repository.initialize('synthetic-owner', sys.stdin.read())
except ConfigurationError:
    raise SystemExit(7)
"""
        processes = [subprocess.Popen([sys.executable, "-B", "-c", program, str(self.root)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      text=True) for _ in range(2)]
        for process in processes:
            process.stdin.write(PASSWORD)
            process.stdin.close()
            process.stdin = None
        results = [process.communicate(timeout=30) for process in processes]
        self.assertEqual(sorted(process.returncode for process in processes), [0, 7], results)
        self.assertEqual(self.service.status(), "ready")
        self.assertFalse(self.repo.backup_path.exists())

    def test_corrupt_private_record_is_unavailable_and_never_replaced(self):
        self.initialize()
        private_atomic_write(self.repo.path, b"corrupt synthetic owner", permissions=self.policy)
        self.assertEqual(self.service.status(), "unavailable")
        with self.assertRaises(ConfigurationError): self.initialize()
        self.assertEqual(self.repo.path.read_bytes(), b"corrupt synthetic owner")

    def test_missing_primary_with_recovery_evidence_is_unavailable_not_new_setup(self):
        self.initialize(); self.repo.path.replace(self.repo.backup_path)
        self.assertEqual(self.service.status(), "unavailable")
        with self.assertRaises(ConfigurationError): self.initialize()

    def test_legacy_discovery_reads_metadata_only_and_blocks_setup(self):
        self.legacy.mkdir(); legacy = self.legacy / "security.json"; legacy.write_bytes(b"synthetic legacy sentinel")
        original = Path.read_bytes
        def deny_legacy(path):
            if path == legacy: raise AssertionError("Legacy verifier content must not be read")
            return original(path)
        with patch.object(Path, "read_bytes", deny_legacy):
            self.assertEqual(self.service.status(), "unavailable")
            with self.assertRaisesRegex(ConfigurationError, "Legacy"): self.initialize()
        self.assertFalse(self.repo.directory.exists()); self.assertEqual(legacy.read_bytes(), b"synthetic legacy sentinel")

    def test_legacy_backups_and_recovery_artifacts_all_block_without_migration(self):
        self.legacy.mkdir()
        for name in ("security.json.bak", "security.json.bak.old", ".security.json.interrupted.tmp", ".security.json.before-restore.test"):
            path = self.legacy / name; path.write_bytes(b"synthetic recovery sentinel")
            self.assertEqual(self.service.status(), "unavailable", name)
            self.assertEqual(path.read_bytes(), b"synthetic recovery sentinel"); path.unlink()
        self.assertEqual(self.service.status(), "setup-required")

    def test_unreadable_legacy_discovery_fails_closed(self):
        self.legacy.mkdir(); original = Path.iterdir
        def denied(path):
            if path == self.legacy: raise PermissionError("Synthetic legacy metadata denial")
            return original(path)
        with patch.object(Path, "iterdir", denied):
            self.assertEqual(self.service.status(), "unavailable")
        self.assertFalse(self.repo.directory.exists())

    def test_all_directory_and_record_writes_stay_inside_test_root(self):
        original_create, original_temp, original_read = self.policy.create_private_directory, tempfile.mkstemp, Path.read_bytes
        self.repo.permissions = self.policy
        def create(path):
            self.assertTrue(path.is_relative_to(self.root)); return original_create(path)
        def temporary(*args, **kwargs):
            self.assertTrue(Path(kwargs["dir"]).is_relative_to(self.root)); return original_temp(*args, **kwargs)
        def read(path):
            self.assertTrue(path.is_relative_to(self.root)); return original_read(path)
        with patch.object(self.policy, "create_private_directory", side_effect=create), \
             patch("tracker_config.security_files.tempfile.mkstemp", side_effect=temporary), patch.object(Path, "read_bytes", read):
            self.assertEqual(self.service.status(), "setup-required")
            self.initialize(); self.assertEqual(self.service.status(), "ready")
            self.repo.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repo.read().revision)

    def test_new_and_legacy_conflict_revokes_sessions_without_resetting_record(self):
        self.initialize(); token = self.service.login(USERNAME, PASSWORD).token; before = self.repo.path.read_bytes()
        self.legacy.mkdir(); (self.legacy / "security.json").write_bytes(b"legacy conflict")
        self.assertEqual(self.service.status(), "unavailable")
        with self.assertRaises(AuthError): self.service.session(token)
        self.assertFalse(self.service._sessions); self.assertEqual(before, self.repo.path.read_bytes())

    def test_reset_and_recovery_keep_identity_and_revoke_existing_sessions(self):
        self.initialize(); original = self.repo.read(); token = self.service.login(USERNAME, PASSWORD).token
        reset = self.repo.reset_password(USERNAME, NEW_PASSWORD, expected_revision=original.revision)
        with self.assertRaises(AuthError): self.service.session(token)
        token = self.service.login(USERNAME, NEW_PASSWORD).token
        private_atomic_write(self.repo.path, b"corrupt", permissions=self.policy)
        plan = self.repo.recovery_snapshot()
        recovered = self.repo.recover_backup(USERNAME, PASSWORD, expected_revision=plan.revision, expected_backup_revision=plan.backup_revision)
        with self.assertRaises(AuthError): self.service.session(token)
        self.assertEqual(recovered.data["users"][0]["id"], original.data["users"][0]["id"])
        self.assertNotEqual(recovered.data["authEpoch"], reset.data["authEpoch"])

    def test_cli_default_manager_startup_and_override_use_the_same_factory(self):
        cli = owner_cli()
        with patch.object(cli.getpass, "getpass", side_effect=[PASSWORD, PASSWORD]), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["init", "--username", USERNAME]), 0)
        for args, expected in (([], self.repo.directory), (["--security-dir", str(self.root / "alternate")], self.root / "alternate")):
            server = Mock(server_port=12345); server.serve_forever.side_effect = KeyboardInterrupt
            with patch.object(app, "ThreadingHTTPServer", return_value=server), patch.object(app.webbrowser, "open"), \
                 patch.object(app, "candidate_repository", side_effect=AssertionError("Startup cannot access candidates")), redirect_stdout(io.StringIO()):
                app.main(args)
            self.assertEqual(server.auth_service.repository.directory, expected)
            self.assertEqual(server.auth_service.status(), "ready" if not args else "setup-required")
            server.server_close.assert_called_once()
        self.assertFalse((self.root / "alternate").exists())

    def test_cli_alias_verification_and_cancellation_do_not_create_other_roots(self):
        cli = owner_cli(); selected = self.root / "custom" / "security"
        for option in ("--security-dir", "--config-dir"):
            passwords = [PASSWORD, PASSWORD] if not selected.exists() else [PASSWORD]
            command = "init" if not selected.exists() else "verify-password"
            with patch.object(cli.getpass, "getpass", side_effect=passwords), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(cli.main([command, option, str(selected), "--username", USERNAME]), 0)
        with patch.object(cli.getpass, "getpass", side_effect=EOFError), redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["init", "--security-dir", str(self.root / "cancelled"), "--username", USERNAME]), 130)
        self.assertFalse((self.root / "cancelled").exists()); self.assertFalse((self.root / "ApplicationTracker").exists())
