import { readTextFile } from "./platform.js";
import { suite, test, assert, assertEqual } from "./harness.js";
import {
  reliableLandmarks, LM, bodyFrame, segmentDirections, computeAngles,
} from "../pose-core.js";
import {
  framingOf, ESSENTIAL_LANDMARKS, compareToInstructor, PostureMonitor, MirrorLock,
  MotionTracker, movingWithClass, disagreementOf, CRITICAL_SEVERITY, RESOLVE_FRACTION,
  MOTION_RATIO, MOTION_FLOOR_DEGREES, NOT_FOLLOWING_DISAGREEMENT, NOT_FOLLOWING_SUSTAIN_MS,
} from "../follow.js";
import { InstructorTrack } from "../instructor.js";
import { FollowCoach, LINES, MISSING_GRACE_MS } from "../coaching.js";

const track = new InstructorTrack(
  JSON.parse(readTextFile("withpoise-demo/media/instructor.json")));

/**
 * A real practice session, recorded from a real person in front of a real
 * camera.
 *
 * The first fixture in this project that is not synthetic and not the
 * instructor's own body replayed back at itself. Every bug the suites missed
 * came down to that gap: a comparison tuned against a body with the
 * instructor's exact proportions, framing and lens says very little about
 * somebody else's.
 *
 * This is thirty seconds of a student standing a normal distance from a
 * propped-up phone, trying to follow the jumping jacks. The app said nothing to
 * them for the whole of it.
 */
const session = JSON.parse(readTextFile("withpoise-demo/tests/fixtures/session-too-close.json"))
  .map((row) => ({
    ...row,
    // Recorded as flat arrays to keep the file small.
    landmarks: row.landmarks.map(([x, y, z, visibility]) => ({ x, y, z, visibility })),
  }));

suite("a real recorded session");

test("the recording is what it claims to be", () => {
  assert(session.length > 500, `only ${session.length} frames`);
  assert(session.every((f) => f.landmarks.length === 33), "not full landmark sets");
});

test("the student was too close for any of this to work", () => {
  // The finding, pinned so it cannot be mistaken for anything else later. Their
  // head and shoulders are in shot and confidently tracked; everything the
  // comparison needs is below the bottom edge.
  const mid = session[Math.floor(session.length / 2)].landmarks;
  assert(mid[LM.nose].y < 1, "the head should be in frame");
  assert((mid[LM.left_shoulder].visibility ?? 1) > 0.8, "shoulders should be confident");
  assert(mid[LM.left_hip].y > 1, `hips were at y=${mid[LM.left_hip].y.toFixed(2)}, expected off-frame`);

  const everSawHips = session.filter((f) => reliableLandmarks(f.landmarks).has("left_hip")).length;
  assertEqual(everSawHips, 0, `hips were usable in ${everSawHips} frames`);
});

test("badly framed is reported as such, not as fine", () => {
  // What the app got wrong: it treated "detected" as "usable", declined to
  // judge on the quiet, and left the student standing there.
  let cropped = 0;
  for (const frame of session) {
    if (framingOf(reliableLandmarks(frame.landmarks)) === "cropped") cropped++;
  }
  assert(cropped > session.length * 0.95,
    `only ${cropped} of ${session.length} frames were recognised as badly framed`);
});

test("and the student is told, within a few seconds", () => {
  // The whole point. Half a minute of silence is what was reported.
  const coach = new FollowCoach();
  let firstAt = null;
  const started = session[0].at;
  for (const f of session) {
    const said = coach.update({
      state: "ok", faults: [], visible: true,
      framing: framingOf(reliableLandmarks(f.landmarks)),
    }, f.at);
    if (said && said.text === LINES.cropped && firstAt === null) firstAt = f.at - started;
  }
  assert(firstAt !== null, "never told the student anything");
  assert(firstAt <= MISSING_GRACE_MS + 1500,
    `took ${(firstAt / 1000).toFixed(1)}s to say anything`);
});

