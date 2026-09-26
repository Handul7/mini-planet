"""Boundary tests using temporary files and a fake loopback controller only."""

import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "owner_server", Path(__file__).resolve().parents[1] / "scripts" / "owner-server.py")
owner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(owner)


class FakeController(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.calls.append((self.path, dict(self.headers)))
        if self.server.delay:
            time.sleep(self.server.delay)
        body = self.server.body
        self.send_response(self.server.status)
        self.send_header("Content-Type", self.server.content_type)
        self.send_header("Set-Cookie", "upstream=never-forward")
        self.send_header("Location", "http://example.invalid/redirect")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class OwnerServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "build"
        self.root.mkdir()
        (self.root / "index.html").write_text("<h1>Mini Planet</h1>")
        (self.root / "assets").mkdir()
        (self.root / "assets" / "planet.svg").write_text("<svg></svg>")
        self.key = self.base / "controller-key"
        self.password = self.base / "owner-password"
        self.key.write_text("fake-controller-bearer-not-for-browser\n")
        self.password.write_text("separate-owner-test-password\n")
        self.key.chmod(0o600)
        self.password.chmod(0o600)
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeController)
        self.upstream.daemon_threads = True
        self.upstream.calls = []
        self.upstream.body = b'{"ok": true}'
        self.upstream.status = 200
        self.upstream.content_type = "application/json"
        self.upstream.delay = 0
        self.start(self.upstream)
        self.server = self.make_server()
        self.start(self.server)

    def start(self, server):
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

    def make_server(self, **changes):
        options = dict(root=self.root, controller_url=f"http://127.0.0.1:{self.upstream.server_port}",
                       controller_key_file=self.key, password_file=self.password)
        options.update(changes)
        return owner.OwnerServer(("127.0.0.1", 0), **options)

    def request(self, method="GET", path="/owner/session", data=None, cookie=None, headers=None, server=None):
        server = server or self.server
        host = f"127.0.0.1:{server.server_port}"
        actual = {"Host": host}
        if cookie:
            actual["Cookie"] = cookie
        body = None
        if data is not None:
            body = json.dumps(data)
            actual["Content-Type"] = "application/json"
        if method in ("POST", "DELETE"):
            actual["Origin"] = f"http://{host}"
        actual.update(headers or {})
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        conn.request(method, path, body=body, headers=actual)
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def login(self, **kwargs):
        status, headers, body = self.request("POST", data={"password": "separate-owner-test-password"}, **kwargs)
        self.assertEqual(status, 200, body)
        return headers["Set-Cookie"].split(";", 1)[0], headers, json.loads(body)

    def test_public_static_private_api_and_logout(self):
        self.assertEqual(self.request(path="/?owner=1")[0], 200)
        self.assertEqual(self.request()[0], 401)
        self.assertEqual(self.request(path="/api/v1/status")[0], 401)
        self.assertEqual(self.upstream.calls, [])
        cookie, headers, data = self.login()
        self.assertTrue(data["authenticated"])
        self.assertIn("expiresAt", data)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertNotIn("Secure", headers["Set-Cookie"])
        self.assertEqual(self.request(cookie=cookie)[0], 200)
        status, headers, _ = self.request("DELETE", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.request(cookie=cookie)[0], 401)
        self.assertEqual(self.request(path="/api/v1/status", cookie=cookie)[0], 401)

    def test_proxy_allowlist_credentials_and_response_headers(self):
        cookie, _, _ = self.login()
        paths = ["/api/v1/status", "/api/v1/board", "/api/v1/results/rodi"]
        paths += ["/api/v1/jobs?profile=" + profile for profile in ("default", "rodi", "jarvis")]
        for path in paths:
            with self.subTest(path=path):
                status, headers, body = self.request(path=path, cookie=cookie,
                    headers={"Authorization": "Bearer browser-value-must-not-forward"})
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body), {"ok": True})
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertNotIn("Set-Cookie", headers)
                self.assertNotIn("Location", headers)
                self.assertNotIn("Access-Control-Allow-Origin", headers)
                actual_path, sent = self.upstream.calls[-1]
                self.assertEqual(actual_path, path)
                self.assertEqual(sent["Authorization"], "Bearer fake-controller-bearer-not-for-browser")
                self.assertNotIn("Cookie", sent)

    def test_disallowed_routes_queries_methods_do_not_reach_controller(self):
        cookie, _, _ = self.login()
        for path in ("/api/v1/status?token=x", "/api/v1/board?x=1", "/api/v1/jobs",
                     "/api/v1/jobs?profile=other", "/api/v1/jobs?profile=rodi&profile=jarvis",
                     "/api/v1/jobs?profile=rodi&extra=1", "/api/v1/jobs?x=1&x=2&x=3&x=4&x=5",
                     "/api/v1/results/jarvis", "/api/v1/runs", "/api/v1/../status",
                     "/api/v1/%73tatus", "/api/v1/status/"):
            with self.subTest(path=path):
                self.assertIn(self.request(path=path, cookie=cookie)[0], (400, 404))
        for method in ("POST", "DELETE", "PUT", "PATCH", "HEAD", "OPTIONS", "TRACE"):
            self.assertEqual(self.request(method, "/api/v1/status", cookie=cookie)[0], 405)
        self.assertEqual(self.upstream.calls, [])

    def test_origin_and_host_rejected_before_auth_or_upstream(self):
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"},
                        {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"},
                        {"Sec-Fetch-Site": "same-site"}):
            self.assertEqual(self.request(headers=headers)[0], 403)
        self.assertEqual(self.request("POST", data={"password": "separate-owner-test-password"},
            headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.upstream.calls, [])

    def test_https_origin_secure_cookie_and_host_preservation(self):
        secure = self.make_server(origin="https://owner.example")
        self.start(secure)
        headers = {"Host": "owner.example", "Origin": "https://owner.example"}
        cookie, response, _ = self.login(server=secure, headers=headers)
        self.assertIn("; Secure", response["Set-Cookie"])
        self.assertEqual(self.request(cookie=cookie, server=secure, headers=headers)[0], 200)
        self.assertEqual(self.request(cookie=cookie, server=secure)[0], 403)
        self.assertEqual(self.request(cookie=cookie, server=secure,
            headers={"Host": "owner.example", "Origin": "http://owner.example"})[0], 403)

    def test_password_failures_are_throttled(self):
        for _ in range(5):
            self.assertEqual(self.request("POST", data={"password": "wrong"})[0], 401)
        status, headers, body = self.request("POST", data={"password": "wrong"})
        self.assertEqual(status, 429)
        self.assertEqual(headers["Retry-After"], "60")
        self.assertNotIn(b"separate-owner-test-password", body)

    def test_expiry_and_relogin_rotate_sessions(self):
        old, _, _ = self.login()
        new, _, _ = self.login(cookie=old)
        self.assertNotEqual(old, new)
        self.assertEqual(self.request(cookie=old)[0], 401)
        with self.server.lock:
            for key in self.server.sessions:
                self.server.sessions[key] = time.time() - 1
        self.assertEqual(self.request(cookie=new)[0], 401)

    def test_redirects_invalid_json_large_and_secret_responses_fail_closed(self):
        cookie, _, _ = self.login()
        cases = [(302, "application/json", b'{}'), (200, "text/html", b'<html>'),
                 (200, "application/json", b'not json'),
                 (200, "application/json", b' ' * (owner.MAX_RESPONSE + 1)),
                 (200, "application/json", json.dumps({"key": self.key.read_text().strip()}).encode())]
        for status, content_type, body in cases:
            self.upstream.status, self.upstream.content_type, self.upstream.body = status, content_type, body
            result = self.request(path="/api/v1/status", cookie=cookie)
            self.assertEqual(result[0], 502)
            self.assertEqual(json.loads(result[2]), {"error": "controller_unavailable"})
        self.assertEqual(len(self.upstream.calls), len(cases))

    def test_controller_deadline(self):
        self.server.upstream_timeout = 0.05
        self.upstream.delay = 0.3
        cookie, _, _ = self.login()
        started = time.monotonic()
        self.assertEqual(self.request(path="/api/v1/status", cookie=cookie)[0], 502)
        self.assertLess(time.monotonic() - started, 0.25)

    def test_only_documented_controller_failure_envelope_keeps_503(self):
        cookie, _, _ = self.login()
        valid = {"source": "dashboard", "status": "error", "observed_at": "2026-09-25T11:30:00Z",
                 "last_success_at": None, "expires_at": None, "stale": True,
                 "error": "upstream_unavailable", "data": None}
        self.upstream.status = 503
        self.upstream.body = json.dumps(valid).encode()
        for path in ("/api/v1/board", "/api/v1/jobs?profile=rodi", "/api/v1/results/rodi"):
            status, headers, body = self.request(path=path, cookie=cookie)
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body), valid)
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.request(path="/api/v1/status", cookie=cookie)[0], 502)
        for invalid in ({"error": "unavailable"}, {**valid, "data": {"secret": "not allowed"}},
                        {**valid, "source": "other"}, {**valid, "stale": False},
                        {**valid, "observed_at": "not a timestamp"},
                        {**valid, "observed_at": "2026-09-25T11:30:00"},
                        {**valid, "extra": "unrecognized"},
                        {**valid, "error": self.key.read_text().strip()}):
            self.upstream.body = json.dumps(invalid).encode()
            result = self.request(path="/api/v1/board", cookie=cookie)
            self.assertEqual(result[0], 502)
            self.assertEqual(json.loads(result[2]), {"error": "controller_unavailable"})

    def test_environment_proxy_is_never_used(self):
        cookie, _, _ = self.login()
        with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:1",
                                     "HTTP_PROXY": "http://127.0.0.1:1",
                                     "ALL_PROXY": "http://127.0.0.1:1", "NO_PROXY": ""}):
            self.assertEqual(self.request(path="/api/v1/status", cookie=cookie)[0], 200)
        self.assertEqual(len(self.upstream.calls), 1)

    def test_concurrency_cap_rejects_without_spawning_more_work(self):
        for _ in range(16):
            self.server.slots.acquire()
        try:
            response = self.raw_request(b"GET / HTTP/1.0\r\n\r\n")
            self.assertIn(b"503", response.split(b"\r\n")[0])
        finally:
            for _ in range(16):
                self.server.slots.release()
        self.assertEqual(self.upstream.calls, [])

    def test_static_files_cannot_escape_build_or_follow_links(self):
        (self.root / "assets" / "secret.txt").symlink_to(self.password)
        (self.root / "assets" / "escape").symlink_to(self.base, target_is_directory=True)
        (self.root / "assets" / "services.local.json").write_text("private")
        for path in ("/../owner-password", "/%2e%2e/owner-password", "/assets/%2e%2e/index.html",
                     "/assets/%252e%252e/index.html", "/assets/secret.txt", "/assets/escape/owner-password",
                     "/assets/services.local.json", "/.env", "/scripts/owner-server.py", "/assets/",
                     "/assets/../index.html", "/assets%5csecret.txt"):
            with self.subTest(path=path):
                status, _, body = self.request(path=path)
                self.assertEqual(status, 404)
                self.assertNotIn(b"separate-owner-test-password", body)
        self.assertEqual(self.request(path="/assets/planet.svg")[0], 200)

    def test_private_files_and_configuration_validation(self):
        self.password.chmod(0o644)
        with self.assertRaises(ValueError):
            self.make_server()
        self.password.chmod(0o600)
        secret_inside = self.root / "assets" / "password"
        secret_inside.write_text("private")
        secret_inside.chmod(0o600)
        with self.assertRaises(ValueError):
            self.make_server(password_file=secret_inside)
        for url in ("http://localhost:8080", "https://127.0.0.1:8080", "http://127.0.0.1",
                    "http://127.0.0.1:8080/private", "http://user:pass@127.0.0.1:8080"):
            with self.assertRaises(ValueError):
                self.make_server(controller_url=url)
        (self.root / "private.txt").write_text("not a build")
        with self.assertRaises(ValueError):
            self.make_server()

    def raw_request(self, request):
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=3) as conn:
            conn.sendall(request)
            chunks = []
            while True:
                try:
                    part = conn.recv(65536)
                except ConnectionResetError:
                    if chunks:
                        break
                    raise
                if not part:
                    break
                chunks.append(part)
        return b"".join(chunks)

    def test_request_boundary_rejects_ambiguous_and_oversize_bodies(self):
        host = f"127.0.0.1:{self.server.server_port}".encode()
        base = b"POST /owner/session HTTP/1.1\r\nHost: " + host + b"\r\nOrigin: http://" + host + b"\r\n"
        for headers, status in ((b"Content-Length: 5000\r\n", b"413"),
                                (b"Content-Length: 1\r\nContent-Length: 1\r\n", b"400"),
                                (b"Transfer-Encoding: chunked\r\n", b"400"),
                                (b"Host: evil.example\r\n", b"403")):
            response = self.raw_request(base + headers + b"\r\n")
            self.assertIn(status, response.split(b"\r\n")[0])
        without_origin = b"POST /owner/session HTTP/1.1\r\nHost: " + host + b"\r\nContent-Length: 0\r\n\r\n"
        self.assertIn(b"403", self.raw_request(without_origin).split(b"\r\n")[0])
        oversized = base + b"X-Large: " + b"a" * 9000 + b"\r\n\r\n"
        self.assertIn(b"431", self.raw_request(oversized).split(b"\r\n")[0])


if __name__ == "__main__":
    unittest.main()
