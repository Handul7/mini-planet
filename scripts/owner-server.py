#!/usr/bin/env python3
"""Private owner UI and narrow read-only controller bridge (Python stdlib only)."""

import argparse
import hashlib
import hmac
import http.client
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import secrets
import socket
import stat
import threading
import time
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote, urlsplit, urlencode


COOKIE = "mini_planet_owner"
MAX_BODY = 4096
MAX_RESPONSE = 2 * 1024 * 1024
MAX_STATIC = 32 * 1024 * 1024
PUBLIC_ENTRIES = frozenset({
    "index.html", "src", "assets", "vendor", "config", "agent-status.json",
    "agent-results.json", "manifest.json", "robots.txt", "sitemap.xml", "sw.js",
    "favicon.ico", "LICENSE",
})
PROFILES = frozenset({"default", "rodi", "jarvis"})


def reject_json_constant(value):
    raise ValueError("non-finite JSON value")


def is_controller_failure(data):
    """Only the documented data:null failure envelope may preserve HTTP 503."""
    fields = {"source", "status", "observed_at", "last_success_at", "expires_at",
              "stale", "error", "data"}
    if not isinstance(data, dict) or set(data) != fields:
        return False
    if (data["source"] != "dashboard" or data["status"] != "error"
            or data["stale"] is not True or data["data"] is not None
            or data["last_success_at"] is not None or data["expires_at"] is not None
            or not isinstance(data["error"], str) or not 0 < len(data["error"]) <= 4096
            or not isinstance(data["observed_at"], str)):
        return False
    try:
        observed = datetime.fromisoformat(data["observed_at"].replace("Z", "+00:00"))
        return observed.tzinfo is not None and observed.utcoffset() is not None
    except ValueError:
        return False


def read_secret(filename, root):
    """Accept owner-only regular files outside the public build; never log values."""
    path = Path(filename).absolute()
    if path.resolve().is_relative_to(root):
        raise ValueError("secret files must be outside the static root")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("secret files must be regular, owned by this user, and mode 600 or 400")
        raw = os.read(fd, MAX_BODY + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_BODY:
        raise ValueError("secret file is too large")
    value = raw.decode("utf-8").rstrip("\r\n")
    if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("secret must contain one nonempty line")
    return value


def controller_address(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
            or not parsed.port):
        raise ValueError("--controller-url must be http://127.0.0.1:<explicit-port>")
    return parsed.port


def public_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
            or parsed.netloc != parsed.netloc.lower()):
        raise ValueError("--public-origin must be one exact HTTPS origin, without a trailing slash")
    _ = parsed.port  # validate the port
    return value


class HeaderReader:
    """Bound the standard library header parser without changing body reads."""
    def __init__(self, stream):
        self.stream, self.total = stream, 0

    def readline(self, size=-1):
        line = self.stream.readline(min(size if size >= 0 else 8193, 8193))
        self.total += len(line)
        if len(line) > 8192 or self.total > 32768:
            raise http.client.LineTooLong("request headers")
        return line


class OwnerServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, *, root, controller_url, controller_key_file,
                 password_file, origin=None, session_ttl=8 * 60 * 60,
                 upstream_timeout=5, max_clients=16):
        if address[0] != "127.0.0.1":
            raise ValueError("owner server must bind to 127.0.0.1; use an HTTPS reverse proxy remotely")
        root_path = Path(root).absolute()
        if root_path.is_symlink():
            raise ValueError("static root cannot be a symlink")
        self.root = root_path.resolve(strict=True)
        if not self.root.is_dir() or not (self.root / "index.html").is_file():
            raise ValueError("--root must be a built static site containing index.html")
        if any(p.name not in PUBLIC_ENTRIES for p in self.root.iterdir()):
            raise ValueError("--root contains non-public entries; use the build-site output, not the repository")
        self.controller_port = controller_address(controller_url)
        self.controller_key = read_secret(controller_key_file, self.root)
        self.password = read_secret(password_file, self.root)
        if hmac.compare_digest(self.controller_key.encode(), self.password.encode()):
            raise ValueError("owner password must be separate from the controller key")
        self.origin = public_origin(origin) if origin else None
        self.session_ttl = session_ttl
        self.upstream_timeout = upstream_timeout
        self.sessions = {}
        self.failed_logins = []
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(max_clients)
        self.root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            super().__init__(address, OwnerHandler)
        except Exception:
            os.close(self.root_fd)
            raise

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(5)
        return request, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nConnection: close\r\n"
                                b"Cache-Control: no-store\r\nContent-Length: 0\r\n\r\n")
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        deadline = threading.Timer(10, self.close_socket, (request,))
        deadline.daemon = True
        deadline.start()
        try:
            super().process_request_thread(request, client_address)
        finally:
            deadline.cancel()
            self.slots.release()

    @staticmethod
    def close_socket(sock):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def server_close(self):
        super().server_close()
        os.close(self.root_fd)

    def handle_error(self, request, client_address):
        # Do not dump request context, upstream payloads, or credentials to logs.
        pass

    def session(self, token):
        if not token:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self.lock:
            now = time.time()
            self.sessions = {k: v for k, v in self.sessions.items() if v > now}
            return self.sessions.get(digest)

    def invalidate(self, token):
        if token:
            with self.lock:
                self.sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)

    def login(self, password, old_token):
        with self.lock:
            now = time.time()
            self.failed_logins = [t for t in self.failed_logins if t > now - 60]
            if len(self.failed_logins) >= 5:
                return 429, None, None
            if not hmac.compare_digest(password.encode(), self.password.encode()):
                self.failed_logins.append(now)
                return 401, None, None
            self.failed_logins.clear()
            self.sessions = {k: v for k, v in self.sessions.items() if v > now}
            if old_token:
                self.sessions.pop(hashlib.sha256(old_token.encode()).hexdigest(), None)
            if len(self.sessions) >= 128:
                return 503, None, None
            token = secrets.token_urlsafe(32)
            expires = now + self.session_ttl
            self.sessions[hashlib.sha256(token.encode()).hexdigest()] = expires
            return 200, token, expires


