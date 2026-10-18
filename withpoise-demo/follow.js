/**
 * Comparing a person to the instructor they are following.
 *
 * The original app compared a user to an idealised rig: a shape written down
 * once, in known coordinates, the same for everybody. This compares one human
 * body to another human body, filmed in a different room, at a different
 * distance, with different proportions. Almost none of the raw numbers are
 * comparable.
 *
 * What is comparable is the body frame. Each body gets a frame built from its
 * own hips and shoulders, and every segment direction is expressed in it — so
 * "the upper arm points 40° out from the spine" means the same thing for a tall
 * instructor filmed from four metres and a short user filmed from two. That
 * machinery was built to make a pose score the same from any camera angle; it
 * turns out to be exactly what is needed to compare two different people.
 *
 * Three things this has to get right that the rig version never faced:
 *
 *   **Mirroring.** Instructors face the camera and so do their students, so
 *   left and right may or may not correspond depending on whether the
 *   instructor is mirroring deliberately. Both correspondences are scored and
 *   the better one wins, which means the app never has to be told.
 *
 *   **Lag.** Somebody following a video is always behind it: they see a
 *   movement, then make it. Scoring against the instant would be scoring
 *   reaction time, so the comparison looks back over a window and takes the
 *   best match in it.
 *
 *   **Tolerance.** A different human is a noisier reference than a rig. See
 *   FOLLOW_TOLERANCE.
 */

import { MOTION_WINDOW_SECONDS } from "./instructor.js";
import {
  bodyFrame, segmentDirections, matchSegments, computeAngles, jointQuality, reliableLandmarks,
  SEGMENT_NAMES, SEGMENT_PARTS, segmentCorrection, recogniseFaults, ANGLE_JOINTS,
} from "./pose-core.js";

/**
 * How far a segment may point from the instructor's and still be called right.
 *
 * Measured against the traced instructor rather than guessed. The first value
 * here was 12°, reasoned from an error budget — an instructor is a human being
 * whose proportions differ from the user's, whose body frame is estimated from
 * noisy landmarks, and who is filmed by a different camera, so the band had to
 * be wider than the 4° the original app used against an exact rig.
 *
 * The reasoning was sound and the number was wrong, by a factor of two. At 12°
 * a 35°-misplaced limb scored 95 and a collapsing knee scored 100 — the faults
 * sat inside the band. Sweeping tolerance against this class, with the subject's
 * own body as the reference and the app's own One Euro filter applied:
 *
 *      tolerance   same body, smoothed noise   a limb 35° out of place
 *          5°                 0.00                     0.67
 *          7°                 0.00                     0.52 – 0.67
 *          9°                 0.00                     0.33 – 0.67
 *         12°                 0.00                     0.19 – 0.55
 *
 * (severity, 0–1; see CRITICAL_SEVERITY.) The error budget had double-counted
 * landmark noise, which the filter removes almost entirely before anything here
 * sees it — the same dependency on smoothing the original app had at 4°.
 *
 * What the sweep cannot vary is the error that actually drove the estimate: the
 * user is a different human being from the instructor, and no synthetic
 * perturbation of the instructor's own body stands in for that. 5° is therefore
 * measured against the wrong thing, just more carefully than 12° was, and it is
 * still the first number to revisit after a real session.
 */
export const FOLLOW_TOLERANCE = 5;
export const FOLLOW_MARGIN = 11;

/**
 * What a teacher is actually watching, as weights.
 *
 * The spine and the legs carry a pose; the forearms mostly follow from the
 * upper arms. Uniform weights would let a trailing hand outvote a collapsing
 * back.
 */
export const SEGMENT_WEIGHTS = {
  torso: 3,
  thigh_left: 3, thigh_right: 3,
  shin_left: 2, shin_right: 2,
  upper_arm_left: 2, upper_arm_right: 2,
  forearm_left: 1, forearm_right: 1,
};

// How far back to look for the pose the user is actually copying. Two seconds
// is a generous reaction time and still far shorter than any held yoga shape,
// so it forgives lag without forgiving the wrong pose.
/**
 * Kept as the raw following lag, for the one thing it still means: how far
 * behind the video a student can be and still be said to be following.
 *
 * It is no longer what the comparison runs against. That is
 * HOLD_MEMORY_SECONDS over the instructor's *settled* poses — see
 * InstructorTrack.settledWindow, and detectSettled for why comparing against
 * every frame the instructor passed through was the wrong question.
 */
