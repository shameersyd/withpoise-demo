import { readTextFile } from "./platform.js";
import { suite, test, assert, assertEqual, assertClose, assertDeepEqual } from "./harness.js";
import {
  bodyFrame, segmentDirections, computeAngles, reliableLandmarks, LM, v3,
  makeFilters, smooth, TUNING, SEGMENT_NAMES,
} from "../pose-core.js";
import {
  InstructorTrack, instructorAnchor, instructorBounds, usableReference, detectClassStart,
  HOLD_MEMORY_SECONDS, RECENT_SECONDS,
} from "../instructor.js";
import {
  compareToInstructor, mirrorDirections, PostureMonitor, readInstructor,
  FOLLOW_TOLERANCE, LAG_WINDOW_SECONDS, CRITICAL_SEVERITY, MINOR_SEVERITY, RECOVER_MS,
  NOT_FOLLOWING_DISAGREEMENT, NOT_FOLLOWING_SUSTAIN_MS, CRITICAL_SUSTAIN_MS, disagreementOf,
} from "../follow.js";
import { buildFollowerPoints, imageFrame, instructorPoints, SEGMENT_END } from "../armature.js";
import { swingLimb, tiltLimb, valgus, yawPelvis, rescale, turn, addNoise } from "./perturb.js";

const trace = JSON.parse(readTextFile("withpoise-demo/media/instructor.json"));
const track = new InstructorTrack(trace);

/** A sample with a body in it, a little way into the class. */
function sampleAt(seconds) {
  const frame = track.at(seconds);
  if (!frame || !frame.detected || !frame.world) {
    throw new Error(`no traced body at ${seconds}s — regenerate the trace`);
  }
  return frame;
}

/** Make a "user" reading out of a world landmark array. */
function asUser(world) {
  const frame = bodyFrame(world);
  return {
    world,
    frame,
    directions: segmentDirections(world, frame),
    angles: computeAngles(world, null, 1, 1),
    reliable: null,
  };
}

/**
 * Landmark noise as the app actually sees it — through the One Euro filter the
 * worker applies before anything else runs.
 *
 * Testing against raw noise overstates it badly. The filter is given fifty
 * frames of a still body, which is what holding a shape looks like, and almost
 * all of the jitter is gone by the end. An earlier version of these tests
 * skipped the filter and concluded the noise floor sat at 91 out of 100, which
 * put it on top of the real faults and was the reason the tolerance was set
 * twice as wide as it needed to be.
 */
function smoothedNoise(world, seed) {
  const filters = makeFilters(TUNING.world);
  let out = world;
  for (let i = 0; i < 50; i++) out = smooth(addNoise(world, { seed: seed + i * 13 }), filters, i / 30);
  return out;
}

const judge = (world, at, window = 0.2) =>
  compareToInstructor(asUser(world), track.window(at, window));

suite("the instructor trace");

test("the trace has a body in it, and it is real data", () => {
  // Everything below is measured against this file. If it is empty or stale,
  // every number in this suite is meaningless.
  assert(track.frames.length > 100, `only ${track.frames.length} frames traced`);
  const found = track.frames.filter(f => f.detected).length;
  assert(found / track.frames.length > 0.8,
    `only ${Math.round(100 * found / track.frames.length)}% of frames have a body`);
  assert(track.duration > 60, "and it covers a real class");
});

test("samples interpolate between the traced frames", () => {
  // Six samples a second against a thirty-frame display would visibly step.
  const i = track.frames.findIndex(f => f.detected && track.frames[track.frames.indexOf(f) + 1]);
  const a = track.frames[i], b = track.frames[i + 1];
  const middle = track.at((a.t + b.t) / 2);
  const hipA = a.image[LM.left_hip].x, hipB = b.image[LM.left_hip].x;
  const hipM = middle.image[LM.left_hip].x;
  assert(hipM >= Math.min(hipA, hipB) - 1e-9 && hipM <= Math.max(hipA, hipB) + 1e-9,
    "an interpolated hip sits between the two it came from");
});

test("the lag window returns the recent past, not the future", () => {
  const at = track.frames[60].t;
  const window = track.window(at, LAG_WINDOW_SECONDS);
  assert(window.length > 1, "more than one sample to match against");
  for (const sample of window) {
    assert(sample.t <= at + 1e-9, `${sample.t} is ahead of ${at}`);
    assert(sample.t >= at - LAG_WINDOW_SECONDS - 1e-6, `${sample.t} is too far back`);
  }
});