class OwnerHandler(BaseHTTPRequestHandler):
    server_version = "MiniPlanetOwner"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    def log_message(self, format, *args):
        pass

    def parse_request(self):
        original = self.rfile
        self.rfile = HeaderReader(original)
        try:
            return super().parse_request()
        finally:
            self.rfile = original

    def send_error(self, code, message=None, explain=None):
        self.send_json(code, {"error": "request_rejected"})

    def send_bytes(self, status, body, content_type, *, cookie=None, head=False, extra=None):
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Connection", "close")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if not head and getattr(self, "command", None) != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, data, **kwargs):
        self.send_bytes(status, json.dumps(data, ensure_ascii=False).encode(),
                        "application/json; charset=utf-8", **kwargs)

    def boundary(self):
        if len(self.path) > 4096:
            self.send_json(414, {"error": "request_too_large"})
            return False
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1:
            self.send_json(403, {"error": "invalid_host"})
            return False
        if self.server.origin:
            allowed = {urlsplit(self.server.origin).netloc: self.server.origin}
        else:
            port = self.server.server_port
            allowed = {f"127.0.0.1:{port}": f"http://127.0.0.1:{port}",
                       f"localhost:{port}": f"http://localhost:{port}"}
        expected = allowed.get(hosts[0])
        origins = self.headers.get_all("Origin", [])
        if (expected is None or len(origins) > 1 or (origins and origins[0] != expected)
                or self.headers.get("Sec-Fetch-Site", "none") not in ("same-origin", "none")):
            self.send_json(403, {"error": "origin_rejected"})
            return False
        if self.command in ("POST", "DELETE") and origins != [expected]:
            self.send_json(403, {"error": "origin_required"})
            return False
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get_all("Transfer-Encoding") or len(lengths) > 1:
            self.send_json(400, {"error": "invalid_body"})
            return False
        if lengths and (not lengths[0].isdigit() or len(lengths[0]) > 6):
            self.send_json(400, {"error": "invalid_body"})
            return False
        self.body_length = int(lengths[0]) if lengths else 0
        if self.body_length > MAX_BODY:
            self.send_json(413, {"error": "request_too_large"})
            return False
        if self.command != "POST" and self.body_length:
            self.send_json(400, {"error": "unexpected_body"})
            return False
        return True

    def token(self):
        raw = self.headers.get_all("Cookie", [])
        if len(raw) > 1 or not raw or len(raw[0]) > 4096:
            return None
        if sum(part.strip().startswith(COOKIE + "=") for part in raw[0].split(";")) != 1:
            return None
        try:
            cookies = SimpleCookie()
            cookies.load(raw[0])
            value = cookies[COOKIE].value if COOKIE in cookies else None
            return value if value and len(value) <= 100 and value.isascii() else None
        except CookieError:
            return None

    def cookie(self, token, max_age):
        value = f"{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Strict"
        return value + ("; Secure" if self.server.origin else "")

    def authenticated(self):
        expires = self.server.session(self.token())
        if expires is None:
            self.send_json(401, {"authenticated": False, "error": "authentication_required"})
        return expires

    @staticmethod
    def session_json(expires):
        return {"authenticated": True,
                "expiresAt": datetime.fromtimestamp(expires, timezone.utc).isoformat()}

    def do_GET(self):
        if not self.boundary():
            return
        if self.path == "/owner/session":
            expires = self.authenticated()
            if expires is not None:
                self.send_json(200, self.session_json(expires))
        elif self.path.startswith("/api/"):
            if self.authenticated() is not None:
                self.proxy()
        elif self.path.startswith("/owner/"):
            self.send_json(404, {"error": "not_found"})
        else:
            self.static()

    def do_POST(self):
        if not self.boundary():
            return
        if self.path != "/owner/session":
            self.send_json(405, {"error": "method_not_allowed"})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "json_required"})
            return
        try:
            raw = self.rfile.read(self.body_length)
            if len(raw) != self.body_length:
                raise ValueError()
            body = json.loads(raw)
            if not isinstance(body, dict) or set(body) != {"password"} or not isinstance(body["password"], str):
                raise ValueError()
        except (ValueError, UnicodeError, TimeoutError):
            self.send_json(400, {"error": "invalid_body"})
            return
        try:
            status, token, expires = self.server.login(body["password"], self.token())
        except UnicodeError:
            self.send_json(400, {"error": "invalid_body"})
            return
        if status == 200:
            self.send_json(200, self.session_json(expires),
                           cookie=self.cookie(token, int(self.server.session_ttl)))
        else:
            error = {401: "invalid_password", 429: "login_throttled", 503: "session_limit"}[status]
            self.send_json(status, {"authenticated": False, "error": error},
                           extra={"Retry-After": "60"} if status == 429 else None)

    def do_DELETE(self):
        if not self.boundary():
            return
        if self.path != "/owner/session":
            self.send_json(405, {"error": "method_not_allowed"})
            return
        self.server.invalidate(self.token())
        self.send_json(200, {"authenticated": False}, cookie=self.cookie("", 0))

    def do_HEAD(self):
        if not self.boundary():
            return
        if self.path.startswith(("/api/", "/owner/")):
            self.send_json(405, {"error": "method_not_allowed"})
        else:
            self.static(head=True)

    def reject_method(self):
        if self.boundary():
            self.send_json(405, {"error": "method_not_allowed"})

    do_PUT = do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = reject_method

    def proxy(self):
        parsed = urlsplit(self.path)
        routes = {"/api/v1/status", "/api/v1/board", "/api/v1/results/rodi"}
        path = parsed.path
        if parsed.fragment or parsed.scheme or parsed.netloc:
            path = ""
        if path == "/api/v1/jobs":
            try:
                query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=4)
            except ValueError:
                self.send_json(400, {"error": "invalid_query"})
                return
            if set(query) != {"profile"} or len(query["profile"]) != 1 or query["profile"][0] not in PROFILES:
                self.send_json(400, {"error": "invalid_query"})
                return
            target = path + "?" + urlencode({"profile": query["profile"][0]})
        elif path in routes and not parsed.query:
            target = path
        else:
            self.send_json(404, {"error": "route_not_allowed"})
            return
        conn = http.client.HTTPConnection("127.0.0.1", self.server.controller_port,
                                          timeout=self.server.upstream_timeout)
        deadline = None
        try:
            conn.connect()
            deadline = threading.Timer(self.server.upstream_timeout, self.server.close_socket, (conn.sock,))
            deadline.daemon = True
            deadline.start()
            conn.request("GET", target, headers={"Authorization": "Bearer " + self.server.controller_key,
                                                 "Accept": "application/json"})
            response = conn.getresponse()
            if response.status not in (200, 503):
                raise ValueError("upstream status")
            if response.getheader("Content-Type", "").split(";", 1)[0].strip() != "application/json":
                raise ValueError("upstream content type")
            if response.getheader("Content-Encoding", "identity") != "identity":
                raise ValueError("upstream encoding")
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise ValueError("upstream response too large")
            data = json.loads(raw, parse_constant=reject_json_constant)
            if response.status == 503 and (path == "/api/v1/status" or not is_controller_failure(data)):
                raise ValueError("unexpected failure envelope")
            encoded = json.dumps(data, ensure_ascii=False).encode()
            if len(encoded) > MAX_RESPONSE or any(s.encode() in encoded for s in (self.server.controller_key, self.server.password)):
                raise ValueError("unsafe upstream response")
            self.send_bytes(response.status, encoded, "application/json; charset=utf-8")
        except (OSError, ValueError, UnicodeError, http.client.HTTPException, RecursionError):
            self.send_json(502, {"error": "controller_unavailable"})
        finally:
            if deadline:
                deadline.cancel()
            conn.close()

    def static(self, head=False):
        try:
            parsed = urlsplit(self.path)
            decoded = unquote(parsed.path, errors="strict")
        except (ValueError, UnicodeError):
            self.send_json(400, {"error": "invalid_path"})
            return
        parts = decoded.lstrip("/").split("/") if decoded != "/" else ["index.html"]
        if (parsed.scheme or parsed.netloc or parsed.fragment or not decoded.startswith("/")
                or "\\" in decoded or "%" in decoded or any(ord(c) < 32 for c in decoded)
                or any(not p or p.startswith(".") or p == "services.local.json" for p in parts)
                or parts[0] not in PUBLIC_ENTRIES):
            self.send_json(404, {"error": "not_found"})
            return
        fd = os.dup(self.server.root_fd)
        try:
            for i, part in enumerate(parts):
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if i < len(parts) - 1:
                    flags |= os.O_DIRECTORY
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_STATIC:
                raise OSError()
            with os.fdopen(fd, "rb") as stream:
                fd = None
                body = stream.read(MAX_STATIC + 1)
            if len(body) > MAX_STATIC:
                raise OSError()
        except OSError:
            self.send_json(404, {"error": "not_found"})
            return
        finally:
            if fd is not None:
                os.close(fd)
        content_type = mimetypes.guess_type(parts[-1])[0] or "application/octet-stream"
        self.send_bytes(200, body, content_type, head=head)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, help="explicit build-site output directory")
    parser.add_argument("--controller-url", required=True, help="http://127.0.0.1:<controller-port>")
    parser.add_argument("--controller-key-file", required=True)
    parser.add_argument("--password-file", required=True)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--public-origin", help="exact HTTPS origin when behind a reverse proxy")
    args = parser.parse_args()
    try:
        server = OwnerServer((args.bind, args.port), root=args.root,
                             controller_url=args.controller_url,
                             controller_key_file=args.controller_key_file,
                             password_file=args.password_file, origin=args.public_origin)
    except (OSError, ValueError, UnicodeError):
        parser.exit(2, "Invalid configuration: check build root, loopback controller URL, and private secret files.\n")
    origin = args.public_origin or f"http://127.0.0.1:{server.server_port}"
    print(f"Mini Planet owner UI: {origin}/?owner=1", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
