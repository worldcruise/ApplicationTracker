"""Production startup contract; real socket checks use only ephemeral test ports."""
from contextlib import redirect_stderr, redirect_stdout
import errno
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import socket
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from manager import app


ADDRESS = ("127.0.0.1", 8765)
URL = "http://127.0.0.1:8765/"


class ManagerStartupTests(unittest.TestCase):
    def setUp(self):
        self.server = Mock(server_port=8765)
        self.server.serve_forever.side_effect = KeyboardInterrupt
        self.factory = self.enterContext(patch.object(app, "ThreadingHTTPServer", return_value=self.server))
        self.repository = self.enterContext(patch.object(app, "owner_repository"))
        self.auth = self.enterContext(patch.object(app, "AuthService"))
        self.browser = self.enterContext(patch.object(app.webbrowser, "open"))
        self.enterContext(patch.object(app, "candidate_repository", side_effect=AssertionError("No candidate access")))
        self.run_process = self.enterContext(patch.object(app.subprocess, "run", side_effect=AssertionError("No process changes")))
        self.spawn_process = self.enterContext(patch.object(app.subprocess, "Popen", side_effect=AssertionError("No process changes")))
        self.kill_process = self.enterContext(patch.object(app.os, "kill", side_effect=AssertionError("No process termination")))
        self.stdout = self.enterContext(redirect_stdout(io.StringIO()))
        self.stderr = self.enterContext(redirect_stderr(io.StringIO()))

    def test_fixed_loopback_bind_and_url_preserve_normal_shutdown(self):
        app.main([])
        self.factory.assert_called_once_with(ADDRESS, app.TrackerHandler, bind_and_activate=False)
        self.assertFalse(self.server.allow_reuse_address)
        self.assertFalse(self.server.allow_reuse_port)
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.server.socket.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        self.server.server_bind.assert_called_once_with()
        self.server.server_activate.assert_called_once_with()
        self.repository.assert_called_once_with(None)
        self.assertIs(self.server.auth_service, self.auth.return_value)
        self.assertEqual(self.stdout.getvalue(), f"Application Tracker: {URL}\n")
        self.browser.assert_called_once_with(URL)
        self.server.serve_forever.assert_called_once_with()
        self.server.server_close.assert_called_once_with()

    def test_occupied_port_fails_once_before_owner_or_browser_access(self):
        self.server.server_bind.side_effect = OSError(errno.EADDRINUSE, "Synthetic occupied port")
        with self.assertRaisesRegex(SystemExit, "127.0.0.1:8765.*No alternative port"):
            app.main([])
        self.factory.assert_called_once_with(ADDRESS, app.TrackerHandler, bind_and_activate=False)
        self.server.server_bind.assert_called_once_with()
        self.server.server_activate.assert_not_called()
        self.repository.assert_not_called()
        self.auth.assert_not_called()
        self.browser.assert_not_called()
        self.run_process.assert_not_called()
        self.spawn_process.assert_not_called()
        self.kill_process.assert_not_called()
        self.server.server_close.assert_called_once_with()
        self.assertEqual(self.stdout.getvalue(), "")

    def test_socket_creation_failure_is_clear_without_retry(self):
        self.factory.side_effect = OSError(errno.EACCES, "Synthetic socket denial")
        with self.assertRaisesRegex(SystemExit, "Cannot start Application Tracker.*8765"):
            app.main([])
        self.factory.assert_called_once()
        self.repository.assert_not_called()
        self.browser.assert_not_called()

    def test_activation_failure_closes_socket_before_authentication(self):
        self.server.server_activate.side_effect = OSError(errno.EACCES, "Synthetic listen denial")
        with self.assertRaisesRegex(SystemExit, "No alternative port"):
            app.main([])
        self.server.server_close.assert_called_once_with()
        self.repository.assert_not_called()
        self.browser.assert_not_called()

    @unittest.skipUnless(hasattr(socket, "SO_EXCLUSIVEADDRUSE"), "Windows exclusive socket option")
    def test_exclusive_socket_option_failure_does_not_bind_or_fall_back(self):
        self.server.socket.setsockopt.side_effect = OSError(errno.EACCES, "Synthetic option denial")
        with self.assertRaisesRegex(SystemExit, "No alternative port"):
            app.main([])
        self.server.server_bind.assert_not_called()
        self.server.server_close.assert_called_once_with()
        self.repository.assert_not_called()

    def test_owner_resolution_failure_releases_bound_socket(self):
        self.repository.side_effect = ValueError("Synthetic invalid security override")
        with self.assertRaisesRegex(ValueError, "Synthetic invalid"):
            app.main([])
        self.server.server_close.assert_called_once_with()
        self.browser.assert_not_called()
        self.server.serve_forever.assert_not_called()

    def test_auth_service_failure_releases_bound_socket(self):
        self.auth.side_effect = RuntimeError("Synthetic authentication initialization failure")
        with self.assertRaisesRegex(RuntimeError, "Synthetic authentication"):
            app.main([])
        self.server.server_close.assert_called_once_with()
        self.browser.assert_not_called()

    def test_browser_failure_releases_bound_socket(self):
        self.browser.side_effect = OSError("Synthetic browser launch failure")
        with self.assertRaisesRegex(OSError, "Synthetic browser"):
            app.main([])
        self.server.server_close.assert_called_once_with()
        self.server.serve_forever.assert_not_called()

    def test_serving_failure_releases_socket(self):
        self.server.serve_forever.side_effect = RuntimeError("Synthetic serving failure")
        with self.assertRaisesRegex(RuntimeError, "Synthetic serving"):
            app.main([])
        self.server.server_close.assert_called_once_with()

    def test_lan_and_alternate_port_arguments_are_rejected(self):
        for arguments in (["--host", "0.0.0.0"], ["--host", "192.0.2.1"], ["--port", "0"], ["--port", "8766"]):
            with self.subTest(arguments=arguments), self.assertRaises(SystemExit) as result:
                app.main(arguments)
            self.assertEqual(result.exception.code, 2)
        self.factory.assert_not_called()
        self.repository.assert_not_called()

    def test_real_available_socket_is_ipv4_exclusive_and_released(self):
        servers = []

        def isolated_factory(address, handler, **options):
            self.assertEqual(address, ADDRESS)
            self.assertEqual(options, {"bind_and_activate": False})
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler, **options)
            self.addCleanup(server.server_close)
            servers.append(server)

            def inspect_bound_socket():
                self.assertEqual(server.socket.family, socket.AF_INET)
                self.assertEqual(server.server_address[0], "127.0.0.1")
                self.assertGreater(server.server_port, 0)
                self.assertEqual(server.socket.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR), 0)
                if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                    self.assertEqual(server.socket.getsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE), 1)
                with self.assertRaises(OSError):
                    duplicate = ThreadingHTTPServer(server.server_address, BaseHTTPRequestHandler)
                    duplicate.server_close()
                raise KeyboardInterrupt

            server.serve_forever = inspect_bound_socket
            return server

        self.factory.side_effect = isolated_factory
        app.main([])
        self.assertEqual(len(servers), 1)
        self.assertEqual(servers[0].socket.fileno(), -1)
        self.browser.assert_called_once_with(f"http://127.0.0.1:{servers[0].server_port}/")

    def test_real_occupied_socket_rejects_startup_and_preserves_occupant(self):
        with ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler) as occupant:
            servers = []

            def isolated_factory(address, handler, **options):
                self.assertEqual(address, ADDRESS)
                self.assertEqual(options, {"bind_and_activate": False})
                server = ThreadingHTTPServer(occupant.server_address, handler, **options)
                self.addCleanup(server.server_close)
                servers.append(server)
                return server

            self.factory.side_effect = isolated_factory
            with self.assertRaisesRegex(SystemExit, "127.0.0.1:8765.*No alternative port"):
                app.main([])
            self.factory.assert_called_once()
            self.assertEqual(servers[0].socket.fileno(), -1)
            self.assertNotEqual(occupant.socket.fileno(), -1)
            with socket.create_connection(occupant.server_address, timeout=2):
                pass
            self.repository.assert_not_called()
            self.browser.assert_not_called()
            self.kill_process.assert_not_called()

    def test_fixed_port_host_origin_and_csrf_checks_remain_strict(self):
        handler = app.TrackerHandler.__new__(app.TrackerHandler)
        handler.server = SimpleNamespace(server_port=8765)
        handler.send_json = Mock()
        valid = {"Host": "127.0.0.1:8765", "Origin": URL.rstrip("/"), "X-Tracker-Token": app.SESSION_TOKEN}
        handler.headers = valid
        self.assertTrue(handler.check_local_request(write=True))
        for changes in ({"Host": "127.0.0.1:8766"}, {"Host": "localhost:8765"},
                        {"Host": "192.0.2.1:8765"}, {"Origin": "http://127.0.0.1:8766"},
                        {"Origin": "https://untrusted.example"}, {"X-Tracker-Token": "invalid"}):
            with self.subTest(changes=changes):
                handler.headers = {**valid, **changes}
                self.assertFalse(handler.check_local_request(write=True))
                self.assertEqual(handler.send_json.call_args.args[0], 403)


if __name__ == "__main__":
    unittest.main()