suite("comparing a body to the instructor");

test("the instructor matches themselves", () => {
  // The floor under everything else. If a body does not match itself, no
  // number this file produces means anything.
  for (const t of [20, 40, 60, 90]) {
    const sample = sampleAt(t);
    const match = judge(sample.world, sample.t);
    assert(match.score > 97, `at ${t}s the instructor scored ${match.score.toFixed(1)} against themselves`);
    assertDeepEqual(match.faults, [], `and emitted corrections at ${t}s`);
  }
});

test("a body of a different size matches just as well", () => {
  // The user is not the same build as the instructor. Everything is compared in
  // each body's own frame precisely so that this cannot matter.
  const sample = sampleAt(45);
  for (const factor of [0.75, 1.3]) {
    const match = judge(rescale(sample.world, factor), sample.t);
    assert(match.score > 97, `scaled ${factor}× scored ${match.score.toFixed(1)}`);
  }
});

test("a body facing a different way matches just as well", () => {
  // Nobody sets their phone up square to the room. A rigid turn changes the
  // camera's view of a body and nothing about the body.
  const sample = sampleAt(45);
  for (const degrees of [25, -25, 50]) {
    const match = judge(turn(sample.world, degrees), sample.t);
    assert(match.score > 92, `turned ${degrees}° scored ${match.score.toFixed(1)}`);
  }
});

test("a mirrored body matches, and is reported as mirrored", () => {
  // An instructor facing their class may or may not mirror deliberately, and
  // the app is never told which. Both correspondences are scored and the better
  // one wins.
  const sample = sampleAt(45);
  const mirrored = sample.world.map((p, i) => {
    const name = Object.keys(LM).find(n => LM[n] === i);
    if (!name) return { ...p, x: -p.x };
    const other = name.startsWith("left_") ? `right_${name.slice(5)}`
                : name.startsWith("right_") ? `left_${name.slice(6)}` : name;
    const source = sample.world[LM[other]];
    return { ...source, x: -source.x };
  });
  const match = judge(mirrored, sample.t);
  assert(match.score > 92, `a mirrored body scored ${match.score.toFixed(1)}`);
});

test("landmark noise alone does not invent a fault", () => {
  // Through the filter, as the app sees it. Checked unsmoothed too, because the
  // gap between the two is the whole reason the tolerance is what it is: raw
  // noise costs 10 to 14 points of agreement and lands on top of the real
  // faults, and the filter takes nearly all of it back.
  const sample = sampleAt(45);
  for (const seed of [3, 11, 29]) {
    const match = judge(smoothedNoise(sample.world, seed), sample.t);
    assert(match.severity < MINOR_SEVERITY,
      `smoothed noise seed ${seed} reads as a fault (severity ${match.severity.toFixed(2)})`);

    const raw = judge(addNoise(sample.world, { seed }), sample.t);
    assert(raw.score < match.score,
      `unsmoothed noise seed ${seed} was no worse than smoothed — is the filter being applied?`);
  }
});

suite("faults the app has to catch");

/** The worst fault reported, as a name and a sentence. */
const worstFault = (match) => (match.faults.length ? match.faults[0] : null);

test("an arm in the wrong place is caught and named", () => {
  // Checked at several points in the class rather than one, because what a
  // fault is worth depends entirely on what the instructor is doing at the
  // time — see the blind-spot test below.
  for (const at of [20, 30, 40, 45, 60, 75, 90, 120]) {
    const sample = sampleAt(at);
    const match = judge(tiltLimb(sample.world, "arm_left", 35), sample.t);
    assert(match.severity > CRITICAL_SEVERITY,
      `at ${at}s severity was only ${match.severity.toFixed(2)}`);
    const fault = worstFault(match);
    assert(fault, `no fault reported at ${at}s`);
    assert(/arm|elbow|hand|shoulder/i.test(fault.text),
      `at ${at}s the instruction was "${fault.text}"`);
  }
});

