#!/usr/bin/env python3
"""
Transcribe the instructor, offline and once.

Drives tools/transcribe-instructor.html in headless Chrome, which decodes the
video's audio and runs Whisper over it in WebAssembly, and writes the result to
withpoise-demo/media/instructor-transcript.json.

The same shape as trace-instructor.py and for the same reasons: the work is a
once-per-video step whose output never changes, the browser already has
everything needed to do it, and the file is written incrementally so an
interrupted run leaves something usable behind.

Usage:
    tools/transcribe-instructor.py                 # the whole class
    tools/transcribe-instructor.py --model onnx-community/whisper-small
    tools/transcribe-instructor.py --timeout 2400
"""
import argparse
import http.server
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
SERVE = os.path.join(ROOT, "withpoise-demo")
OUT = os.path.join(SERVE, "media", "instructor-transcript.json")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

state = {"segments": [], "meta": {}, "complete": False, "finished": threading.Event()}


def write_out():
    """Rewritten after every window, so the file is always loadable."""
    segments = sorted(state["segments"], key=lambda s: s["from"])
    # Windows overlap on purpose; the duplicate of a sentence transcribed twice
    # is dropped here rather than in the page, where the next window has not
    # been seen yet.
    deduped = []
    for seg in segments:
        if deduped and abs(seg["from"] - deduped[-1]["from"]) < 0.4 \
                and seg["text"] == deduped[-1]["text"]:
            continue
        deduped.append(seg)
    payload = dict(state["meta"])
    payload["complete"] = state["complete"]
    payload["segments"] = deduped
    tmp = OUT + ".part"
    with open(tmp, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    os.replace(tmp, OUT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=SERVE, **k)

    def log_message(self, *a):
        pass

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _ok(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        try:
            body = self._body()
        except Exception as exc:
            print(f"  bad request on {self.path}: {exc}", flush=True)
            self._ok()
            return

        if self.path == "/__log":
            print(f"  {body.get('message')}", flush=True)
        elif self.path == "/__begin":
            state["meta"] = {k: body.get(k) for k in ("duration", "model", "window", "overlap")}
            write_out()
        elif self.path == "/__segments":
            state["segments"].extend(body.get("segments") or [])
            write_out()
        elif self.path == "/__done":
            state["complete"] = bool(body.get("complete"))
            write_out()
            state["finished"].set()
        self._ok()

    def do_GET(self):
        if self.path.startswith("/__page"):
            data = open(os.path.join(HERE, "transcribe-instructor.html"), "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="onnx-community/whisper-base")
    ap.add_argument("--window", type=float, default=120)
    ap.add_argument("--overlap", type=float, default=3)
    ap.add_argument("--port", type=int, default=8896)
    ap.add_argument("--timeout", type=int, default=2400)
    args = ap.parse_args()

    if not os.path.exists(os.path.join(SERVE, "media", "instructor.mp4")):
        sys.exit("withpoise-demo/media/instructor.mp4 is missing — see the README.")
    if not os.path.exists(CHROME):
        sys.exit(f"Chrome not found at {CHROME}.")

    server = Server(("127.0.0.1", args.port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp()
    url = (f"http://127.0.0.1:{args.port}/__page?model={args.model}"
           f"&window={args.window}&overlap={args.overlap}")
    print(f"  transcribing with {args.model} (downloads the model on a cold cache)")
    chrome = subprocess.Popen([
        CHROME, "--headless=new",
        "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        # Decoding twenty minutes of audio and holding the samples needs more
        # than the default heap.
        "--js-flags=--max-old-space-size=8192",
        "--remote-debugging-port=9396", f"--user-data-dir={profile}", url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        if not state["finished"].wait(timeout=args.timeout):
            print("  timed out — whatever was transcribed has been written", flush=True)
    except KeyboardInterrupt:
        print("\n  stopped — whatever was transcribed has been written", flush=True)
    finally:
        chrome.kill()
        time.sleep(0.5)
        shutil.rmtree(profile, ignore_errors=True)

    if os.path.exists(OUT):
        data = json.load(open(OUT))
        segs = data.get("segments", [])
        spoken = sum(len(s["text"].split()) for s in segs)
        print(f"\n  {len(segs)} segments, {spoken} words, complete: {data.get('complete')}")
        print(f"  → {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