export const LAG_WINDOW_SECONDS = 2;

const MIRROR = {
  torso: "torso",
  upper_arm_left: "upper_arm_right", upper_arm_right: "upper_arm_left",
  forearm_left: "forearm_right", forearm_right: "forearm_left",
  thigh_left: "thigh_right", thigh_right: "thigh_left",
  shin_left: "shin_right", shin_right: "shin_left",
};

/**
 * The same directions as seen in a mirror.
 *
 * Swap the sides, and negate the lateral component — the body frame's x axis
 * points to the body's own left, so a mirrored body's left limb occupies the
 * right limb's direction with x reversed.
 */
export function mirrorDirections(directions) {
  const out = {};
  for (const [name, other] of Object.entries(MIRROR)) {
    const d = directions[other];
    out[name] = d ? { x: -d.x, y: d.y, z: d.z } : null;
  }
  return out;
}

/** Everything about one instructor sample that the comparison needs, cached. */
export function readInstructor(sample) {
  if (sample.read) return sample.read;
  if (!sample.world) return null;
  const frame = bodyFrame(sample.world);
  const directions = segmentDirections(sample.world, frame);
  sample.read = {
    frame,
    directions,
    mirrored: mirrorDirections(directions),
    angles: computeAngles(sample.world, null, 1, 1),
    // What the *instructor's* camera could actually see.
    //
    // This was missing, and it mattered more than it looks. The app judged
    // every segment of every traced frame regardless of whether the instructor
    // was in shot, so a close-up on their upper body was still being used as a
    // reference for the user's legs — with the instructor's knees and ankles
    // pinned wherever the landmarker guessed they were just off-frame.
    //
    // Measured over the demo class, after the greeting ends: only 34% of it
    // has the whole instructor in frame. 31% has the legs with the arms
    // cropped, and 35% the arms with the legs cropped. Two thirds of a class
    // is partially out of shot, which is what filming yoga looks like.
    reliable: sample.image ? reliableLandmarks(sample.image) : null,
  };
  return sample.read;
}

/**
 * The parts of a student the app cannot work without.
 *
 * Shoulders and hips build the body frame that makes two differently
 * proportioned people comparable at all; without the knees there are no legs to
 * compare, which for most exercises is most of the movement.
 */
export const ESSENTIAL_LANDMARKS = [
  "left_shoulder", "right_shoulder", "left_hip", "right_hip", "left_knee", "right_knee",
];

/**
 * Is enough of the student in shot to judge them?
 *
 * Being *detected* and being *usable* are different things, and the app only
 * ever checked the first. A student standing close to their phone is detected
 * confidently — the landmarker is happy to report a head and shoulders — while
 * everything the comparison needs is below the bottom of the frame.
 *
 * Measured from a real session: standing a normal distance from a propped-up
 * phone put the hips at y=1.37 and the ankles at y=2.31, which is to say off
 * the picture entirely. Shoulders scored 94–100% reliable, elbows 54–60%,
 * wrists 12%, and hips, knees and ankles 0%. Coverage never rose above 0.32
 * against the 0.5 a verdict needs.
 *
 * So the app refused to judge, which was right, and said nothing about it,
 * which was not: a student stood still in front of it for half a minute
 * expecting to be corrected and the app had quietly decided it could not see
 * enough of them to try. Silence is this design's normal state, so there was
 * nothing to distinguish "you are doing fine" from "I cannot use any of this".
 */
export function framingOf(reliable) {
  if (!reliable) return "absent";
  const missing = ESSENTIAL_LANDMARKS.filter((name) => !reliable.has(name));
  if (!missing.length) return "ok";
  // Named by what the student should do about it. Hips and knees out of frame
  // while the shoulders are fine means they are too close, or the phone is
  // tilted too far up — both fixed by stepping back.
  return "cropped";
}

/**
 * Landmarks both cameras can see.
 *
 * A segment is only worth scoring where the user's camera resolved it *and* the
 * instructor's did. Either one missing makes the comparison a comparison with a
 * guess, and `matchSegments` leaves an unreliable segment unscored rather than
 * scoring it badly — so this intersection is what keeps a cropped instructor
 * from reading as a user in the wrong shape.
 */
