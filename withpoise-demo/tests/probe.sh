#!/bin/sh
# What is the app deciding, and why?
#
# Runs the real index.html in a browser, jumps the video to a chosen point in
# the class, and prints the decision state every few seconds: whether the class
# has started, what the instructor is asking for, whether the app is judging,
# whether it can see the student, and what it last said.
#
# This exists because neither of the other two suites could see the bugs it
# found. tests/run.sh exercises the comparison logic and never runs the app's
# frame loop; smoke.sh runs the frame loop but only asks whether inference
# happens. Both were green through two rounds in which the app sat inert and
# silent for a student standing out of frame.
#
# The fake camera has nobody in it, which is exactly the case worth probing:
# the app's behaviour towards a student it cannot see.
#
#   tests/probe.sh                       # 50s in, nobody in front of the camera
#   tests/probe.sh 3                     # during the instructor's introduction
#   tests/probe.sh 80 probe-body still   # a student standing still, mid-exercise
#   tests/probe.sh 80 probe-body follow  # a student following properly
#   tests/probe.sh 80 probe-body correct-later   # stops, then starts following
#   tests/probe.sh 80 probe-body short-arms      # jumping jacks, hands only to the shoulders
#   tests/probe.sh 80 probe-body short-arms-fix  # …who then reaches all the way up
#   tests/probe.sh 80 probe-body narrow-feet-fix # the same for feet that barely open
#   tests/probe.sh 74 probe-body replay-session-short-arms  # a recorded session, fed back row by row
set -e
cd "$(dirname "$0")/../.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SEEK="${1:-50}"
PAGE="${2:-probe}"
MODE="${3:-still}"
PORT=8893
DEBUG_PORT=9393
LOG=$(mktemp)
PROFILE=$(mktemp -d)

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at $CHROME — this needs a real browser engine." >&2
  exit 127
fi

# Snapshots the probe takes of the screen land here (or in $SNAPSHOTS).
SNAPSHOTS="${SNAPSHOTS:-$(mktemp -d)}"
python3 withpoise-demo/tests/range-server.py "$PORT" "$SNAPSHOTS" > "$LOG" 2>&1 &
SERVER=$!
cleanup() {
  pkill -f "remote-debugging-port=$DEBUG_PORT" 2>/dev/null || true
  kill "$SERVER" 2>/dev/null || true
  sleep 1
  rm -rf "$PROFILE" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
sleep 1

"$CHROME" --headless=new \
  --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --remote-debugging-port="$DEBUG_PORT" --user-data-dir="$PROFILE" \
  "http://localhost:$PORT/withpoise-demo/tests/$PAGE.html?seek=$SEEK&mode=$MODE" > /dev/null 2>&1 &

echo "  probing the class at ${SEEK}s (downloads ~9 MB on a cold cache)…"
for _ in $(seq 1 90); do
  grep -q 'END' "$LOG" 2>/dev/null && break
  sleep 1
done

if ! grep -q '__probe?' "$LOG" 2>/dev/null; then
  echo "  ✗ the page never reported back" >&2
  exit 1
fi
grep -o '__probe?[^ ]*' "$LOG" | python3 -c '
import sys, urllib.parse
for raw in sys.stdin:
    text = urllib.parse.unquote(raw.strip().split("?", 1)[1])
    for line in text.split(" || "):
        print("  " + line)
'
echo "  snapshots in $SNAPSHOTS"
