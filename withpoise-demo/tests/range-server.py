#!/usr/bin/env python3
"""
Range-capable static server, for probe.sh.

`python3 -m http.server` has never implemented Range, which makes an mp4
unseekable — and silently so: a seek is accepted, the element reports the new
time, and then playback resumes from the beginning. The first run of the probe
was written against it and spent a round reporting that the app was stuck at
t=0 when it was the test harness that could not move the video.
"""
import http.server, os, re, socketserver, sys
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith("/__probe"):
            print(self.path, flush=True)
            self.send_response(204); self.end_headers(); return
        path = self.translate_path(self.path)
        rng = self.headers.get("Range")
        if not rng or not os.path.isfile(path): return super().do_GET()
        size = os.path.getsize(path)
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        start = int(m.group(1)) if m.group(1) else 0
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end: start = 0
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as fh:
            fh.seek(start); remaining = end - start + 1
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk: break
                self.wfile.write(chunk); remaining -= len(chunk)
    def do_POST(self):
        # /__snapshot?name=x.png — a picture of what the page drew, for looking
        # at. Written to the directory given as the second argument.
        if self.path.startswith("/__snapshot") and len(sys.argv) > 2:
            import base64, urllib.parse
            name = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("name", ["snap.png"])[0]
            name = os.path.basename(name)
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
            data = base64.b64decode(body.split(",", 1)[1])
            with open(os.path.join(sys.argv[2], name), "wb") as fh: fh.write(data)
            print("/__probe?" + urllib.parse.quote("snapshot " + name), flush=True)
        self.send_response(204); self.end_headers()
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes"); super().end_headers()
class S(socketserver.ThreadingTCPServer): allow_reuse_address = True; daemon_threads = True
S(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