function bothVisible(userReliable, instructorReliable) {
  if (!userReliable) return instructorReliable;
  if (!instructorReliable) return userReliable;
  const shared = new Set();
  for (const name of userReliable) if (instructorReliable.has(name)) shared.add(name);
  return shared;
}

const ANGLE_NAMES = Object.keys(ANGLE_JOINTS);
const MIRROR_JOINT = (name) =>
  name.startsWith("left_") ? `right_${name.slice(5)}`
  : name.startsWith("right_") ? `left_${name.slice(6)}` : name;

/** Mean quality across the eight joint angles, against an instructor's. */
function angleAgreement(userAngles, instructorAngles, mirrored) {
  let total = 0;
  for (const joint of ANGLE_NAMES) {
    const against = instructorAngles[mirrored ? MIRROR_JOINT(joint) : joint];
    total += jointQuality(Math.abs(userAngles[joint] - against), 20, 25);
  }
  return total / ANGLE_NAMES.length;
}

/**
 * Score the user against one instructor sample, one way round.
 *
 * Returns the segment match plus an aggregate, so the caller can pick the best
 * sample and orientation before anything is reported to anybody.
 */
function scoreAgainst(user, read, mirrored, tuning) {
  const targets = mirrored ? read.mirrored : read.directions;
  const segments = matchSegments(user.directions, targets, user.frame, {
    specs: Object.fromEntries(SEGMENT_NAMES.map(name =>
      [name, { tolerance: tuning.tolerance, weight: SEGMENT_WEIGHTS[name] ?? 1 }])),
    margin: tuning.margin,
    reliable: bothVisible(user.reliable, read.reliable),
  });

  let earned = 0, judged = 0, total = 0;
  for (const name of SEGMENT_NAMES) {
    const weight = SEGMENT_WEIGHTS[name] ?? 1;
    total += weight;
    const result = segments.results[name];
    if (!result) continue;
    earned += result.quality * weight;
    judged += weight;
  }

  // Angles are folded in at a modest weight. They cannot see rotation, which
  // is what directions are for — but they are the more robust of the two when
  // the body frame itself is shaky, and a disagreement between them is a
  // useful hedge rather than a contradiction.
  const angles = angleAgreement(user.angles, read.angles, mirrored);
  const directionScore = judged > 0 ? earned / judged : 0;
  const blended = judged > 0 ? directionScore * 0.75 + angles * 0.25 : angles;

  return {
    score: blended * 100,
    coverage: total > 0 ? judged / total : 0,
    segments,
    targets,
    mirrored,
  };
}

/**
 * Compare the user to the instructor over the lag window, both ways round.
 *
 * `user` is { directions, frame, angles, reliable }. `samples` is the window of
 * instructor frames. Returns the best match found, with the faults it implies.
 */
