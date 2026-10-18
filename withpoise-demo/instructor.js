/**
 * The instructor's pose, as a function of video time.
 *
 * The demo plays a fixed recording, so the instructor's pose at 7:14 is the
 * same every time anyone watches it. It is detected once, offline, by
 * tools/trace-instructor.py and loaded here as a timeline — which leaves the
 * whole of a phone's inference budget for the user, who is the half that
 * actually changes.
 *
 * The seam matters more than the saving. Everything downstream asks this module
 * "what is the instructor doing right now", and a live class would answer the
 * same question from a second detector without anything else changing.
 */

import { LM, v3, bodyFrame, segmentDirections, SEGMENT_NAMES } from "./pose-core.js";

// ─────────────────────────────────────────────────────────────
// When the class actually starts
// ─────────────────────────────────────────────────────────────

/**
 * Instructors talk first. They greet the room, say what the class will cover,
 * maybe tell a story, and only then begin — and until they begin there is
 * nothing for the user to follow and no business correcting them.
 *
 * Two conditions, both measured off the trace, both about the *instructor*
 * rather than about the user:
 *
 *   a usable reference   every scored landmark confident and inside the frame.
 *                        Not a heuristic: with the instructor's legs out of
 *                        shot there is no reference to compare a user's legs
 *                        against, so there is nothing to say. This alone covers
 *                        the talking-head opening that most classes have — the
 *                        first thirteen seconds of the demo video are framed on
 *                        the instructor's upper body and their ankles score 0.00
 *                        visibility throughout.
 *
 *   actually moving      the shape is changing, sustained. Standing full-body in
 *                        frame and talking passes the first condition, and this
 *                        is what separates it from practice. Measured over the
 *                        demo class: standing and talking runs at 0.24–0.36,
 *                        and practice at 0.8–1.4. The gap is wide and the
 *                        threshold sits in it.
 *
 * Movement is the trigger and not a continuing requirement — a held pose is
 * motionless and is exactly when coaching matters most, so once the class has
 * started it stays started.
 *
 * A trace may override all of this with an explicit `startsAt`, because tracing
 * is a once-per-video offline step with a human present, and a human who has
 * watched the video knows better than this does.
 */
const START_SPEED = 0.55;          // between 0.36 and 0.8, measured above
const START_SUSTAIN_SECONDS = 2;   // not one lucky sample
const START_LANDMARKS = [
  "left_shoulder", "right_shoulder", "left_hip", "right_hip",
  "left_knee", "right_knee", "left_ankle", "right_ankle",
];

/**
 * How far the instructor's shape travels over the preceding window, in degrees.
 *
 * Path length, not displacement, and the difference is the whole point. A
 * repetition returns to where it started, so "how different is the shape now
 * from the shape a second ago" reads near zero at the end of every jumping jack
 * — the same answer it gives for somebody who never moved. Summing the
 * frame-to-frame changes instead measures how much work was done, which is what
 * separates them.
 *
 * Precomputed, like everything else about the instructor: it is the same on
 * every run and nobody should pay for it thirty times a second.
 */
export const MOTION_WINDOW_SECONDS = 1.2;

function pathLengths(frames, directions) {
  const out = new Array(frames.length).fill(0);
  let from = 0;
  let running = 0;
  const step = [];
  for (let i = 1; i < frames.length; i++) {
    step[i] = shapeDistance(directions[i], directions[i - 1]) || 0;
    running += step[i];
    while (from < i && frames[i].t - frames[from].t > MOTION_WINDOW_SECONDS) {
      from++;
      running -= step[from] || 0;
    }
    out[i] = frames[i].t - frames[from].t >= MOTION_WINDOW_SECONDS * 0.7 ? running : 0;
  }
  return out;
}

/** Is this frame something a user could be compared against at all? */
export function usableReference(frame) {
  if (!frame || !frame.detected || !frame.image || !frame.world) return false;
  return START_LANDMARKS.every((name) => {
    const p = frame.image[LM[name]];
    return p && (p.visibility ?? 1) > 0.5
      && p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98;
  });
}

/** Every frame's segment directions, computed once. */
function allDirections(frames) {
  return frames.map(f => f.world ? segmentDirections(f.world, bodyFrame(f.world)) : null);
}

/** Mean angle between two shapes, in degrees. */
function shapeDistance(a, b) {
  if (!a || !b) return NaN;
  let total = 0, counted = 0;
  for (const name of SEGMENT_NAMES) {
    if (!a[name] || !b[name]) continue;
    total += Math.acos(Math.max(-1, Math.min(1, v3.dot(a[name], b[name])))) * 180 / Math.PI;
    counted++;
  }
  return counted ? total / counted : NaN;
}