test("a correct pose is never interrupted, however the body differs", () => {
  // The one failure mode that makes the app unusable. Everything below is about
  // catching faults; this is about not inventing them.
  for (const at of [20, 30, 40, 45, 60, 75, 90, 120]) {
    const sample = sampleAt(at);
    for (const [what, world] of [
      ["as traced", sample.world],
      ["a smaller body", rescale(sample.world, 0.75)],
      ["a larger body", rescale(sample.world, 1.3)],
      ["stood 40° off-axis", turn(sample.world, 40)],
      ["through landmark noise", smoothedNoise(sample.world, 7)],
    ]) {
      const match = judge(world, sample.t);
      assert(match.severity < MINOR_SEVERITY,
        `${what} at ${at}s would have been corrected (severity ${match.severity.toFixed(2)})`);
    }
  }
});

test("a limb rotated about the axis it already lies along is badly under-read", () => {
  // Not a defect — arithmetic. Rotating anything about an axis it is parallel
  // to does not move it, so a hanging arm swung about the vertical barely goes
  // anywhere. It is the same fact that made joint angles blind to rotation, and
  // it is why the test above tilts rather than swings.
  //
  // Pinned as a comparison rather than an absolute, which is the honest form:
  // the *same* 50° error reads as critical when it moves the limb across the
  // frame and as a passing remark when it moves it along its own length. During
  // the standing-rest parts of a class, where the arms hang, a student can be
  // well out of position and this will murmur at most.
  const sample = sampleAt(45);                    // arms hanging nearly straight down
  const across = judge(tiltLimb(sample.world, "arm_left", 50), sample.t);
  const along = judge(swingLimb(sample.world, "arm_left", 50), sample.t);
  assert(across.severity > CRITICAL_SEVERITY,
    `the visible half should be critical, was ${across.severity.toFixed(2)}`);
  assert(along.severity < CRITICAL_SEVERITY,
    `expected the same error to be under-read, but it was ${along.severity.toFixed(2)}`);
  assert(along.severity < across.severity * 0.6,
    `${along.severity.toFixed(2)} vs ${across.severity.toFixed(2)} is not much of an under-read`);
});

test("a knee collapsing inward is caught and named as a knee", () => {
  // Only checked where the instructor's leg is bent, and that is the finding
  // rather than a convenience. A knee collapsing inward rotates about the line
  // from its own hip to its own ankle, and on a straight standing leg the knee
  // is *on* that line, so it does not move: at 45s, 60s and 120s of this class
  // a 35° collapse is worth a severity of 0.00. It is only visible in the wide
  // stances — 30s and 75s here.
  //
  // This is not a tuning problem and no threshold reaches it. It is why the
  // standing-knee tolerance in the original app was the pose's tightest and
  // still could not see this.
  for (const at of [30, 75]) {
    const sample = sampleAt(at);
    const match = judge(valgus(sample.world, "left", 35), sample.t);
    assert(match.severity > MINOR_SEVERITY,
      `at ${at}s severity was only ${match.severity.toFixed(2)}`);
    assert(match.faults.some(f => /knee/i.test(f.text)),
      `at ${at}s: ${match.faults.map(f => f.text).join(" / ") || "(nothing)"}`);
  }
});

test("a yawed pelvis is caught and named as hips", () => {
  // Named as hips at every point in the class, including the lunges and wide
  // stances where the yaw drifts one thigh several times as far as the other.
  // Those used to be reported as whichever knee had moved most, which is true,
  // unactionable, and would have the user chasing the symptom.
  for (const at of [20, 30, 40, 45, 60, 75, 120]) {
    const sample = sampleAt(at);
    const match = judge(yawPelvis(sample.world, 35), sample.t);
    assert(match.severity > MINOR_SEVERITY,
      `at ${at}s severity was only ${match.severity.toFixed(2)}`);
    assert(match.faults.some(f => /hip/i.test(f.text)),
      `at ${at}s: ${match.faults.map(f => f.text).join(" / ") || "(nothing)"}`);
  }
});

test("a worse fault scores worse than a milder one", () => {
  // Severity has to be monotonic or the thresholds that decide whether to
  // interrupt the class are meaningless.
  const sample = sampleAt(45);
  const sev = [0, 4, 10, 20, 35].map(d =>
    judge(tiltLimb(sample.world, "arm_left", d), sample.t).severity);
  for (let i = 1; i < sev.length; i++) {
    assert(sev[i] >= sev[i - 1] - 0.02,
      `${sev.map(v => v.toFixed(2)).join(" → ")} is not monotonic`);
  }
  assert(sev[0] < MINOR_SEVERITY, `a correct arm already reads ${sev[0].toFixed(2)}`);
  assert(sev[4] > CRITICAL_SEVERITY, `a 35° error only reads ${sev[4].toFixed(2)}`);
});