export function compareToInstructor(user, samples, options = {}) {
  const tuning = {
    tolerance: options.tolerance ?? FOLLOW_TOLERANCE,
    margin: options.margin ?? FOLLOW_MARGIN,
  };
  // `mirror` fixes the reading rather than letting every frame re-decide it.
  // See MirrorLock for why that matters.
  const only = options.mirror === true || options.mirror === false ? options.mirror : null;
  const bestOf = { direct: -1, mirrored: -1 };
  let best = null;
  for (const sample of samples) {
    const read = readInstructor(sample);
    if (!read) continue;
    for (const mirrored of (only === null ? [false, true] : [only])) {
      const scored = scoreAgainst(user, read, mirrored, tuning);
      const slot = mirrored ? "mirrored" : "direct";
      if (scored && scored.score > bestOf[slot]) bestOf[slot] = scored.score;
      if (!best || scored.score > best.score) {
        best = { ...scored, sample, read };
      }
    }
  }
  if (!best) return null;

  // Where several segments tell one story, name the story — the same
  // recogniser the pose library used, because a yawed pelvis reads the same
  // whether the reference is a rig or a person.
  const named = recogniseFaults(best.segments.results, user.directions, best.targets);
  const explained = new Set(named.flatMap(n => n.explains));

  const faults = [
    ...named.map(n => ({
      segment: n.joint, text: n.text, weight: n.weight, quality: n.quality,
      degrees: null, explains: n.explains,
    })),
    ...Object.entries(best.segments.results)
      .filter(([name, r]) => !r.ok && !explained.has(name))
      .map(([name, r]) => ({
        segment: name,
        text: segmentCorrection(name, user.directions[name], best.targets[name]),
        weight: r.weight, quality: r.quality, degrees: r.degrees,
      })),
  ].sort((a, b) => (b.weight * (1 - b.quality)) - (a.weight * (1 - a.quality)));

  // The decision to interrupt rides on the worst thing wrong, not the average.
  //
  // A weighted mean over nine segments is the right number to *show* — it says
  // how the pose is going as a whole. It is the wrong number to act on. One
  // badly misplaced limb against eight good ones moves a mean by five points
  // and is exactly the thing worth stopping a class for, which is also how a
  // teacher sees it: they do not average you, they look at the knee.
  //
  // Scaled by the segment's weight so a collapsing knee outranks a trailing
  // hand, and normalised by the heaviest weight so the result is comparable
  // across poses.
  const heaviest = Math.max(...Object.values(SEGMENT_WEIGHTS));
  const severity = faults.length
    ? Math.min(1, (faults[0].weight ?? 1) * (1 - (faults[0].quality ?? 0)) / heaviest)
    : 0;

  return {
    score: best.score,
    // What each reading was worth, for settling the mirror question over time.
    scores: { direct: bestOf.direct, mirrored: bestOf.mirrored },
    severity,
    coverage: best.coverage,
    mirrored: best.mirrored,
    matchedAt: best.sample.t,
    segments: best.segments.results,
    targets: best.targets,
    instructor: best.sample,
    userDirections: user.directions,
    faults,
  };
}

// ─────────────────────────────────────────────────────────────
// Deciding when to interrupt
// ─────────────────────────────────────────────────────────────

// How wrong the worst limb has to be before anything happens.
//
// Severity is weight × how far out of tolerance, normalised, so 1.0 is the
// heaviest segment entirely wrong and 0 is nothing wrong at all. Measured
// against the real traced instructor with the user's own body as the subject:
//
//     a limb tilted 20° out of place      0.33 – 0.55
//     a limb tilted 35° out of place      0.55 – 0.75
//     a pelvis yawed 35°                  0.40 – 0.75
//     the same body, smoothed noise       0.00 – 0.05
//
// 0.55 stops the class and 0.30 is worth a word. The gap between the noise
// floor and the mildest real fault is wide, and it needs to be: the error this
// cannot measure is the one that matters most, which is that the user is a
// different human being from the instructor and no amount of synthetic noise
// stands in for that. These are the first two numbers to revisit after a real
// session, and tests/ is set up to revisit them with.
export const CRITICAL_SEVERITY = 0.55;
export const MINOR_SEVERITY = 0.30;

/**
 * Not doing the class at all, as opposed to doing it imperfectly.
 *
 * These are two different questions and the app needs both. Judging *form* only
 * makes sense when the class is asking for a shape to be held — nobody can be
 * told their elbow is 20° out while they are halfway through their eighth
 * bicycle crunch. But "are you doing this at all" makes sense always, and
 * suppressing it along with form correction is how the app came to say nothing
 * to somebody standing motionless in front of their camera for six minutes
 * while the instructor worked through three sets.
 *
 * It needs its own measure, and the obvious two both fail:
 *
 *   severity   the worst weighted segment — what form correction rides on —
 *              saturates. A single heaviest-weight segment entirely wrong
 *              already reads 1.00, so a collapsed knee is indistinguishable
 *              from a body in the wrong place altogether. Measured: both 1.00.
 *
 *   score      the weighted mean. Separates, but barely: standing still ran
 *              25–44 against 47–100 for somebody following with a fault. Three
 *              points of margin is not a threshold, it is a coincidence.
 *
 * What the question actually asks is *how much of the body* is in the wrong
 * place, which is neither the worst part nor the average. Hence `disagreement`:
 * the weighted share of the scored segments that are out of tolerance.
 *
 * With one catch that took a measurement to find. A share is unstable when
 * little is being scored — if the instructor is cropped to three segments, one
 * bad knee is a third of the body — so the claim also requires most of the body
 * to be measurable in the first place. A statement about the whole of somebody
 * cannot be made from a quarter of them. Measured over eight counted sets at
 * five following lags:
 *
 *                                      frames claiming "not following"
 *     standing still, not following             30 of 40
 *     following in time                          0 of 40
 *     following, limb 35° out of place           0 of 40
 *     following, knee collapsed 35°              1 of 40
 *     following, pelvis yawed 35°                0 of 40
 *     doing a different pose entirely           15 of 40
 */