/** How fast the instructor's shape is changing, per second, at frame `i`. */
function shapeSpeed(frames, directions, i) {
  const here = frames[i], before = frames[i - 1];
  const a = directions[i], b = directions[i - 1];
  if (!here || !before || !a || !b) return 0;
  const dt = here.t - before.t;
  if (dt <= 0) return 0;
  let total = 0, counted = 0;
  for (const name of SEGMENT_NAMES) {
    if (!a[name] || !b[name]) continue;
    total += v3.len(v3.sub(a[name], b[name]));
    counted++;
  }
  return counted ? total / counted / dt : 0;
}

// ─────────────────────────────────────────────────────────────
// Poses the instructor settled into
// ─────────────────────────────────────────────────────────────

/**
 * A pose the user could be asked to hold, as opposed to a shape the instructor
 * happened to be passing through.
 *
 * This is the part that decides *what the class is currently asking for*, and
 * getting it wrong is what made the app feel robotic. Instructors do not hold a
 * pose and move straight to the next one. They demonstrate it, hold it, then
 * come out of it to explain something — walking, gesturing, talking to camera —
 * while the student stays put. Measured over the demo class, the instructor
 * leaves a pose by 36–76° and returns to within 5–10° of it, a dozen times in
 * the first 450 seconds.
 *
 * The app was comparing against whatever the instructor was doing at that
 * moment, so a student correctly holding the pose was corrected for it: of
 * eight such episodes, three scored badly enough to stop the class and zoom in
 * on somebody doing exactly the right thing.
 *
 * A settled frame is one where the shape has not moved more than
 * SETTLE_DEGREES across the preceding SETTLE_SECONDS. Gesturing, walking and
 * transitions cannot satisfy that, which is the point: an explanatory aside is
 * structurally incapable of becoming the thing a student is held to. 21% of
 * this class's frames are settled, and 75% of it has a settled pose within the
 * last HOLD_MEMORY_SECONDS.
 */
const SETTLE_DEGREES = 14;
const SETTLE_SECONDS = 1.5;

/**
 * How long a settled pose stays the thing the user might be doing.
 *
 * The instructor's asides run 10–20 seconds in this class, and the user is
 * meant to hold throughout. Measured against the eight leave-and-return
 * episodes in the trace, with the user correctly holding the pose:
 *
 *     memory     2s     5s    10s    15s    20s
 *     worst    0.67   0.67   0.67   0.67   0.00     ← severity; 0 is silence
 *
 * At two seconds the app interrupted a student doing exactly the right thing in
 * three of the eight. At twenty it interrupts none of them.
 *
 * The cost of that permissiveness is much lower than it looks, because matching
 * is whole-body: a limb 35° out of place still reads 0.67 at five of seven
 * sampled moments even with twenty-five seconds of memory, since a wrong arm
 * stays wrong against every candidate unless the instructor genuinely had their
 * arm there with the rest of the body in the same place. Being generous about
 * *which pose* costs very little precision about *form within* it.
 *
 * What it does give up: a student still holding a pose the class left twenty
 * seconds ago reads as correct. That is a pacing error rather than a form
 * error, and this app does not claim to teach pacing.
 */
export const HOLD_MEMORY_SECONDS = 20;

/**
 * How far back every frame counts, settled or not — the ordinary following lag,
 * and the poses held too briefly to settle.
 *
 * Longer than the two seconds the raw lag window used, because that was only
 * ever about reaction time, and this is also covering poses the instructor
 * presented without ever going still in them.
 */
export const RECENT_SECONDS = 4;

function detectSettled(frames, directions) {
  const settled = new Array(frames.length).fill(false);
  for (let i = 0; i < frames.length; i++) {
    if (!usableReference(frames[i]) || !directions[i]) continue;
    const since = frames[i].t - SETTLE_SECONDS;
    let steady = true, sawStart = false;
    for (let k = i; k >= 0 && frames[k].t >= since; k--) {
      if (!directions[k] || !(shapeDistance(directions[i], directions[k]) < SETTLE_DEGREES)) {
        steady = false; break;
      }
      if (frames[k].t <= since + 1e-9) sawStart = true;
      if (k === 0) sawStart = true;
    }
    // A frame near the very start of the trace has nothing behind it to be
    // steady against, and must not be taken as a held pose by default.
    settled[i] = steady && (sawStart || frames[i].t - frames[0].t >= SETTLE_SECONDS);
  }
  return settled;
}

/**
 * The first moment the class is worth following, or null if it never is.
 *
 * Returns the time the sustained run *began*, not the time it was confirmed —
 * the user should be followed from the first movement, not from two seconds
 * after it.
 */