test("following a beat late still counts as following", () => {
  // Somebody watching a class is always behind it. Scoring the instant would
  // be scoring reaction time.
  const now = 60;
  const lateBy = 1.0;
  const theirs = sampleAt(now - lateBy);
  const instant = compareToInstructor(asUser(theirs.world), track.window(now, 0.1));
  const forgiving = compareToInstructor(asUser(theirs.world), track.window(now, LAG_WINDOW_SECONDS));
  assert(forgiving.score >= instant.score,
    `the window made it worse: ${instant.score.toFixed(1)} → ${forgiving.score.toFixed(1)}`);
  assert(forgiving.score > 97,
    `a second behind scored ${forgiving.score.toFixed(1)} against a ${LAG_WINDOW_SECONDS}s window`);
});

suite("the armature");

test("a correct body draws on top of the instructor's", () => {
  // The two skeletons should be nearly indistinguishable when the posture is
  // right — that is what "superimpose" means, and it is what makes a divergence
  // read as a fault rather than as a rendering artefact.
  const sample = sampleAt(45);
  const user = asUser(sample.world);
  const follower = buildFollowerPoints(user.directions, sample.image, false);
  const reference = instructorPoints(sample.image);
  assert(follower, "nothing was built");

  const torso = imageFrame(reference).torso;
  let worst = 0, worstJoint = "";
  for (const name of Object.keys(LM)) {
    if (!follower[name]) continue;
    const off = Math.hypot(follower[name].x - reference[name].x,
                           follower[name].y - reference[name].y) / torso;
    if (off > worst) { worst = off; worstJoint = name; }
  }
  assert(worst < 0.45, `${worstJoint} sits ${worst.toFixed(2)} torso-lengths off`);
});

test("a faulted body draws visibly apart", () => {
  const sample = sampleAt(45);
  const user = asUser(tiltLimb(sample.world, "arm_left", 50));
  const follower = buildFollowerPoints(user.directions, sample.image, false);
  const reference = instructorPoints(sample.image);
  const torso = imageFrame(reference).torso;
  const off = Math.hypot(follower.left_wrist.x - reference.left_wrist.x,
                         follower.left_wrist.y - reference.left_wrist.y) / torso;
  assert(off > 0.25, `the wrist only moved ${off.toFixed(2)} torso-lengths`);
});

test("every segment has a joint for its arrow to point at", () => {
  const sample = sampleAt(45);
  const reference = instructorPoints(sample.image);
  for (const [segment, end] of Object.entries(SEGMENT_END)) {
    assert(reference[end], `${segment} points at "${end}", which is not a landmark`);
  }
});

test("the armature refuses a body it cannot frame", () => {
  const sample = sampleAt(45);
  assertEqual(buildFollowerPoints(null, sample.image), null, "no directions, no figure");

  const collapsed = instructorPoints(sample.image);
  const flat = sample.image.map((p, i) =>
    (i === LM.left_shoulder || i === LM.right_shoulder)
      ? { ...p, x: collapsed.left_hip.x, y: collapsed.left_hip.y } : p);
  assertEqual(imageFrame(instructorPoints(flat)), null,
    "a body with no torso has no frame to build in");
});

test("the zoom box contains the instructor", () => {
  const sample = sampleAt(45);
  const bounds = instructorBounds(sample.image);
  const points = instructorPoints(sample.image);
  for (const name of Object.keys(LM)) {
    const p = points[name];
    if ((p.visibility ?? 1) < 0.3) continue;
    assert(p.x >= bounds.x - 1e-6 && p.x <= bounds.x + bounds.width + 1e-6, `${name} x outside the box`);
    assert(p.y >= bounds.y - 1e-6 && p.y <= bounds.y + bounds.height + 1e-6, `${name} y outside the box`);
  }
});

suite("when the class starts");