export const NOT_FOLLOWING_DISAGREEMENT = 0.6;
export const NOT_FOLLOWING_COVERAGE = 0.6;

/**
 * How much of the body has to be measured before any verdict is believed.
 *
 * Resolving a correction needs *positive evidence that the student has fixed
 * it*, and a comparison drawn from a quarter of their body is not that. The
 * difference matters because the two failure modes are not symmetric: refusing
 * to judge leaves a correction standing, which is recoverable, and judging on
 * nothing resolves one that was never fixed, which is not.
 *
 * Found by being exploited. A student who walked out of shot, or stepped close
 * enough to the camera that their legs left the frame, had their correction
 * cleared and the class resumed — not because they had corrected anything but
 * because there was no longer enough of them to disagree with. "Nothing looks
 * wrong" and "almost nothing was visible" had been allowed to mean the same
 * thing.
 */
export const MIN_VERDICT_COVERAGE = 0.5;

/**
 * The severity to act on, or null when too little of the student was measured
 * to have an opinion at all.
 */
export function verdictSeverity(match) {
  if (!match) return null;
  if ((match.coverage ?? 0) < MIN_VERDICT_COVERAGE) return null;
  return match.severity;
}

/**
 * And how long, which is much longer than a form fault needs.
 *
 * This was 4500ms, reasoned from the idea that a student crossing the room for
 * a block should not be accused of giving up. In use that was far too patient:
 * four and a half seconds of standing there wrong before anything happens
 * reads as the app being broken, which is how it was reported. A correction
 * that arrives after the moment has passed is not a correction.
 *
 * 1500ms, so that nothing takes longer than about two seconds from going wrong
 * to being told. Still long enough that a dropped detection or a half-second
 * of being between shapes cannot trigger it.
 */
export const NOT_FOLLOWING_SUSTAIN_MS = 1500;

/**
 * How much of the scored body is out of tolerance, 0 to 1, or null when too
 * little of it was scored to say.
 *
 * Null rather than zero, because "nothing looks wrong" and "almost nothing was
 * visible" must not read alike to the caller.
 */
export function disagreementOf(match) {
  if (!match || !match.segments) return null;
  if ((match.coverage ?? 0) < NOT_FOLLOWING_COVERAGE) return null;
  let wrong = 0, scored = 0;
  for (const name of SEGMENT_NAMES) {
    const segment = match.segments[name];
    if (!segment) continue;
    scored += segment.weight;
    if (!segment.ok) wrong += segment.weight * (1 - segment.quality);
  }
  return scored > 0 ? wrong / scored : null;
}

// How long a fault has to persist before anything happens. Nobody moves
// instantly from one shape to the next, and a class that pauses every time
// somebody is mid-transition is unusable.
export const CRITICAL_SUSTAIN_MS = 1200;
export const MINOR_SUSTAIN_MS = 700;

// And how long it has to be right before the interruption ends. Shorter than
// the sustain, because getting out of the way quickly is most of what makes
// this bearable.
export const RECOVER_MS = 500;

/**
 * How much better than the bar a student has to get before a correction lifts.
 *
 * Entering a state and leaving it must be different bars or the app chatters at
 * the boundary. They were the same bar here, and worse, leaving used the
 * *minor* threshold whatever state you were in: a correction raised at 0.55
 * could only be cleared by getting below 0.30, which is not "fix it" but "be
 * nearly perfect".
 *
 * Measured against a recorded session, that was unreachable. The student's best
 * frames bottomed out around 0.33 — a real person in their living room matching
 * a video of a different person at a different distance from a different lens
 * does not get closer than that — so the class stopped and could not be
 * restarted by any amount of correcting. They had to quit.
 *
 * 0.8 leaves a correction at four fifths of the level that raised it: 0.44
 * after a critical, 0.24 after a minor. Enough of a gap to stop it flickering,
 * small enough to be reachable by actually fixing the thing.
 */
export const RESOLVE_FRACTION = 0.8;

