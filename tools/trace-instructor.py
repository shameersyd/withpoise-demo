#!/usr/bin/env python3
"""
Drive the offline instructor trace.

Serves withpoise-demo/ over plain HTTP with Range support (no camera is needed
here, so no certificate either), points a headless browser at the tracer page,
and writes what comes back to withpoise-demo/media/instructor.json.

    tools/trace-instructor.py                  # the whole video at 6 fps
    tools/trace-instructor.py --fps 4
    tools/trace-instructor.py --from 60 --to 180

Takes roughly as long as the video does. Results are written incrementally, so
an interrupted run leaves a usable partial file rather than nothing.
"""
import argparse
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIR = os.path.join(ROOT, "withpoise-demo")
OUT = os.path.join(DIR, "media", "instructor.json")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 8765
RANGE = re.compile(r"bytes=(\d*)-(\d*)")

state = {"header": None, "frames": [], "done": False, "error": None, "last": time.time()}


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files with Range, plus one POST endpoint for the tracer."""

    def do_POST(self):
        if self.path != "/__trace":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        message = json.loads(self.rfile.read(length) or b"{}")
        state["last"] = time.time()

        kind = message.get("kind")
        if kind == "begin":
            state["header"] = {k: v for k, v in message.items() if k != "kind"}
        elif kind == "frames":
            state["frames"].extend(message["frames"])
            write_out()
        elif kind == "end":
            state["done"] = True
            write_out()
        elif kind == "error":
            state["error"] = message.get("message")
            state["done"] = True

        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        requested = self.headers.get("Range")
        if not requested:
            return super().send_head()
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        try:
            handle = open(path, "rb")
        except OSError:
            self.send_error(404)
            return None
        size = os.fstat(handle.fileno()).st_size
        match = RANGE.fullmatch(requested.strip())
        if not match:
            handle.close()
            self.send_error(400)
            return None
        start_text, end_text = match.groups()
        start = int(start_text) if start_text else max(0, size - int(end_text or 0))
        end = int(end_text) if (start_text and end_text) else size - 1
        end = min(end, size - 1)
        if start >= size:
            handle.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        handle.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        return Window(handle, end - start + 1)

    def copyfile(self, source, outputfile):
        try:
            shutil.copyfileobj(source, outputfile)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


class Window:
    def __init__(self, handle, length):
        self.handle, self.remaining = handle, length

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


def write_out():
    if not state["header"]:
        return
    payload = dict(state["header"])
    payload["frames"] = state["frames"]
    payload["complete"] = state["done"]
    tmp = OUT + ".partial"
    with open(tmp, "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, OUT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fps", type=float, default=6)
    parser.add_argument("--from", dest="start", type=float, default=0)
    parser.add_argument("--to", type=float, default=0)
    parser.add_argument("--timeout", type=float, default=120,
                        help="seconds of silence from the page before giving up")
    args = parser.parse_args()

    if not os.path.exists(os.path.join(DIR, "media", "instructor.mp4")):
        sys.exit("withpoise-demo/media/instructor.mp4 is missing — see the README.")
    if not os.path.exists(CHROME):
        sys.exit(f"Chrome not found at {CHROME}")

    os.chdir(DIR)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    url = (f"http://127.0.0.1:{PORT}/../tools/trace-instructor.html"
           f"?fps={args.fps}&from={args.start}&to={args.to}")
    # Serve the tracer page from inside the served directory instead of
    # climbing out of it, which the handler will not allow.
    page = os.path.join(DIR, "__trace.html")
    shutil.copy(os.path.join(HERE, "trace-instructor.html"), page)
    url = f"http://127.0.0.1:{PORT}/__trace.html?fps={args.fps}&from={args.start}&to={args.to}"

    profile = os.path.join("/tmp", "chrome-trace-profile")
    chrome = subprocess.Popen(
        [CHROME, "--headless=new", "--use-gl=angle", "--use-angle=swiftshader",
         "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required",
         "--remote-debugging-port=9411", f"--user-data-dir={profile}", url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print(f"  tracing {args.fps} fps from {args.start}s "
          f"{'to ' + str(args.to) + 's' if args.to else 'to the end'}…")
    try:
        while not state["done"]:
            time.sleep(2)
            if time.time() - state["last"] > args.timeout:
                print(f"\n  no progress for {args.timeout:.0f}s — giving up", file=sys.stderr)
                break
            if state["frames"]:
                seen = len(state["frames"])
                found = sum(1 for f in state["frames"] if "i" in f)
                print(f"\r  {seen} frames, {found} with a body", end="", flush=True)
    except KeyboardInterrupt:
        print("\n  stopped")
    finally:
        chrome.terminate()
        server.shutdown()
        if os.path.exists(page):
            os.remove(page)

    write_out()
    print()
    if state["error"]:
        sys.exit(f"  the tracer failed: {state['error']}")
    seen = len(state["frames"])
    found = sum(1 for f in state["frames"] if "i" in f)
    size = os.path.getsize(OUT) / 1e6 if os.path.exists(OUT) else 0
    print(f"  wrote {OUT}")
    print(f"  {seen} frames, {found} with a body ({100 * found / max(seen, 1):.0f}%), "
          f"{size:.1f} MB, complete={state['done']}")


if __name__ == "__main__":
    main()
