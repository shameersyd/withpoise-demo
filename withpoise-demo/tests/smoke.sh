#!/bin/sh
# Browser smoke test for the follow-along demo: does the class actually start?
#
# See the comment at the top of smoke.html for why this exists and what it can
# and cannot prove. Downloads ~9 MB on a cold cache and needs a network.
set -e
cd "$(dirname "$0")/../.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=8898
DEBUG_PORT=9398
LOG=$(mktemp)
PROFILE=$(mktemp -d)

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at $CHROME — this test needs a real browser engine." >&2
  exit 127
fi
if [ ! -f withpoise-demo/media/instructor.json ]; then
  echo "No instructor trace — run tools/trace-instructor.py first." >&2
  exit 1
fi
if [ ! -f withpoise-demo/media/instructor-transcript.json ]; then
  # Not fatal: the app falls back to judging from the body alone.
  echo "  (no transcript — the class will be judged from the body alone)"
fi

python3 -m http.server "$PORT" > "$LOG" 2>&1 &
SERVER=$!
cleanup() {
  pkill -f "remote-debugging-port=$DEBUG_PORT" 2>/dev/null || true
  kill "$SERVER" 2>/dev/null || true
  sleep 1
  rm -rf "$PROFILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
sleep 1

# A fake camera, so this needs no hardware and no person; software GL, so it
# runs the same on a machine with no usable GPU. Remote debugging is only here
# to stop headless Chrome exiting the moment the page loads.
"$CHROME" --headless=new \
  --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --remote-debugging-port="$DEBUG_PORT" --user-data-dir="$PROFILE" \
  "http://localhost:$PORT/withpoise-demo/tests/smoke.html" > /dev/null 2>&1 &

echo "  starting the class in a browser (downloads ~9 MB on a cold cache)…"
for _ in $(seq 1 90); do
  if grep -q '__smoke?' "$LOG" 2>/dev/null; then break; fi
  sleep 1
done

RESULT=$(grep -o '__smoke?[^ ]*' "$LOG" | head -1 || true)
if [ -z "$RESULT" ]; then
  echo "  ✗ the page never reported back — Chrome or the network is unhappy" >&2
  exit 1
fi

set +e
echo "$RESULT" | python3 -c '
import sys, urllib.parse
raw = urllib.parse.unquote(sys.stdin.read().split("?", 1)[1])
verdict, failures, log = (raw.split("||") + ["", ""])[:3]
print("  verdict:", verdict)
if log:
    for line in log.split(" | "):
        print("    ", line)
if failures:
    print("  problems:")
    for f in failures.split(" ;; "):
        print("    ✗", f)
sys.exit(0 if verdict == "ok" else 1)
'