test("every essential landmark is one the comparison actually needs", () => {
  // A guard against the list drifting into a wishlist. Each of these is load
  // bearing: shoulders and hips build the body frame, knees are most of what a
  // standing exercise moves.
  for (const name of ESSENTIAL_LANDMARKS) {
    assert(name in LM, `${name} is not a landmark`);
  }
  assert(ESSENTIAL_LANDMARKS.includes("left_hip") && ESSENTIAL_LANDMARKS.includes("right_hip"),
    "without hips there is no body frame and nothing is comparable");
});

test("a well-framed body is not told to step back", () => {
  // The other half: the check must not fire on somebody standing correctly.
  // Built from the session's own landmarks by scaling each body to fit the
  // frame — the same person, standing far enough back. Scaled per frame rather
  // than by a fixed factor, because the recorded bodies run from y=0.59 at the
  // nose to y=2.31 at the ankles and one factor does not fit all of them.
  let ok = 0;
  for (const frame of session) {
    const ys = ESSENTIAL_LANDMARKS.concat(["nose"]).map((n) => frame.landmarks[LM[n]].y);
    const top = Math.min(...ys), bottom = Math.max(...ys);
    const scale = 0.85 / Math.max(0.01, bottom - top);
    const framed = frame.landmarks.map((p) => ({
      x: 0.5 + (p.x - 0.5) * scale,
      y: 0.08 + (p.y - top) * scale,
      z: p.z,
      // The landmarker's own confidence is about the pixels it saw, not about
      // this transform; a body genuinely in shot would be reported confidently.
      visibility: Math.max(p.visibility ?? 1, 0.9),
    }));
    if (framingOf(reliableLandmarks(framed)) === "ok") ok++;
  }
  assert(ok > session.length * 0.9,
    `only ${ok} of ${session.length} well-framed bodies passed`);
});

/**
 * The same student again, standing far enough back this time, and standing
 * still through the jumping jacks.
 *
 * Recorded after the framing gate was added, so the body is properly in shot —
 * coverage runs 0.68 to 1.00 against the 0.32 of the session above. What this
 * one caught is everything that was hiding behind the framing problem.
 */
const stillSession = JSON.parse(
  readTextFile("withpoise-demo/tests/fixtures/session-standing-still.json"))
  .map((row) => ({
    ...row,
    landmarks: row.landmarks.map(([x, y, z, visibility]) => ({ x, y, z, visibility })),
    world: row.world.map(([x, y, z]) => ({ x, y, z })),
  }));

const asStudent = (row) => {
  const frame = bodyFrame(row.world);
  return {
    world: row.world, frame,
    directions: segmentDirections(row.world, frame),
    angles: computeAngles(row.world, row.landmarks, 1, 1),
    reliable: reliableLandmarks(row.landmarks),
  };
};

suite("a student standing still through jumping jacks");

test("they were well framed this time", () => {
  const ok = stillSession.filter((r) => framingOf(reliableLandmarks(r.landmarks)) === "ok").length;
  assert(ok > stillSession.length * 0.6,
    `only ${ok} of ${stillSession.length} frames were well framed`);
});

test("posture alone cannot tell them from somebody doing the exercise", () => {
  // Not a tuning failure — a geometric one, and the reason the movement check
  // exists. A jumping jack passes through "arms down, feet together" twice a
  // second, so a motionless body matches the bottom of every repetition.
  const severities = [];
  for (const row of stillSession) {
    if (row.t < 78) continue;
    const window = track.referenceWindow(row.t);
    if (!window.length) continue;
    const match = compareToInstructor(asStudent(row), window, { mirror: true });
    if (match) severities.push(match.severity);
  }
  assert(severities.length > 100, `only ${severities.length} frames to judge`);
  const median = severities.slice().sort((a, b) => a - b)[Math.floor(severities.length / 2)];
  assert(median < CRITICAL_SEVERITY,
    `posture alone rated a motionless student ${median.toFixed(2)}, which would have caught them — ` +
    `if this now passes, the movement check may no longer be needed`);
});

