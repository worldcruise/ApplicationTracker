"""Private security files and administrative locking; no I/O on import.

Windows uses native DACLs, not chmod's read-only flag. POSIX uses owner-only files.
Only newly created test/admin files have their permissions set automatically.
Existing files/directories with unsafe permissions are rejected, never repaired.
"""
from contextlib import contextmanager
from functools import cached_property
import hashlib
import os
from pathlib import Path
import stat
import tempfile


class _WindowsAccess:
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        self.c, self.w = c, w
        self.advapi = c.WinDLL("advapi32", use_last_error=True)
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        pointer = c.POINTER(c.c_void_p)
        signatures = [
            (self.kernel.GetCurrentProcess, [], w.HANDLE),
            (self.kernel.CloseHandle, [w.HANDLE], w.BOOL),
            (self.kernel.LocalFree, [c.c_void_p], c.c_void_p),
            (self.kernel.CreateMutexW, [c.c_void_p, w.BOOL, w.LPCWSTR], w.HANDLE),
            (self.kernel.CreateDirectoryW, [w.LPCWSTR, c.c_void_p], w.BOOL),
            (self.kernel.WaitForSingleObject, [w.HANDLE, w.DWORD], w.DWORD),
            (self.kernel.ReleaseMutex, [w.HANDLE], w.BOOL),
            (self.advapi.OpenProcessToken, [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)], w.BOOL),
            (self.advapi.GetTokenInformation, [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)], w.BOOL),
            (self.advapi.ConvertSidToStringSidW, [c.c_void_p, pointer], w.BOOL),
            (self.advapi.GetNamedSecurityInfoW, [w.LPWSTR, c.c_int, w.DWORD, pointer, pointer, pointer, pointer, pointer], w.DWORD),
            (self.advapi.GetAce, [c.c_void_p, w.DWORD, pointer], w.BOOL),
            (self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW, [w.LPCWSTR, w.DWORD, pointer, c.POINTER(w.DWORD)], w.BOOL),
            (self.advapi.GetSecurityDescriptorDacl, [c.c_void_p, c.POINTER(w.BOOL), pointer, c.POINTER(w.BOOL)], w.BOOL),
            (self.advapi.GetSecurityDescriptorControl, [c.c_void_p, c.POINTER(w.WORD), c.POINTER(w.DWORD)], w.BOOL),
            (self.advapi.SetNamedSecurityInfoW, [w.LPWSTR, c.c_int, w.DWORD, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p], w.DWORD),
        ]
        for function, arguments, result in signatures:
            function.argtypes, function.restype = arguments, result
        token = w.HANDLE()
        self._require(self.advapi.OpenProcessToken(self.kernel.GetCurrentProcess(), 0x0008, c.byref(token)))
        try:
            size = w.DWORD()
            self.advapi.GetTokenInformation(token, 1, None, 0, c.byref(size))
            buffer = c.create_string_buffer(size.value)
            self._require(self.advapi.GetTokenInformation(token, 1, buffer, size, c.byref(size)))
            sid = c.cast(buffer, c.POINTER(c.c_void_p))[0]
            self.user_sid = self._sid_text(sid)
        finally:
            self.kernel.CloseHandle(token)
        self.trusted_sids = {self.user_sid, "S-1-5-18", "S-1-5-32-544"}

    def _require(self, result):
        if not result:
            raise PermissionError("Windows security permissions could not be verified (error %d)." % self.c.get_last_error())

    def _sid_text(self, sid):
        result = self.c.c_void_p()
        self._require(self.advapi.ConvertSidToStringSidW(sid, self.c.byref(result)))
        try:
            return self.c.wstring_at(result)
        finally:
            self.kernel.LocalFree(result)

    def validate(self, path, *, directory=False, private=False, require_create=False):
        c, w = self.c, self.w
        owner, dacl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
        error = self.advapi.GetNamedSecurityInfoW(str(path), 1, 0x00000005,
                                                c.byref(owner), None, c.byref(dacl), None, c.byref(descriptor))
        if error:
            raise PermissionError(f"Windows security permissions could not be read (error {error}).")
        try:
            if not owner.value or self._sid_text(owner) not in self.trusted_sids or not dacl.value:
                raise PermissionError("Security storage requires a trusted owner and an explicit restrictive DACL.")
            if private:
                control, revision = w.WORD(), w.DWORD()
                self._require(self.advapi.GetSecurityDescriptorControl(descriptor, c.byref(control), c.byref(revision)))
                if not control.value & 0x1000:
                    raise PermissionError("Private owner directories require a protected DACL without inherited access.")
            user_access = 0
            # ACL header: BYTE revision, BYTE reserved, WORD size, WORD ACE count.
            ace_count = c.c_ushort.from_address(dacl.value + 4).value
            for index in range(ace_count):
                ace = c.c_void_p()
                self._require(self.advapi.GetAce(dacl, index, c.byref(ace)))
                kind = c.c_ubyte.from_address(ace.value).value
                flags = c.c_ubyte.from_address(ace.value + 1).value
                if flags & 0x08:
                    continue
                if kind == 1:
                    if private or require_create:
                        raise PermissionError("Private owner access requires explicit review of deny ACL entries.")
                    continue
                if kind != 0:
                    raise PermissionError("Security storage has an unsupported DACL entry; review its permissions explicitly.")
                mask = w.DWORD.from_address(ace.value + 4).value
                sid = self._sid_text(c.c_void_p(ace.value + 8))
                if sid == self.user_sid:
                    user_access |= mask
                # A parent may be readable, but not writable/deletable by others.
                dangerous = mask & 0x500D0156 if directory and not private else mask
                if dangerous and sid not in self.trusted_sids:
                    raise PermissionError("Security storage grants unsafe access to another Windows principal.")
            # Conservative: do not infer create access from group membership or deny ACEs.
            if (private and user_access & 0x001F01FF != 0x001F01FF
                    or require_create and not user_access & (0x0004 | 0x10000000 | 0x40000000)):
                raise PermissionError("The current Windows user lacks explicit owner-storage access.")
        finally:
            self.kernel.LocalFree(descriptor)

    def create_private_directory(self, path):
        c, w = self.c, self.w

        class SECURITY_ATTRIBUTES(c.Structure):
            _fields_ = [("length", w.DWORD), ("descriptor", c.c_void_p), ("inherit", w.BOOL)]

        descriptor = c.c_void_p()
        sddl = f"D:P(A;OICI;FA;;;{self.user_sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        self._require(self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), None))
        try:
            attributes = SECURITY_ATTRIBUTES(c.sizeof(SECURITY_ATTRIBUTES), descriptor, False)
            if not self.kernel.CreateDirectoryW(str(path), c.byref(attributes)) and c.get_last_error() != 183:
                raise PermissionError("Private owner directory creation failed (error %d)." % c.get_last_error())
        finally:
            self.kernel.LocalFree(descriptor)

    def make_private(self, path):
        c, w = self.c, self.w
        descriptor = c.c_void_p()
        sddl = f"D:P(A;;FA;;;{self.user_sid})(A;;FA;;;SY)(A;;FA;;;BA)"
        self._require(self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), None))
        try:
            present, defaulted, dacl = w.BOOL(), w.BOOL(), c.c_void_p()
            self._require(self.advapi.GetSecurityDescriptorDacl(descriptor, c.byref(present), c.byref(dacl), c.byref(defaulted)))
            error = self.advapi.SetNamedSecurityInfoW(str(path), 1, 0x80000004, None, None, dacl, None)
            if error:
                raise PermissionError(f"Private security-file permissions could not be set (error {error}).")
        finally:
            self.kernel.LocalFree(descriptor)

    @contextmanager
    def lock(self, path):
        digest = hashlib.sha256((self.user_sid + os.path.normcase(str(path))).encode()).hexdigest()
        handle = self.kernel.CreateMutexW(None, False, "Local\\ApplicationTrackerOwner-" + digest)
        self._require(handle)
        acquired = False
        try:
            result = self.kernel.WaitForSingleObject(handle, 5000)
            if result not in (0, 0x80):
                raise PermissionError("Could not acquire the owner-store lock; another administrative command may be running.")
            acquired = True
            yield
        finally:
            if acquired:
                self.kernel.ReleaseMutex(handle)
            self.kernel.CloseHandle(handle)