/**
 * Whether the student is moving with the class, as opposed to standing in a
 * shape that happens to match.
 *
 * Posture comparison cannot answer this for a repetitive exercise, and the
 * reason is geometric rather than a matter of tuning. A jumping jack passes
 * through "arms down, feet together" at the bottom of every repetition, which
 * is almost exactly what standing still looks like — so a motionless student
 * matches the bottom of every jack and scores well. Measured from a recorded
 * session: somebody standing completely still through six seconds of jumping
 * jacks scored a severity of 0.26 to 0.29, under the 0.30 that is worth even
 * mentioning. It took fifteen seconds to notice they had stopped, and only then
 * because the shapes drifted apart by luck.
 *
 * Movement separates them outright. Over a 1.2 second window, measured on the
 * same session:
 *
 *     the student, standing still      1.7 – 17 degrees of travel
 *     the instructor, jumping jacks     132 – 159 degrees
 *     ratio                             median 0.02, 90th percentile 0.07
 *
 * Fifty to one. Nothing in this app separates that cleanly, and it is available
 * a second after somebody stops rather than fifteen.
 */
export const MOTION_RATIO = 0.25;

/**
 * How much the instructor has to be moving before stillness means anything.
 *
 * During a rest, a held pose, or the instructor talking, the student is
 * supposed to be still, and faulting them for it would be the first bug all
 * over again. Only when the class is plainly in motion does standing still say
 * anything.
 */
export const MOTION_FLOOR_DEGREES = 40;

/**
 * The student's own shape travel over the same window.
 *
 * A short ring of recent shapes. Kept here rather than in the page because it
 * is the student's half of a measurement whose other half lives on the
 * instructor track, and the two want to be read together.
 */
export class MotionTracker {
  constructor({ window = MOTION_WINDOW_SECONDS } = {}) {
    this.window = window;
    this.reset();
  }

  reset() { this.history = []; }

  /**
   * One frame. Returns degrees of travel over the window, or null until there
   * is enough history to say.
   */
  observe(directions, atSeconds) {
    if (!directions) { this.reset(); return null; }
    const last = this.history[this.history.length - 1];
    if (last && atSeconds <= last.at) return this.travel();
    this.history.push({ at: atSeconds, directions });
    while (this.history.length > 2 && atSeconds - this.history[1].at >= this.window) {
      this.history.shift();
    }
    return this.travel();
  }

  travel() {
    if (this.history.length < 2) return null;
    const span = this.history[this.history.length - 1].at - this.history[0].at;
    if (span < this.window * 0.7) return null;
    let total = 0;
    for (let i = 1; i < this.history.length; i++) {
      total += shapeTravel(this.history[i - 1].directions, this.history[i].directions);
    }
    return total;
  }
}

/** Mean angle between two shapes, in degrees. */
function shapeTravel(a, b) {
  let total = 0, counted = 0;
  for (const name of SEGMENT_NAMES) {
    if (!a[name] || !b[name]) continue;
    const dot = Math.max(-1, Math.min(1, a[name].x * b[name].x + a[name].y * b[name].y
      + (a[name].z ?? 0) * (b[name].z ?? 0)));
    total += Math.acos(dot) * 180 / Math.PI;
    counted++;
  }
  return counted ? total / counted : 0;
}

/**
 * Is the student moving with the class?
 *
 * null when the question does not apply — the instructor is not moving much, or
 * the student has not been watched for long enough to say.
 */
export function movingWithClass(studentTravel, instructorTravel) {
  if (studentTravel == null) return null;
  if (!(instructorTravel > MOTION_FLOOR_DEGREES)) return null;
  return studentTravel / instructorTravel >= MOTION_RATIO;
}

/**
 * Which way round the student is, settled once instead of guessed every frame.
 *
 * A student following a video copies it like a mirror: the instructor's left
 * arm goes up, and the arm the student sees going up on screen is the one they
 * raise. Which anatomical arm that is depends on the person, so the comparison
 * scores both readings and keeps the better one.
 *
 * Re-deciding that every frame is the bug this exists to fix. Measured on a
 * recorded session of a real student doing jumping jacks: **1285 of 2287 frames
 * had the two readings within four points of each other**, because a jumping
 * jack is very nearly symmetric and at the top and bottom of it there is almost
 * nothing to tell left from right. So the reading flipped constantly — 3958
 * frames one way, 2419 the other — and the armature is drawn from it, which
 * made the guidance skeleton jump between two interpretations and never settle
 * on the one the student was actually in. They reported it as impossible to
 * correct against, which it was.
 *
 * Whether a student is mirrored is a fact about how they are standing, not
 * about the frame. It is established once, from accumulated evidence, and held.
 */