test("movement tells them apart immediately", () => {
  // The measurement the fix is built on: over 1.2 seconds this student travels
  // 1.7–17°, the instructor 132–159°. Fifty to one.
  const tracker = new MotionTracker();
  const ratios = [];
  for (const row of stillSession) {
    const travel = tracker.observe(asStudent(row).directions, row.at / 1000);
    if (row.t < 78 || travel == null) continue;
    const theirs = track.travelAt(row.t);
    if (theirs > MOTION_FLOOR_DEGREES) ratios.push(travel / theirs);
  }
  assert(ratios.length > 100, `only ${ratios.length} comparable frames`);
  const median = ratios.slice().sort((a, b) => a - b)[Math.floor(ratios.length / 2)];
  assert(median < MOTION_RATIO / 2,
    `a motionless student moved ${(100 * median).toFixed(0)}% as much as the class`);
});

test("and the class stops within two seconds of the exercise starting", () => {
  // The complaint this round: fifteen seconds of standing still before anything
  // happened, which is long enough to conclude the app is broken.
  const lock = new MirrorLock();
  const tracker = new MotionTracker();
  const follow = new PostureMonitor({
    critical: NOT_FOLLOWING_DISAGREEMENT, minor: NOT_FOLLOWING_DISAGREEMENT,
    criticalSustain: NOT_FOLLOWING_SUSTAIN_MS, minorSustain: NOT_FOLLOWING_SUSTAIN_MS,
  });
  let stoppedAt = null;
  for (const row of stillSession) {
    const student = asStudent(row);
    const inExercise = row.t >= 78;
    const window = track.referenceWindow(row.t);
    if (!window.length) continue;
    const match = compareToInstructor(student, window, { mirror: lock.value });
    if (match && lock.value === null) lock.observe(match.scores);
    const travel = tracker.observe(student.directions, row.at / 1000);
    const keepingUp = movingWithClass(travel, track.travelAt(row.t));
    const signal = keepingUp === false ? 1 : (match ? disagreementOf(match) : null);
    const verdict = follow.update(inExercise ? signal : null, row.at, { judging: inExercise });
    if (verdict.state === "critical" && stoppedAt === null) stoppedAt = row.t;
  }
  assert(stoppedAt !== null, "never noticed the student had stopped");
  assert(stoppedAt - 78 <= 2.0,
    `took ${(stoppedAt - 78).toFixed(1)}s of the exercise to notice (was 11.2s)`);
});

test("the mirror reading settles and stays settled", () => {
  // 1285 of 2287 frames of this session had the two readings within four points
  // of each other, so left to itself the choice flipped constantly and the
  // armature was drawn from whichever won that frame.
  const lock = new MirrorLock();
  let flips = 0, previous = null, settledAt = null;
  for (const row of stillSession) {
    const window = track.referenceWindow(row.t);
    if (!window.length) continue;
    const match = compareToInstructor(asStudent(row), window, { mirror: lock.value });
    if (!match) continue;
    if (lock.value === null) {
      lock.observe(match.scores);
      if (lock.value !== null && settledAt === null) settledAt = row.t;
    }
    if (previous !== null && match.mirrored !== previous) flips++;
    previous = match.mirrored;
  }
  assert(settledAt !== null, "the mirror reading never settled");
  assert(flips <= 2, `the reading flipped ${flips} times after settling`);
});

test("a correction can be cleared by a real body", () => {
  // The reason this session ended with somebody quitting. Clearing a critical
  // used to require getting under 0.30, and this student's best frames bottom
  // out around 0.20–0.33 — so the class stopped and could not be restarted.
  const reachable = [];
  for (const row of stillSession) {
    if (row.t < 78) continue;
    const window = track.referenceWindow(row.t);
    if (!window.length) continue;
    const match = compareToInstructor(asStudent(row), window, { mirror: true });
    if (match) reachable.push(match.severity);
  }
  const bar = CRITICAL_SEVERITY * RESOLVE_FRACTION;
  const clearable = reachable.filter((v) => v < bar).length;
  assert(clearable > reachable.length * 0.2,
    `only ${clearable} of ${reachable.length} frames were under the ${bar.toFixed(2)} needed to resume`);
});