/**
 * No class spends longer than this introducing itself.
 *
 * A backstop, and it exists because the alternative failed in the field twice.
 * The class-start gate suppresses feedback during the greeting, so a gate that
 * sticks shut suppresses *everything*, for the whole class, silently: the app
 * reports "waiting for the class" and gives no guidance of any kind, which from
 * the outside is indistinguishable from it being broken.
 *
 * Whatever the detectors say, once the video is a minute in the class has
 * started and the app is responsible for being useful. A minute is longer than
 * any greeting in the demo class (35s) and short enough that nobody is left
 * practising unattended through a whole set.
 */
export const MAX_GREETING_SECONDS = 60;

/**
 * When to start paying attention, from however many detectors have an opinion.
 *
 * The earliest of them, clamped. Earliest rather than most-confident because
 * the costs are not symmetric: starting late leaves a student practising
 * unattended, and starting early costs a few seconds of watching somebody stand
 * still. No opinion at all means start immediately — the gate exists to skip a
 * greeting, and a greeting nobody detected is one there is no reason to wait
 * through.
 */
export function classStartsAt(fromBody, fromWords, cap = MAX_GREETING_SECONDS) {
  const opinions = [fromBody, fromWords].filter((v) => Number.isFinite(v) && v >= 0);
  if (!opinions.length) return 0;
  return Math.min(cap, ...opinions);
}

export function detectClassStart(frames, directions = allDirections(frames)) {
  let runFrom = null;
  for (let i = 1; i < frames.length; i++) {
    const moving = usableReference(frames[i]) && usableReference(frames[i - 1])
      && shapeSpeed(frames, directions, i) >= START_SPEED;
    if (!moving) { runFrom = null; continue; }
    if (runFrom === null) runFrom = frames[i - 1].t;
    if (frames[i].t - runFrom >= START_SUSTAIN_SECONDS) return runFrom;
  }
  return null;
}

/** Rebuild a 33-entry landmark array from the traced thirteen. */
function expand(names, flat, stride, visibilities) {
  const out = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
  names.forEach((name, i) => {
    const at = LM[name];
    if (at === undefined) return;
    out[at] = {
      x: flat[i * stride],
      y: flat[i * stride + 1],
      z: stride === 3 ? flat[i * stride + 2] : 0,
      visibility: visibilities ? visibilities[i] : 1,
    };
  });
  return out;
}

const lerp = (a, b, t) => a + (b - a) * t;

function blend(a, b, t) {
  return a.map((p, i) => ({
    x: lerp(p.x, b[i].x, t),
    y: lerp(p.y, b[i].y, t),
    z: lerp(p.z, b[i].z, t),
    visibility: Math.min(p.visibility, b[i].visibility),
  }));
}

export class InstructorTrack {
  constructor(trace) {
    this.fps = trace.fps;
    this.duration = trace.duration;
    this.names = trace.landmarks;
    this.complete = trace.complete !== false;
    this.from = trace.from || 0;
    this.startsAt = 0;

    // Expanded once, up front. Doing it per lookup would rebuild thirty arrays
    // a second for a body that is only sampled six times a second.
    this.frames = trace.frames.map((frame) => ({
      t: frame.t,
      detected: !!frame.i,
      image: frame.i ? expand(this.names, frame.i, 2, frame.v) : null,
      world: frame.w ? expand(this.names, frame.w, 3, frame.v) : null,
    }));

    // One pass over a few thousand frames, at load, once. The alternative is
    // asking these questions every animation frame for the life of the class.
    const directions = allDirections(this.frames);
    this.startsAt = trace.startsAt != null
      ? trace.startsAt
      : (detectClassStart(this.frames, directions) ?? 0);
    this.settled = detectSettled(this.frames, directions);
    this.travelled = pathLengths(this.frames, directions);
  }

  /** Has the instructor begun practising by video time `t`? */
  hasStarted(t) { return t >= this.startsAt; }

  /** How far the instructor's shape travelled in the window ending at `t`. */
  travelAt(t) {
    const i = this.indexAt(t);
    return i < 0 ? 0 : (this.travelled[i] || 0);
  }