test("the greeting is not treated as part of the class", () => {
  // The demo video opens with the instructor talking to camera, and the app
  // used to start correcting immediately — the first thing a user ever heard
  // was "step back so I can see you", spoken over the introduction.
  assert(track.startsAt > 5,
    `the class is reckoned to start at ${track.startsAt.toFixed(1)}s, which is no greeting at all`);
  assert(track.startsAt < 180,
    `${track.startsAt.toFixed(1)}s of greeting is too much to be believable`);
  assert(!track.hasStarted(0), "started at the very first frame");
  assert(track.hasStarted(track.startsAt + 0.1), "never starts");
  assert(track.hasStarted(track.seconds - 1), "stopped before the end");
});

test("a talking head is never a usable reference", () => {
  // Not a threshold — a fact about the picture. With the instructor's legs out
  // of shot there is nothing to compare a user's legs against, and the
  // landmarker still reports knees and ankles, pinned wherever it guesses they
  // are beyond the frame.
  const early = track.frames.filter(f => f.t < 12);
  assert(early.length > 10, "not enough traced frames to tell");
  const usable = early.filter(usableReference).length;
  assertEqual(usable, 0, `${usable} of the first ${early.length} frames were taken as a reference`);
});

test("the class is reckoned to start from movement, not from being in shot", () => {
  // The instructor stands fully in frame and talks before beginning, so being
  // visible cannot be the whole test. Measured over this class, standing and
  // talking runs at a shape speed of 0.24–0.36 and practice at 0.8–1.4.
  const standingAndTalking = track.frames.filter(f => f.t >= 14 && f.t < 23);
  assert(standingAndTalking.every(usableReference),
    "the instructor is meant to be fully in shot while talking here");
  assert(track.startsAt > 23,
    `started at ${track.startsAt.toFixed(1)}s, during the part where they are still talking`);
});

test("an instructor who never practises never starts a class", () => {
  // Nine minutes of someone standing still, in shot, saying hello.
  const still = track.frames.find(usableReference);
  const frames = [];
  for (let i = 0; i < 3000; i++) frames.push({ ...still, t: i / 6 });
  assertEqual(detectClassStart(frames), null, "found a class in a motionless video");
});

test("a trace may say when the class starts and be believed", () => {
  // Tracing is an offline step with a human present, and a human who has
  // watched the video knows better than this does.
  const told = new InstructorTrack({ ...trace, startsAt: 91.5 });
  assertEqual(told.startsAt, 91.5);
  assert(!told.hasStarted(91), "ignored what it was told");
  assert(told.hasStarted(92), "ignored what it was told");
});

test("a held pose does not end the class", () => {
  // Movement starts the class and is not required to continue it. A pose held
  // perfectly still is motionless and is exactly when coaching matters most.
  const longest = (() => {
    let best = 0, from = null;
    for (const f of track.frames) {
      if (!track.hasStarted(f.t)) continue;
      if (from === null) from = f.t;
      best = Math.max(best, f.t - from);
    }
    return best;
  })();
  assert(longest > track.seconds - track.startsAt - 1,
    "the class stopped partway through");
});

suite("what both cameras can see");

test("a cropped instructor is not used as a reference for what is cropped", () => {
  // Two thirds of this class has the instructor partly out of shot — 31% with
  // the arms cropped, 35% with the legs. Scoring a user's legs against an
  // instructor whose knees are a guess beyond the frame edge is worse than
  // scoring nothing, because it produces corrections.
  const cropped = track.frames.find(f => {
    if (!f.detected || !f.image) return false;
    const vis = (n) => (f.image[LM[n]].visibility ?? 1) > 0.5
      && f.image[LM[n]].y > 0.02 && f.image[LM[n]].y < 0.98;
    return vis("left_shoulder") && vis("right_shoulder") && !vis("left_ankle");
  });
  assert(cropped, "no partly-cropped frame in the trace to check");

  const read = readInstructor(cropped);
  assert(read.reliable, "the instructor got no reliability mask at all");
  assert(!read.reliable.has("left_ankle"),
    "an ankle outside the frame was taken as reliably seen");
  assert(read.reliable.has("left_shoulder"), "a visible shoulder was discarded");

  // And the segments that depend on it go unscored rather than wrong.
  const sample = track.at(cropped.t);
  const match = compareToInstructor(asUser(sample.world), [cropped]);
  assert(!match.segments.shin_left || match.segments.shin_left.quality === undefined,
    "a shin was scored against an instructor's off-frame ankle");
});

suite("what the class is asking for");

