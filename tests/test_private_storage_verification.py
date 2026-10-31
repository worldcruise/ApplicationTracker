"""D3 independent verification probes; synthetic owners and temporary ACLs only."""
from contextlib import chdir
import ctypes
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from auth_fixtures import PASSWORD, NEW_PASSWORD, USERNAME
from tracker_config.auth import AuthService, AuthError
from tracker_config.security import owner_repository
from tracker_config.security_files import SecurityPermissions


@unittest.skipUnless(os.name == "nt", "D3 native Windows verification")
class PrivateStorageVerificationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tracker-d3-verification-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.permissions = SecurityPermissions()
        self.permissions.make_private(self.root)
        self.known_folder = lambda name: self.root
        self.repository = owner_repository(known_folder=self.known_folder,
                                           legacy_directory=self.root / "legacy")

    def grant_synthetic_access(self, directory, mask):
        self.assertTrue(directory.is_relative_to(self.root))
        windows = self.permissions.windows
        c, w = windows.c, windows.w
        descriptor, dacl = c.c_void_p(), c.c_void_p()
        # A SID used only in this temporary DACL; no OS account is registered.
        synthetic_sid = "S-1-5-21-111111111-222222222-333333333-1001"
        sddl = f"D:P(A;;FA;;;{windows.user_sid})(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x{mask:08x};;;{synthetic_sid})"
        windows._require(windows.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, 1, c.byref(descriptor), None))
        try:
            present, defaulted = w.BOOL(), w.BOOL()
            windows._require(windows.advapi.GetSecurityDescriptorDacl(
                descriptor, c.byref(present), c.byref(dacl), c.byref(defaulted)))
            self.assertEqual(windows.advapi.SetNamedSecurityInfoW(
                str(directory), 1, 0x80000004, None, None, dacl, None), 0)
        finally:
            windows.kernel.LocalFree(descriptor)

    def assert_native_private_acl(self, path, *, directory):
        self.assertTrue(path.is_relative_to(self.root))
        windows = self.permissions.windows
        c, w = windows.c, windows.w
        owner, dacl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
        self.assertEqual(windows.advapi.GetNamedSecurityInfoW(
            str(path), 1, 5, c.byref(owner), None, c.byref(dacl), None,
            c.byref(descriptor)), 0)
        try:
            self.assertIn(windows._sid_text(owner), windows.trusted_sids)
            control, revision = w.WORD(), w.DWORD()
            windows._require(windows.advapi.GetSecurityDescriptorControl(
                descriptor, c.byref(control), c.byref(revision)))
            self.assertTrue(control.value & 0x1000)
            count = c.c_ushort.from_address(dacl.value + 4).value
            grants = {}
            for index in range(count):
                ace = c.c_void_p()
                windows._require(windows.advapi.GetAce(dacl, index, c.byref(ace)))
                self.assertEqual(c.c_ubyte.from_address(ace.value).value, 0)
                flags = c.c_ubyte.from_address(ace.value + 1).value
                self.assertFalse(flags & (0x08 | 0x10))  # No inherit-only/inherited ACE.
                self.assertEqual(flags & 3, 3 if directory else 0)
                sid = windows._sid_text(c.c_void_p(ace.value + 8))
                grants[sid] = w.DWORD.from_address(ace.value + 4).value
            self.assertEqual(set(grants), windows.trusted_sids)
            for mask in grants.values():
                self.assertEqual(mask & 0x001F01FF, 0x001F01FF)
        finally:
            windows.kernel.LocalFree(descriptor)

    def test_each_dangerous_ancestor_right_blocks_provisioning(self):
        rights = {"write-data": 2, "add-subdirectory": 4, "write-ea": 16,
                  "delete-child": 64, "write-attributes": 256, "delete": 0x10000,
                  "write-dac": 0x40000, "write-owner": 0x80000,
                  "generic-write": 0x40000000, "generic-all": 0x10000000}
        for label, mask in rights.items():
            with self.subTest(right=label):
                self.grant_synthetic_access(self.root, mask)
                try:
                    self.assertEqual(AuthService(self.repository).status(), "unavailable")
                    with self.assertRaises(PermissionError):
                        self.repository.initialize(USERNAME, PASSWORD)
                    self.assertFalse(self.repository.directory.parent.exists())
                    with self.assertRaises(PermissionError):
                        self.permissions.validate(self.root, directory=True)
                finally:
                    # Restore only the explicitly owned disposable fixture root.
                    self.permissions.make_private(self.root)

    def test_atomic_reset_and_recovery_keep_exact_private_native_grants(self):
        original = self.repository.initialize(USERNAME, PASSWORD)
        self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=original.revision)
        paths = [self.repository.directory.parent, self.repository.directory,
                 self.repository.path, self.repository.backup_path]
        for path in paths:
            self.assert_native_private_acl(path, directory=path.is_dir())
        from tracker_config.security_files import private_atomic_write
        private_atomic_write(self.repository.path, b"corrupt synthetic primary",
                             permissions=self.permissions)
        recovery = self.repository.recovery_snapshot()
        self.repository.recover_backup(USERNAME, PASSWORD, expected_revision=recovery.revision,
                                       expected_backup_revision=recovery.backup_revision)
        retained = list(self.repository.directory.glob(".security.json.before-restore.*"))
        self.assertEqual(len(retained), 1)
        for path in [*paths, *retained]:
            self.assert_native_private_acl(path, directory=path.is_dir())

    def test_ancestor_acl_changed_after_flush_blocks_atomic_replacement(self):
        original = self.repository.initialize(USERNAME, PASSWORD)
        before = self.repository.path.read_bytes()
        import tracker_config.security_files as files
        flush = files.os.fsync
        def changed_acl(descriptor):
            flush(descriptor)
            self.grant_synthetic_access(self.root, 0x40000)
        try:
            with patch.object(files.os, "fsync", side_effect=changed_acl):
                with self.assertRaises(PermissionError):
                    self.repository.reset_password(USERNAME, NEW_PASSWORD,
                                                   expected_revision=original.revision)
            self.assertEqual(self.repository.path.read_bytes(), before)
            self.assertFalse(self.repository.backup_path.exists())
            self.assertEqual(list(self.repository.directory.glob(".security.json.*")), [])
        finally:
            self.permissions.make_private(self.root)

    def test_explicit_roots_have_distinct_identities_credentials_and_revisions(self):
        first = owner_repository(self.root / "first", known_folder=self.known_folder,
                                 legacy_directory=self.root / "legacy")
        second = owner_repository(self.root / "second", known_folder=self.known_folder,
                                  legacy_directory=self.root / "legacy")
        left = first.initialize(USERNAME, PASSWORD)
        right = second.initialize(USERNAME, NEW_PASSWORD)
        self.assertNotEqual(left.data["backendId"], right.data["backendId"])
        self.assertNotEqual(left.data["users"][0]["id"], right.data["users"][0]["id"])
        service = AuthService(second)
        token = service.login(USERNAME, NEW_PASSWORD).token
        with self.assertRaises(AuthError):
            service.login(USERNAME, PASSWORD)
        first.reset_password(USERNAME, NEW_PASSWORD, expected_revision=left.revision)
        self.assertEqual(second.read(), right)
        self.assertEqual(service.session(token)["user"]["id"], right.data["users"][0]["id"])

    def test_two_checkout_legacy_roots_share_default_owner_but_not_session_memory(self):
        first = owner_repository(known_folder=self.known_folder,
                                 legacy_directory=self.root / "checkout-a" / "config")
        second = owner_repository(known_folder=self.known_folder,
                                  legacy_directory=self.root / "checkout-b" / "config")
        record = first.initialize(USERNAME, PASSWORD)
        self.assertEqual(first.directory, second.directory)
        self.assertEqual(record, second.read())
        first_service, second_service = AuthService(first), AuthService(second)
        token = first_service.login(USERNAME, PASSWORD).token
        with self.assertRaises(AuthError):
            second_service.session(token)
        second_record = second_service.login(USERNAME, PASSWORD)
        self.assertEqual(second_record.metadata["user"]["id"], record.data["users"][0]["id"])

    def test_changing_working_directory_never_changes_default_storage(self):
        checkout_a, checkout_b = self.root / "checkout-a", self.root / "checkout-b"
        checkout_a.mkdir(); checkout_b.mkdir()
        with chdir(checkout_a):
            first = owner_repository(known_folder=self.known_folder, legacy_directory=None)
            original = first.initialize(USERNAME, PASSWORD)
        with chdir(checkout_b):
            second = owner_repository(known_folder=self.known_folder, legacy_directory=None)
            self.assertEqual(second.path, first.path)
            self.assertEqual(second.read(), original)
        self.assertEqual(list(checkout_a.iterdir()), [])
        self.assertEqual(list(checkout_b.iterdir()), [])

    def test_real_windows_junction_cannot_redirect_reads_or_initialization(self):
        target, junction = self.root / "target", self.root / "junction"
        self.permissions.create_private_directory(target)
        result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(target)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(junction.is_junction())
        try:
            redirected = owner_repository(junction / "security", known_folder=self.known_folder,
                                           legacy_directory=None)
            self.assertEqual(AuthService(redirected).status(), "unavailable")
            with self.assertRaises(PermissionError):
                redirected.initialize(USERNAME, PASSWORD)
            self.assertEqual(list(target.iterdir()), [])
        finally:
            self.assertTrue(junction.is_relative_to(self.root))
            junction.rmdir()