class SecurityPermissions:
    @cached_property
    def windows(self):
        return _WindowsAccess()

    def validate(self, path: Path, *, directory=False, missing_ok=False, private=False):
        try:
            info = path.lstat()
        except FileNotFoundError:
            if missing_ok:
                return
            raise
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise PermissionError("Security storage cannot use symbolic links or reparse points.")
        if directory:
            if not stat.S_ISDIR(info.st_mode):
                raise PermissionError("Select an existing configuration directory.")
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise PermissionError("Security records must be regular files without hard links.")
        if os.name == "nt":
            self.windows.validate(path, directory=directory, private=private)
        elif os.name == "posix":
            mode = stat.S_IMODE(info.st_mode)
            if info.st_uid not in (os.getuid(), 0) or (mode != 0o700 if private else mode & 0o022 if directory else mode != 0o600):
                raise PermissionError("Security storage requires trusted ownership, a non-shared-writable directory and mode 0600 files.")
        else:
            raise PermissionError("Owner storage permissions are unsupported on this platform.")

    def require_create(self, path):
        self.validate(path, directory=True)
        if os.name == "nt":
            self.windows.validate(path, directory=True, require_create=True)
        elif not os.access(path, os.W_OK | os.X_OK):
            raise PermissionError("The current user cannot provision private owner storage.")

    def create_private_directory(self, path):
        if os.name == "nt":
            self.windows.create_private_directory(path)
        elif os.name == "posix":
            try:
                os.mkdir(path, 0o700)
            except FileExistsError:
                pass
        else:
            raise PermissionError("Private owner directories are unsupported on this platform.")
        self.validate(path, directory=True, private=True)

    def make_private(self, path):
        if os.name == "nt":
            self.windows.make_private(path)
        elif os.name == "posix":
            os.chmod(path, 0o600)
        else:
            raise PermissionError("Private security files are unsupported on this platform.")

    @contextmanager
    def lock(self, path):
        if os.name == "nt":
            with self.windows.lock(path):
                yield
        else:
            import fcntl
            descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                yield
            finally:
                os.close(descriptor)


def private_atomic_write(path, content, *, permissions, before_replace=None):
    """No directory creation; private temp contents are flushed before replacement."""
    permissions.validate(path.parent, directory=True)
    permissions.validate(path, missing_ok=True)
    descriptor, filename = tempfile.mkstemp(prefix=".security.json.", suffix=".tmp", dir=path.parent)
    temporary = Path(filename)
    try:
        # The initial file is empty. Restrict its DACL before writing any secrets.
        permissions.make_private(temporary)
        permissions.validate(temporary)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        permissions.validate(path.parent, directory=True)
        permissions.validate(path, missing_ok=True)
        if before_replace is not None:
            before_replace()
        os.replace(temporary, path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