/** The worst single segment's disagreement between two shapes, in degrees. */
function worstSegmentGap(a, b) {
  let worst = 0;
  for (const name of SEGMENT_NAMES) {
    if (!a[name] || !b[name]) continue;
    worst = Math.max(worst,
      Math.acos(Math.max(-1, Math.min(1, v3.dot(a[name], b[name])))) * 180 / Math.PI);
  }
  return worst;
}

const shapeOf = (frame) => segmentDirections(frame.world, bodyFrame(frame.world));

/**
 * Every place in the class where the instructor holds a shape, leaves it
 * entirely, and comes back to it — the thing they do while explaining.
 *
 * Found from the trace rather than listed by hand, and judged on the worst
 * segment rather than the mean. An earlier version of this search used the mean
 * and produced episodes that were not episodes at all: at 224s it called the
 * instructor "back to within 8°" while their right arm was 27° and their right
 * forearm 31° away from where the student was holding. Means hide exactly the
 * per-segment truth this app is built to see.
 */
function leaveAndReturnEpisodes(limit = 20) {
  const frames = track.frames;
  const shapes = frames.map(f => f.world ? shapeOf(f) : null);
  const found = [];
  for (let i = 0; i < frames.length - 150 && found.length < limit; i++) {
    if (!usableReference(frames[i]) || !shapes[i]) continue;
    for (const gap of [48, 66, 90, 120]) {           // 8s to 20s at 6fps
      const j = i + gap;
      if (j >= frames.length || !usableReference(frames[j]) || !shapes[j]) continue;
      if (worstSegmentGap(shapes[i], shapes[j]) > 12) continue;
      let peak = 0, whole = true;
      for (let k = i + 9; k < j - 9; k++) {
        if (!shapes[k]) { whole = false; break; }
        peak = Math.max(peak, worstSegmentGap(shapes[i], shapes[k]));
      }
      if (!whole || peak < 45) continue;
      found.push({ held: frames[i], returnsAt: frames[j].t, leftBy: peak });
      i += 48;
      break;
    }
  }
  return found;
}

test("the class has episodes where the instructor leaves a pose and returns", () => {
  // The premise of everything below. If this ever fails the fixture has
  // changed, and the tests after it are not testing what they claim.
  const episodes = leaveAndReturnEpisodes();
  assert(episodes.length >= 12,
    `only ${episodes.length} leave-and-return episodes found in the trace`);
  assert(episodes.some(e => e.leftBy > 90),
    "no episode where the instructor really left the pose");
});

test("a student who holds through an explanation is never corrected", () => {
  // The whole fix. Instructors come out of a pose to explain it — walking,
  // gesturing, talking to camera — while the student stays put, and the app
  // used to correct the student for staying put. Measured before the fix: of
  // eight such episodes, three were bad enough to stop the class and zoom in on
  // somebody doing exactly the right thing.
  const episodes = leaveAndReturnEpisodes();
  const corrected = [];
  for (const episode of episodes) {
    if (!track.isHolding(episode.returnsAt)) continue;     // silent anyway
    const match = compareToInstructor(
      asUser(episode.held.world), track.referenceWindow(episode.returnsAt));
    if (match && match.severity > MINOR_SEVERITY) {
      corrected.push(`${episode.held.t.toFixed(0)}s→${episode.returnsAt.toFixed(0)}s ` +
        `(left by ${episode.leftBy.toFixed(0)}°, severity ${match.severity.toFixed(2)})`);
    }
  }
  assertEqual(corrected.length, 0,
    `corrected a student who held correctly: ${corrected.join(", ")}`);
});

test("nothing is judged while the instructor is in continuous motion", () => {
  // The user's call, and the measured consequence: 75% of the class has a
  // settled pose within the memory and stays coachable, and the rest goes
  // quiet rather than correcting form against a reference that is itself
  // mid-movement two seconds ago.
  const after = track.frames.filter(f => f.t >= track.startsAt);
  const holding = after.filter(f => track.isHolding(f.t)).length;
  const share = holding / after.length;
  assert(share > 0.5, `only ${(share * 100).toFixed(0)}% of the class is coachable`);
  assert(share < 0.95, `${(share * 100).toFixed(0)}% — the flow gate is not gating anything`);
});

