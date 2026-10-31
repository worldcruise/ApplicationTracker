"""Shared synthetic owner fixtures; never reads application configuration."""
import copy
from functools import lru_cache
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tracker_config.auth import AuthService
from tracker_config.security import SecurityRepository, create_password_verifier
from tracker_config.security_files import private_atomic_write
from tracker_config import security_location


PASSWORD = "Synthetic auth passphrase 123!"
NEW_PASSWORD = "Changed synthetic auth passphrase 456!"
USERNAME = "synthetic-owner"


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


@lru_cache(maxsize=1)
def verifier():
    return create_password_verifier(PASSWORD)


class AuthFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tracker-auth-tests-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / "security"
        self.enterContext(patch.object(security_location, "windows_known_folder", lambda name: self.root))
        self.enterContext(patch.object(security_location, "LEGACY_DIRECTORY", self.root / "legacy"))
        self.repository = SecurityRepository(self.directory)
        self.repository.permissions.make_private(self.root)
        self.repository.permissions.create_private_directory(self.directory)
        self.record = {"schemaVersion": 1, "backendId": "1" * 32, "authEpoch": "2" * 32,
                       "users": [{"id": "3" * 32, "username": USERNAME, "role": "owner", "disabled": False,
                                  "passwordVerifier": copy.deepcopy(verifier()), "authGeneration": 1,
                                  "createdAt": "2026-01-01T00:00:00Z", "passwordChangedAt": "2026-01-01T00:00:00Z"}]}
        self.write(self.repository.path, json.dumps(self.record).encode())
        self.clock = Clock()
        self.service = AuthService(self.repository, clock=self.clock)

    def write(self, path, content):
        private_atomic_write(path, content, permissions=self.repository.permissions)

    def login(self, **options):
        return self.service.login(USERNAME, PASSWORD, **options)
