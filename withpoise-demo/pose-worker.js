/**
 * Pose detection worker.
 *
 * Owns the MediaPipe landmarker and the whole detect loop so WASM inference
 * never runs on the main thread. Knows nothing about yoga: it takes video
 * frames in and posts smoothed landmarks out.
 *
 * Protocol
 *   in   { type: "init",  model: "full" | "heavy" }
 *        { type: "frame", bitmap: ImageBitmap, timestamp: number }   (bitmap transferred)
 *   out  { type: "status", state: "loading" | "ready" | "error", message, model }
 *        { type: "result", timestamp, detected, landmarks[], world[], inference }
 *
 * Each landmark posted back carries `held: true` when its measurement was too
 * low-confidence to trust and the smoothed history was substituted instead.
 */

// ─────────────────────────────────────────────────────────────
// importScripts, for a worker that does not have one
//
// This is a module worker, and module workers have no importScripts(). But
// MediaPipe's wasm loader calls it — the ES bundle is a module, the WebAssembly
// glue it pulls in at runtime is a classic script — so createFromOptions() died
// with "Module scripts don't support importScripts()" and the landmarker never
// came up at all.
//
// Synchronous XHR is the one way to fetch a script synchronously, and unlike on
// the main thread it is entirely legitimate in a worker. Indirect eval puts the
// result in global scope, which is where importScripts would have put it.
// ─────────────────────────────────────────────────────────────
// It is not missing — it is present and throws, so the feature test has to
// call it. With no arguments a working importScripts does nothing at all.
let importScriptsWorks = true;
try { self.importScripts(); } catch { importScriptsWorks = false; }

if (!importScriptsWorks) {
  self.importScripts = (...urls) => {
    for (const url of urls) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send(null);
      if (xhr.status && xhr.status >= 400) {
        throw new Error(`Could not load ${url} (${xhr.status})`);
      }
      (0, eval)(xhr.responseText);
    }
  };
}

import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs";

// The frame logic, the filter math and the visibility threshold all live in
// pose-core.js: shared with the main thread so `held` here and `reliable` there
// can never mean two different things, and testable, which a worker is not.
import { FrameProcessor } from "./pose-core.js";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";

const MODELS = {
  full: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
  heavy: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
};

const frames = new FrameProcessor();

// ─────────────────────────────────────────────────────────────
// Landmarker lifecycle
// ─────────────────────────────────────────────────────────────
let landmarker = null;
let currentModel = null;
let currentDelegate = null;

/**
 * Download the model ourselves rather than handing MediaPipe a URL.
 *
 * It is 13 MB, or 30 for the heavy model, and on a hotel wifi that is a long
 * time watching a spinner that cannot distinguish "slow" from "never". Passing
 * modelAssetPath gives no progress and no way to tell the two apart; reading
 * the body stream ourselves gives both.
 *
 * Goes through the service worker like any other fetch, so a second session
 * completes this from cache in one tick.
 */
async function fetchModel(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (${res.status} ${res.statusText})`);

  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());   // no streams here

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    // Every chunk is several hundred messages over a 13 MB download; nobody
    // can read a progress bar that fast anyway.
    const now = performance.now();
    if (now - lastReport > 100) {
      lastReport = now;
      onProgress(received, total);
    }
  }
  onProgress(received, total || received);

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return bytes;
}

async function createLandmarker(vision, bytes, delegate) {
  return PoseLandmarker.createFromOptions(vision, {
    // A copy per attempt: the buffer may be detached by the attempt that fails,
    // and the GPU attempt failing is the whole reason there is a second one.
    baseOptions: { modelAssetBuffer: new Uint8Array(bytes), delegate },
    runningMode: "VIDEO",
    numPoses: 1,

    // All three default to 0.5 and were being left there. They are set here
    // because the right values follow from what this app does with the output,
    // and that is not the same for every app.
    //
    // Detection is raised: this is the gate on deciding a person is present at
    // all, and a false positive starts a count-in on a coat rack. The app has
    // a framing phase that can afford to wait a moment longer for a real body.
    minPoseDetectionConfidence: 0.6,

    // Presence stays at the default. Whether a pose is present in a frame is a
    // question the app answers better than the landmarker can — it has
    // per-landmark visibility, a coverage measure and a lost-body phase, all
    // of which want the observation rather than a suppressed one.
    minPosePresenceConfidence: 0.5,

    // Tracking is lowered: once a body is found, keeping hold of it matters
    // more than the quality of any single frame. Dropping tracking forces a
    // fresh detection, which costs a frame and restarts the smoothing; a
    // low-confidence frame costs nothing, because low-visibility landmarks are
    // already held rather than believed and the hold timer has its own grace.
    // A held yoga pose is the easiest thing in the world to keep tracking.
    minTrackingConfidence: 0.4,
  });
}

const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

async function init(model) {
  const which = MODELS[model] ? model : "full";
  const loading = (message, progress) =>
    postMessage({ type: "status", state: "loading", model: which, message, progress });

  try {
    loading("Starting the pose runtime…", null);
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);

    loading("Downloading the pose model…", 0);
    const bytes = await fetchModel(MODELS[which], (received, total) => {
      loading(total
        ? `Downloading the pose model — ${mb(received)} of ${mb(total)} MB`
        : `Downloading the pose model — ${mb(received)} MB`,
        total ? received / total : null);
    });

    // GPU first, CPU if the device has no usable WebGL inside a worker. Which
    // one we ended up on is reported, because it is the single biggest factor
    // in how fast this runs and it was previously invisible.
    loading("Starting up on the GPU…", 1);
    try {
      landmarker = await createLandmarker(vision, bytes, "GPU");
      currentDelegate = "GPU";
    } catch (gpuError) {
      loading("No GPU here — starting on the CPU…", 1);
      landmarker = await createLandmarker(vision, bytes, "CPU");
      currentDelegate = "CPU";
    }

    currentModel = which;
    frames.reset();
    postMessage({ type: "status", state: "ready", model: which, delegate: currentDelegate });
  } catch (err) {
    // Everything here is a download or a device capability, so everything here
    // is worth trying again.
    postMessage({ type: "status", state: "error", model: which, retryable: true,
                  message: err && err.message ? err.message : String(err) });
  }
}

// Exactly one `result` goes back for every frame that comes in, on every path
// including failure — the main thread waits for it before sending another.
// FrameProcessor is where that promise is kept, and tested.
function handleFrame(msg) {
  frames.process(msg, {
    landmarker,
    post: (out) => postMessage(out.type === "status" ? { ...out, model: currentModel } : out),
    now: () => performance.now(),
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      init(msg.model);
      break;
    case "frame":
      handleFrame(msg);
      break;
    case "reset":
      frames.reset();
      break;
  }
};