test("a settled pose is one the instructor stayed in, not one they passed through", () => {
  const settledIndex = track.settled.findIndex((yes, i) => yes && track.frames[i].t > track.startsAt);
  assert(settledIndex > 0, "nothing in the class counts as settled");

  // Whatever is called settled really is still, across the whole look-back.
  const shapes = track.frames.map(f => f.world ? shapeOf(f) : null);
  let checked = 0;
  for (let i = settledIndex; i < track.frames.length && checked < 200; i++) {
    if (!track.settled[i] || !shapes[i]) continue;
    const since = track.frames[i].t - 1.5;
    for (let k = i; k >= 0 && track.frames[k].t >= since; k--) {
      if (!shapes[k]) continue;
      const gap = worstSegmentGap(shapes[i], shapes[k]);
      assert(gap < 90, `a "settled" frame at ${track.frames[i].t}s moved ${gap.toFixed(0)}° within 1.5s`);
    }
    checked++;
  }
  assert(checked > 20, "not enough settled frames to check");
});

test("the reference window carries both settled poses and the recent past", () => {
  const at = track.startsAt + 120;
  const window = track.referenceWindow(at);
  assert(window.length > 0, "no reference at all");

  // Nothing older than the memory, and everything inside `recent` is present
  // whether it settled or not.
  for (const frame of window) {
    assert(frame.t >= at - HOLD_MEMORY_SECONDS - 1e-6, `${frame.t}s is older than the memory`);
    assert(frame.t <= at + 1e-6, `${frame.t}s is in the future`);
  }
  const recent = track.frames.filter(f => f.t > at - RECENT_SECONDS && f.t <= at && f.detected);
  for (const frame of recent) {
    assert(window.includes(frame), `${frame.t}s is inside the recent window but was dropped`);
  }
});

test("a student in an entirely different pose is still caught", () => {
  // The permissiveness above has to stop somewhere. Being generous about which
  // pose the class is on must not become generous about whether the student is
  // doing yoga at all.
  const pairs = [[60, 790], [120, 1210], [300, 790], [800, 60]];
  for (const [at, doing] of pairs) {
    if (!track.isHolding(at)) continue;
    const match = compareToInstructor(asUser(track.at(doing).world), track.referenceWindow(at));
    assert(match && match.severity > CRITICAL_SEVERITY,
      `at ${at}s, a student doing the ${doing}s pose read ${match ? match.severity.toFixed(2) : "nothing"}`);
  }
});

test("form faults survive the longer memory", () => {
  // Twenty seconds of candidates could have diluted single-limb detection to
  // nothing. It does not, because matching is whole-body: a wrong arm stays
  // wrong against every candidate unless the instructor genuinely had their arm
  // there with the rest of the body in the same place.
  let caught = 0, tested = 0;
  for (const at of [40, 60, 120, 200, 800, 1210]) {
    if (!track.isHolding(at)) continue;
    tested++;
    const match = compareToInstructor(
      asUser(tiltLimb(track.at(at).world, "arm_left", 35)), track.referenceWindow(at));
    if (match && match.severity > CRITICAL_SEVERITY) caught++;
  }
  assert(tested >= 4, `only ${tested} coachable moments to test`);
  assert(caught >= tested - 1, `caught ${caught} of ${tested} misplaced limbs`);
});

test("a correction is released when the class moves on, not held open", () => {
  // Being stuck in a paused, zoomed correction while the class has moved past
  // it is the worst of both: wrong and stuck. Losing sight of the *user* is
  // different and must still hold the state.
  const monitor = new PostureMonitor();
  for (let t = 0; t < 4000; t += 200) monitor.update(0.9, t);
  assertEqual(monitor.state, "critical");

  assertEqual(monitor.update(null, 4200, { judging: true }).state, "critical",
    "losing the user should hold the correction");

  monitor.update(null, 5000, { judging: false });
  assertEqual(monitor.update(null, 5000 + RECOVER_MS + 50, { judging: false }).state, "ok",
    "the correction should have been released when there was nothing to judge");
});

suite("doing the class at all");

test("standing still through a counted set is noticed", () => {
  // What the app failed to say to somebody standing motionless in front of
  // their camera for six minutes while the instructor worked through three
  // sets. Form correction was correctly suppressed — nobody can be told their
  // elbow is wrong mid-crunch — and "are you doing this at all" was wrongly
  // suppressed with it.
  const standing = asUser(track.at(25).world);     // a real standing body
  const sets = [129, 160, 256, 357, 662, 730, 836, 959];
  let noticed = 0;
  for (const at of sets) {
    const match = compareToInstructor(standing, track.referenceWindow(at));
    assert(match, `no reference at ${at}s`);
    const share = disagreementOf(match);
    if (share != null && share >= NOT_FOLLOWING_DISAGREEMENT) noticed++;
  }
  assert(noticed >= sets.length - 2,
    `standing still was noticed at only ${noticed} of ${sets.length} counted sets`);
});

