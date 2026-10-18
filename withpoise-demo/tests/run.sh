#!/bin/sh
# Run the demo's test suite, under Node if it is here and jsc otherwise.
set -e
cd "$(dirname "$0")/../.."
if command -v node > /dev/null 2>&1; then
  node withpoise-demo/tests/run.js
else
  JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
  [ -x "$JSC" ] || { echo "Need node or jsc." >&2; exit 127; }
  "$JSC" -m withpoise-demo/tests/run.js
fi
echo "  These never load MediaPipe, a Worker or a camera. For that, run the app."
echo
