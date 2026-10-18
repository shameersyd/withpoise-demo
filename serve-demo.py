#!/usr/bin/env python3
"""
HTTPS server for the withpoise demo.

Same job as serve.py — a secure origin, because browsers will not open a camera
without one — plus the one thing the demo needs that the original app did not:
**HTTP Range requests**.

A 21-minute video is useless without them. Without Range a browser cannot seek:
it must fetch from the beginning every time, so scrubbing stalls and the
offline tracer that steps through the video frame by frame never finishes.
http.server has never supported Range, which is why this exists.

Usage:
    python3 serve-demo.py
"""
import errno
import functools
import json
import http.server
import os
import re
import shutil
import socket
import time
import ssl
import subprocess
import sys

PORT = 8444
PORT_ATTEMPTS = 12
IDLE_TIMEOUT_SECONDS = 30

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, "withpoise-demo")
CERT_FILE = os.path.join(HERE, ".self_signed_cert.pem")
KEY_FILE = os.path.join(HERE, ".self_signed_key.pem")
CERT_MARGIN_SECONDS = 24 * 60 * 60

RANGE = re.compile(r"bytes=(\d*)-(\d*)")


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "localhost"


def cert_still_valid(openssl):
    if not (os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE)):
        return False
    if openssl is None:
        return True
    return subprocess.run(
        [openssl, "x509", "-in", CERT_FILE, "-noout", "-checkend", str(CERT_MARGIN_SECONDS)],
        capture_output=True).returncode == 0


def generate_cert():
    openssl = shutil.which("openssl")
    if cert_still_valid(openssl):
        return
    if openssl is None:
        sys.exit(
            "\n  Can't find `openssl`, and it is needed to make the HTTPS\n"
            "  certificate this server runs on. Browsers will not open a camera\n"
            "  on a plain http:// address, so the certificate is not optional.\n")
    print("🔐 Generating a self-signed SSL certificate...")
    try:
        subprocess.run(
            [openssl, "req", "-x509", "-newkey", "rsa:2048", "-keyout", KEY_FILE,
             "-out", CERT_FILE, "-days", "365", "-nodes", "-subj", "/CN=withpoise"],
            check=True, capture_output=True)
    except subprocess.CalledProcessError as err:
        sys.exit(f"\n  openssl could not generate a certificate:\n\n"
                 f"{(err.stderr or b'').decode(errors='replace').strip()}\n")
    print("✅ Certificate generated.")


# Where ?record=1 sessions are written. One file per run, so a session is never
# silently appended to the one before it.
RECORDINGS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the demo, and accepts a recorded session at /__record."""

    def do_POST(self):
        if self.path != "/__record":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            os.makedirs(RECORDINGS, exist_ok=True)
            name = getattr(self.server, "recording_name", None)
            if not name:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                name = f"{payload.get('exercise', 'session')}-{stamp}.jsonl"
                self.server.recording_name = name
            path = os.path.join(RECORDINGS, name)
            with open(path, "a") as fh:
                for row in payload.get("rows", []):
                    fh.write(json.dumps(row, separators=(",", ":")) + "\n")
            rows = len(payload.get("rows", []))
            print(f"  recorded {rows} frames → recordings/{name}", flush=True)
            self.send_response(204)
            self.end_headers()
        except Exception as exc:          # a failed upload must not kill the class
            print(f"  recording failed: {exc}", flush=True)
            self.send_response(500)
            self.end_headers()

    """
    SimpleHTTPRequestHandler, plus Range, plus no caching.

    Range is what makes a 21-minute video usable: it is how a browser asks for
    "the three seconds around 7:14" instead of the whole 318 MB. Without it
    `video.currentTime = t` has to re-download from zero.
    """

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def send_head(self):
        requested = self.headers.get("Range")
        if not requested:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        match = RANGE.fullmatch(requested.strip())
        if not match:
            f.close()
            self.send_error(400, "Malformed Range header")
            return None

        start_text, end_text = match.groups()
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
        else:
            # "bytes=-500" means the last 500 bytes.
            if not end_text:
                f.close()
                self.send_error(400, "Malformed Range header")
                return None
            start = max(0, size - int(end_text))
            end = size - 1

        if start >= size:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        end = min(end, size - 1)
        f.seek(start)

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        return _Window(f, end - start + 1)

    def copyfile(self, source, outputfile):
        # A client that seeks away mid-stream hangs up on us. That is a browser
        # behaving correctly, not an error worth a traceback.
        try:
            shutil.copyfileobj(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, fmt, *args):
        # One line per media chunk is thousands of lines per minute of video.
        if "/media/" in self.path and "206" in (fmt % args):
            return
        super().log_message(fmt, *args)


class _Window:
    """A read-only window onto part of a file, for serving one Range."""

    def __init__(self, handle, length):
        self.handle = handle
        self.remaining = length

    def read(self, size=-1):
        if self.remaining <= 0:
            return b""
        if size < 0 or size > self.remaining:
            size = self.remaining
        chunk = self.handle.read(size)
        self.remaining -= len(chunk)
        return chunk

    def close(self):
        self.handle.close()


class TLSServer(http.server.ThreadingHTTPServer):
    """Threaded, with the TLS handshake off the accept loop. See serve.py."""

    daemon_threads = True

    def __init__(self, address, handler, context):
        self.tls_context = context
        super().__init__(address, handler)

    def get_request(self):
        sock, addr = self.socket.accept()
        sock.settimeout(IDLE_TIMEOUT_SECONDS)
        return self.tls_context.wrap_socket(
            sock, server_side=True, do_handshake_on_connect=False), addr

    def finish_request(self, request, client_address):
        try:
            request.do_handshake()
        except (ssl.SSLError, OSError):
            return
        super().finish_request(request, client_address)

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, (ssl.SSLError, ConnectionError, socket.timeout, TimeoutError)):
            return
        super().handle_error(request, client_address)


def bind(handler, context):
    for port in range(PORT, PORT + PORT_ATTEMPTS):
        try:
            return TLSServer(("0.0.0.0", port), handler, context), port
        except OSError as err:
            if err.errno in (errno.EADDRINUSE, errno.EACCES):
                print(f"  Port {port} is taken, trying {port + 1}...")
                continue
            sys.exit(f"\n  Could not open port {port}: {err}\n")
    sys.exit(f"\n  Ports {PORT} to {PORT + PORT_ATTEMPTS - 1} are all in use.\n"
             f"      pkill -f serve-demo.py\n")


def main():
    if not os.path.exists(os.path.join(DIR, "media", "instructor.mp4")):
        print("⚠️  withpoise-demo/media/instructor.mp4 is missing — see the README.\n")

    generate_cert()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        context.load_cert_chain(CERT_FILE, KEY_FILE)
    except ssl.SSLError as err:
        sys.exit(f"\n  The certificate and key do not load: {err}\n"
                 f"      rm {CERT_FILE} {KEY_FILE}\n")

    server, port = bind(functools.partial(RangeHandler, directory=DIR), context)
    ip = get_local_ip()

    print()
    print("=" * 56)
    print("  🧘 withpoise demo — HTTPS Server Running")
    print("=" * 56)
    print()
    print("  📱 On your phone:")
    print(f"     https://{ip}:{port}")
    print()
    print("  💻 On this Mac:")
    print(f"     https://localhost:{port}")
    print()
    print("  ⚠️  Accept the self-signed certificate warning.")
    print("  Press Ctrl+C to stop.")
    print("=" * 56)
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Server stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