test("following imperfectly is never called not following", () => {
  // The bar has to separate "doing it badly" from "not doing it", or the app
  // tells people who are working hard that they have stopped.
  // One stray frame is tolerable — the 4.5s sustain cannot be carried by it —
  // but a run of them would be the app telling somebody working hard that they
  // have stopped.
  const strays = [];
  for (const at of [129, 160, 256, 357, 662, 730, 836, 959]) {
    for (const lag of [1, 2, 3, 4, 6]) {
      const behind = track.at(at - lag);
      if (!behind || !behind.world) continue;
      for (const [what, world] of [
        ["in time", behind.world],
        ["with a limb 35° out", tiltLimb(behind.world, "arm_left", 35)],
        ["with a knee collapsed", valgus(behind.world, "left", 35)],
      ]) {
        const match = compareToInstructor(asUser(world), track.referenceWindow(at));
        if (!match) continue;
        const share = disagreementOf(match);
        if (share == null) continue;              // too little of them scored to say
        if (share >= NOT_FOLLOWING_DISAGREEMENT) strays.push(
          `${at}s/${lag}s ${what} (${share.toFixed(2)})`);
      }
    }
  }
  assert(strays.length <= 2,
    `${strays.length} frames called a following student not following: ${strays.join(", ")}`);
});

test("not following is a slower claim than a form fault", () => {
  // Crossing the room for a block is not giving up, and the claim is blunter
  // than naming a limb.
  assert(NOT_FOLLOWING_SUSTAIN_MS > CRITICAL_SUSTAIN_MS,
    "it should take longer to accuse somebody of not following than to correct them");
  const monitor = new PostureMonitor({
    critical: NOT_FOLLOWING_DISAGREEMENT, minor: NOT_FOLLOWING_DISAGREEMENT,
    criticalSustain: NOT_FOLLOWING_SUSTAIN_MS, minorSustain: NOT_FOLLOWING_SUSTAIN_MS,
  });
  assertEqual(monitor.update(1, 0).state, "ok", "not on the first frame");
  assertEqual(monitor.update(1, NOT_FOLLOWING_SUSTAIN_MS - 200).state, "ok");
  assertEqual(monitor.update(1, NOT_FOLLOWING_SUSTAIN_MS + 100).state, "critical");
});

suite("which body is being traced");

test("the trace follows one person, not whichever the detector ranked first", () => {
  // The class is filmed with two people on two mats: the teacher, who speaks,
  // and a student following beside them. A trace that wandered between them
  // would produce a reference that changes body mid-class, and every
  // correction after the switch would be measured against the wrong person.
  //
  // What makes this checkable without the second body in the file is
  // consistency: one person does not teleport across the room between frames.
  let flips = 0, measured = 0, previous = null;
  for (const frame of track.frames) {
    if (!frame.detected || !frame.image) { previous = null; continue; }
    const hip = (frame.image[LM.left_hip].x + frame.image[LM.right_hip].x) / 2;
    if (previous != null && Math.abs(hip - previous) > 0.25) flips++;
    previous = hip;
    measured++;
  }
  assert(measured > 5000, `only ${measured} usable frames`);
  assert(flips < measured * 0.002,
    `the traced body jumped across the frame ${flips} times in ${measured} frames`);
});

test("the traced body is the one on the right, which is the teacher", () => {
  // Identified from the video itself: at 20s the person on the right is
  // mid-gesture addressing the camera under the subtitle "But exercise is
  // still", while the person on the left stands with their hands at their
  // sides. The teacher is also the one nearer the camera, which is what
  // tools/trace-instructor.html selects on.
  const after = track.frames.filter(f => f.detected && f.image && f.t > track.startsAt);
  const onTheRight = after.filter(f =>
    (f.image[LM.left_hip].x + f.image[LM.right_hip].x) / 2 > 0.5).length;
  assert(onTheRight > after.length * 0.98,
    `only ${onTheRight} of ${after.length} traced frames are the right-hand body`);
});