export class MirrorLock {
  constructor({ evidence = 90, perFrame = 6 } = {}) {
    this.evidence = evidence;
    this.perFrame = perFrame;
    this.reset();
  }

  reset() {
    this.weight = 0;
    this.locked = null;
  }

  /**
   * One frame of evidence. Returns the reading to use, or null while it is
   * still undecided — the caller should let the comparison choose for itself
   * until then.
   *
   * A single frame can move the total by at most `perFrame`, so the decision
   * cannot be carried by one lucky moment at the top of a jump; it takes a
   * sustained lead across many frames.
   */
  observe(scores) {
    if (this.locked !== null) return this.locked;
    if (!scores || !Number.isFinite(scores.direct) || !Number.isFinite(scores.mirrored)) {
      return null;
    }
    const lead = scores.mirrored - scores.direct;
    this.weight += Math.max(-this.perFrame, Math.min(this.perFrame, lead));
    if (Math.abs(this.weight) >= this.evidence) this.locked = this.weight > 0;
    return this.locked;
  }

  get value() { return this.locked; }
}

/**
 * Turns a stream of severities into a decision about whether to interrupt.
 *
 * Deliberately sluggish entering a fault and quick leaving one. The mocks are
 * explicit that the guidance should get out of the way the moment it is no
 * longer needed, and an interruption that arrives late is far cheaper than one
 * that arrives wrongly.
 */
export class PostureMonitor {
  constructor(options = {}) {
    this.critical = options.critical ?? CRITICAL_SEVERITY;
    this.minor = options.minor ?? MINOR_SEVERITY;
    this.criticalSustain = options.criticalSustain ?? CRITICAL_SUSTAIN_MS;
    this.minorSustain = options.minorSustain ?? MINOR_SUSTAIN_MS;
    this.recover = options.recover ?? RECOVER_MS;
    this.reset();
  }

  reset() {
    this.state = "ok";
    this.badSince = null;
    this.goodSince = null;
    this.lastSeverity = 0;
  }

  /**
   * One frame. Returns { state, changed }, where state is ok | minor |
   * critical.
   *
   * A severity of null means there is no verdict this frame, and there are two
   * reasons for that which must not be treated alike:
   *
   *   the user is not visible      hold the current state. Losing somebody is
   *                                not evidence about their posture, and a
   *                                correction raised a moment ago is probably
   *                                still true.
   *
   *   the class has no target      release. The instructor has moved on or is
   *     (`judging: false`)         mid-explanation, so whatever was being
   *                                corrected is no longer what is being asked
   *                                for. Holding a student in a paused, zoomed
   *                                correction while the class has moved past it
   *                                is the worst of both: wrong *and* stuck.
   *
   * Release recovers on the ordinary timer rather than instantly, so a
   * momentary gap in settled poses does not flicker the interface.
   */
  update(severity, now, { judging = true } = {}) {
    const was = this.state;
    if (!judging) {
      this.badSince = null;
      if (this.goodSince === null) this.goodSince = now;
      if (now - this.goodSince >= this.recover) this.state = "ok";
      return { state: this.state, changed: this.state !== was };
    }
    if (severity === null || severity === undefined) {
      return { state: this.state, changed: false };
    }
    this.lastSeverity = severity;

    // The bar to clear a correction is lower than the bar that raised it.
    const clearAt = this.state === "critical" ? this.critical * RESOLVE_FRACTION
      : this.state === "minor" ? this.minor * RESOLVE_FRACTION
      : this.minor;

    const belowCritical = severity > this.critical;
    const belowMinor = severity > clearAt;

    if (belowMinor) {
      this.goodSince = null;
      if (this.badSince === null) this.badSince = now;
      const held = now - this.badSince;
      if (belowCritical && held >= this.criticalSustain) this.state = "critical";
      else if (held >= this.minorSustain && this.state === "ok") this.state = "minor";
    } else {
      this.badSince = null;
      if (this.goodSince === null) this.goodSince = now;
      if (now - this.goodSince >= this.recover) this.state = "ok";
    }

    return { state: this.state, changed: this.state !== was };
  }
}