  static async load(url = "media/instructor.json") {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`No instructor trace at ${url} (${response.status}). ` +
                      `Run tools/trace-instructor.py.`);
    }
    return new InstructorTrack(await response.json());
  }

  get seconds() { return this.frames.length ? this.frames[this.frames.length - 1].t : 0; }

  /** Index of the last sample at or before `t`. */
  indexAt(t) {
    if (!this.frames.length) return -1;
    let low = 0, high = this.frames.length - 1;
    if (t <= this.frames[0].t) return 0;
    if (t >= this.frames[high].t) return high;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (this.frames[mid].t <= t) low = mid; else high = mid;
    }
    return low;
  }

  /**
   * The instructor at video time `t`, interpolated between samples.
   *
   * Six samples a second against a thirty-frame display would visibly step, and
   * a reference skeleton that stutters over a smoothly moving body reads as
   * broken rather than as sampled.
   */
  at(t) {
    const i = this.indexAt(t);
    if (i < 0) return null;
    const here = this.frames[i];
    const next = this.frames[i + 1];
    if (!here.detected) return null;
    if (!next || !next.detected) return here;

    const span = next.t - here.t;
    const fraction = span > 0 ? Math.max(0, Math.min(1, (t - here.t) / span)) : 0;
    if (fraction < 1e-3) return here;

    return {
      t,
      detected: true,
      image: blend(here.image, next.image, fraction),
      world: here.world && next.world ? blend(here.world, next.world, fraction) : here.world,
    };
  }

  /**
   * Every sample in a window ending at `t`.
   *
   * Somebody following a video is always behind it — they see a movement, then
   * make it. Scoring only against the instant means scoring reaction time, so
   * the comparison looks back and takes the best match.
   */
  window(t, seconds) {
    const out = [];
    const first = this.indexAt(t - seconds);
    const last = this.indexAt(t);
    for (let i = Math.max(0, first); i <= last; i++) {
      if (this.frames[i].detected) out.push(this.frames[i]);
    }
    return out;
  }

  /**
   * Is this a moment where the class is asking the student to be *somewhere* —
   * has the instructor settled into anything in the recent past?
   *
   * This is a gate, not a reference. False means the instructor is in
   * continuous motion with nothing settled behind them — a flowing sequence —
   * and the caller should say nothing rather than guess, because form cannot
   * meaningfully be corrected against a reference that is itself mid-movement
   * two seconds ago. 75% of this class passes.
   */
  isHolding(t, seconds = HOLD_MEMORY_SECONDS) {
    const first = Math.max(0, this.indexAt(t - seconds));
    const last = this.indexAt(t);
    for (let i = first; i <= last; i++) {
      if (this.settled[i] && this.frames[i].detected) return true;
    }
    return false;
  }

  /**
   * Everything the user could legitimately be doing right now.
   *
   * Two sources, and it needs both:
   *
   *   settled poses, last 20s   what the class has asked the student to hold.
   *                             Survives the instructor stepping out of a pose
   *                             to explain it, which is the whole point.
   *
   *   every frame, last 4s      the ordinary following lag, plus the poses the
   *                             instructor held too briefly or too unsteadily
   *                             to count as settled.
   *
   * The second source is not a hedge. Measured at 224s of the demo class: the
   * student holds the pose from 214s, the instructor steps away and returns to
   * within 8° of it — and the pose itself never qualifies as settled, so the
   * only settled candidates were from 205s, a different shape 24° away. On
   * settled poses alone the app told a student doing exactly the right thing
   * that they were completely wrong, at severity 1.00.
   *
   * Taking every frame from the last twenty seconds instead would also fix
   * that, and was measured doing so, but it dilutes: a student in an entirely
   * different pose from the class scored 0.01 against twenty seconds of
   * arbitrary transitional frames, because somewhere in a hundred and twenty
   * of them is a shape resembling almost anything. Settled poses plus a short
   * recent window keeps the candidate set to things the class actually
   * presented.
   */
  referenceWindow(t, memory, recent = RECENT_SECONDS) {
    if (memory == null) memory = HOLD_MEMORY_SECONDS;
    const out = [];
    const first = Math.max(0, this.indexAt(t - memory));
    const last = this.indexAt(t);
    const recentFrom = t - recent;
    for (let i = first; i <= last; i++) {
      const frame = this.frames[i];
      if (!frame.detected) continue;
      if (this.settled[i] || frame.t >= recentFrom) out.push(frame);
    }
    return out;
  }
}

/** Where the instructor is on screen, in normalised frame coordinates. */
export function instructorAnchor(image) {
  const hip = { x: (image[LM.left_hip].x + image[LM.right_hip].x) / 2,
                y: (image[LM.left_hip].y + image[LM.right_hip].y) / 2 };
  const shoulder = { x: (image[LM.left_shoulder].x + image[LM.right_shoulder].x) / 2,
                     y: (image[LM.left_shoulder].y + image[LM.right_shoulder].y) / 2 };
  return { hip, shoulder, torso: Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y) };
}

/** The box the instructor occupies, for the zoom. */
export function instructorBounds(image, pad = 0.12) {
  const names = Object.keys(LM).filter(n => (image[LM[n]].visibility ?? 1) > 0.3);
  if (!names.length) return null;
  const xs = names.map(n => image[LM[n]].x), ys = names.map(n => image[LM[n]].y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const padX = (x1 - x0) * pad, padY = (y1 - y0) * pad;
  return {
    x: x0 - padX, y: y0 - padY,
    width: (x1 - x0) + 2 * padX, height: (y1 - y0) + 2 * padY,
  };
}
