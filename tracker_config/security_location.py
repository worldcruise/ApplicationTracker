"""Read-only owner-store discovery and explicitly requested private provisioning.

Defaults come from the current Windows user's Known Folders, never environment
variables or the working directory. Importing this module performs no I/O.
"""
from functools import cached_property
import os
from pathlib import Path
import stat
import uuid

from .models import ConfigurationError


LEGACY_DIRECTORY = Path(__file__).resolve().parents[1] / "config"
KNOWN_FOLDERS = {
    "local": "f1b32785-6fba-4fcf-9d55-7b8e7f157091",
    "profile": "5e6c858f-0e22-4760-9afe-ea3317b67173",
}


def windows_known_folder(name):
    if os.name != "nt":
        raise ConfigurationError("Default private owner storage requires Windows; select an absolute --security-dir on other platforms.")
    import ctypes as c
    from ctypes import wintypes as w

    class GUID(c.Structure):
        _fields_ = [("data", c.c_ubyte * 16)]

    shell, ole = c.WinDLL("shell32", use_last_error=True), c.WinDLL("ole32", use_last_error=True)
    ole.CoInitializeEx.argtypes, ole.CoInitializeEx.restype = [c.c_void_p, w.DWORD], c.c_long
    ole.CoUninitialize.argtypes, ole.CoUninitialize.restype = [], None
    ole.CoTaskMemFree.argtypes, ole.CoTaskMemFree.restype = [c.c_void_p], None
    shell.SHGetKnownFolderPath.argtypes = [c.POINTER(GUID), w.DWORD, w.HANDLE, c.POINTER(c.c_void_p)]
    shell.SHGetKnownFolderPath.restype = c.c_long
    initialized = ole.CoInitializeEx(None, 2)
    if initialized < 0 and initialized != -2147417850:  # RPC_E_CHANGED_MODE
        raise ConfigurationError("Current-user Known Folder initialization failed.")
    result = c.c_void_p()
    try:
        identifier = GUID((c.c_ubyte * 16).from_buffer_copy(uuid.UUID(KNOWN_FOLDERS[name]).bytes_le))
        # Flags 0: resolve the current user's folder without creating it.
        if shell.SHGetKnownFolderPath(c.byref(identifier), 0, None, c.byref(result)) < 0 or not result.value:
            raise ConfigurationError("Current-user Known Folder resolution failed; no alternative security location was selected.")
        return Path(c.wstring_at(result))
    finally:
        if result.value:
            ole.CoTaskMemFree(result)
        if initialized >= 0:
            ole.CoUninitialize()


def _absolute(value):
    try:
        path = Path(value)
    except (TypeError, ValueError) as error:
        raise ConfigurationError("Owner storage requires an absolute local directory.") from error
    if not path.is_absolute() or ".." in path.parts or "\0" in str(path):
        raise ConfigurationError("Owner storage requires an absolute local directory without traversal.")
    if os.name == "nt":
        reserved = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
        if str(path).startswith("\\\\"):
            raise ConfigurationError("UNC and device paths are not supported for owner storage.")
        for part in path.parts[1:]:
            if (part.endswith((" ", ".")) or part.split(".", 1)[0].upper() in reserved
                    or any(char in '<>:"|?*' or ord(char) < 32 for char in part)):
                raise ConfigurationError("Owner storage contains an unsafe Windows path component.")
    return path


def _info(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise PermissionError("Owner storage cannot traverse symbolic links or reparse points.")
    return info


def security_artifacts(directory):
    """Names only: detect credentials and interrupted/recovery evidence."""
    return [path for path in directory.iterdir()
            if path.name.casefold() == "security.json"
            or path.name.casefold().startswith(("security.json.", ".security.json."))]


class SecurityLocation:
    def __init__(self, directory=None, *, known_folder=None, legacy_directory=None):
        self.explicit, self.known_folder, self.legacy_directory = directory, known_folder, legacy_directory

    def _known(self, name):
        return _absolute((self.known_folder or windows_known_folder)(name))

    @cached_property
    def local_base(self):
        return self._known("local")

    @cached_property
    def directory(self):
        return _absolute(self.explicit) if self.explicit is not None else self.local_base / "ApplicationTracker" / "security"

    @cached_property
    def anchor(self):
        if os.name == "nt" or self.known_folder is not None:
            profile = self._known("profile")
        else:
            import pwd
            profile = _absolute(pwd.getpwuid(os.getuid()).pw_dir)
        return profile if self.directory.is_relative_to(profile) else Path(self.directory.anchor)

    def check_legacy(self):
        if self.legacy_directory is None:
            return
        legacy = _absolute(self.legacy_directory)
        for path in (*reversed(legacy.parents), legacy):
            if _info(path) is None:
                return
        if security_artifacts(legacy):
            raise ConfigurationError("Legacy owner credentials or recovery artifacts exist in the repository config directory. Stop and use a separately approved offline migration; nothing was moved or reset.")

    def inspect(self, permissions, *, missing_ok=False):
        self.check_legacy()
        directory = self.directory
        chain = [*reversed(directory.parents), directory]
        # Check redirections all the way to the volume root before following paths.
        for path in chain:
            _info(path)
        if self.explicit is None and _info(self.local_base) is None:
            raise PermissionError("The current-user Local AppData folder is missing; setup cannot create an OS Known Folder.")
        anchor = self.anchor
        if _info(anchor) is None:
            raise PermissionError("The trusted owner-storage ancestor is missing.")
        missing = []
        nearest = anchor
        for path in chain[chain.index(anchor):]:
            if _info(path) is None:
                missing.append(path)
                continue
            if missing:
                raise PermissionError("Owner storage changed during path validation.")
            private = path == directory or self.explicit is None and path == directory.parent
            permissions.validate(path, directory=True, private=private)
            nearest = path
        if missing:
            permissions.require_create(nearest)
            if not missing_ok:
                raise FileNotFoundError("Owner storage has not been initialized; explicit administrative setup is required.")
        return missing

    def provision(self, permissions):
        # Only SecurityRepository.initialize calls this mutating operation.
        for path in self.inspect(permissions, missing_ok=True):
            self.inspect(permissions, missing_ok=True)
            permissions.create_private_directory(path)
        self.inspect(permissions)
