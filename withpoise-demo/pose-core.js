/**
 * Pose measurement core.
 *
 * Every pure function the app measures with lives here: landmark indexing,
 * joint angle math, the body frame, segment directions, the reliability and
 * measurability tests, and the segment match. Nothing in this file touches the
 * DOM, a canvas or a worker, which is what lets `tests/` import it and pin its
 * behaviour down.
 *
 * Taken from the original app, which compared a body against an authored rig,
 * and cut back to what comparing one body against another needs — the rig
 * builder, the demo figure, the pose mirroring and the side selector went with
 * the pose library, about a third of the file. What stayed is everything that
 * describes a body without reference to a target, which turns out to be all of
 * the hard parts: `bodyFrame` and `segmentDirections` are what make two
 * differently proportioned people comparable at all, and `follow.js` is mostly
 * a thin policy layer over them.
 *
 * Coordinate spaces — these are not interchangeable and mixing them is the
 * easiest way to break this app:
 *
 *   image landmarks   x,y normalized to [0,1] over the video frame, z a
 *                     relative depth in roughly the same scale as x, plus
 *                     `visibility`. Says where the body is *in the picture*.
 *                     Framing, drawing and limb measurement use these.
 *
 *   world landmarks   metres, origin at the hip midpoint, axes aligned to the
 *                     camera. Says what shape the body *is*. Joint angles use
 *                     these.
 */

// ─────────────────────────────────────────────────────────────
// Landmark Indices
// ─────────────────────────────────────────────────────────────
export const LM = {
  nose: 0,
  left_shoulder: 11, right_shoulder: 12,
  left_elbow: 13, right_elbow: 14,
  left_wrist: 15, right_wrist: 16,
  left_hip: 23, right_hip: 24,
  left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28,
};

export const SKELETON = [
  ["left_shoulder","right_shoulder"],
  ["left_shoulder","left_elbow"],["left_elbow","left_wrist"],
  ["right_shoulder","right_elbow"],["right_elbow","right_wrist"],
  ["left_shoulder","left_hip"],["right_shoulder","right_hip"],
  ["left_hip","right_hip"],
  ["left_hip","left_knee"],["left_knee","left_ankle"],
  ["right_hip","right_knee"],["right_knee","right_ankle"],
];

// Below this visibility a landmark is a guess, not a measurement. The worker
// imports this too, so the `held` flag it sets and the `reliable` set computed
// here can never drift apart.
export const VIS_THRESHOLD = 0.5;

// ─────────────────────────────────────────────────────────────
// Angle Calculation
// ─────────────────────────────────────────────────────────────
/**
 * Angle at b between ba and bc, in 3D. Measuring in the image plane alone made
 * every angle depend on where the camera stood — a limb pointing towards the
 * lens looked bent no matter how straight it was. Including z removes that.
 */
export function calcAngle(a, b, c) {
  const ba = [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)];
  const bc = [c.x - b.x, c.y - b.y, (c.z ?? 0) - (b.z ?? 0)];
  const dot = ba[0]*bc[0] + ba[1]*bc[1] + ba[2]*bc[2];
  const magBA = Math.sqrt(ba[0]**2 + ba[1]**2 + ba[2]**2);
  const magBC = Math.sqrt(bc[0]**2 + bc[1]**2 + bc[2]**2);
  // Floor the divisor rather than padding it: adding an epsilon to the product
  // shrinks every cosine slightly, and by an amount that depends on how long
  // the limbs are, so a straight limb read 179.9° in pixels and 179.7° in
  // metres. Against targets that are mostly 175° that is a standing bias
  // toward "slightly bent". A floor leaves real magnitudes untouched and still
  // yields the same 90° for a degenerate zero-length segment.
  let cosAngle = dot / Math.max(magBA * magBC, 1e-12);
  cosAngle = Math.max(-1, Math.min(1, cosAngle));
  return Math.acos(cosAngle) * (180 / Math.PI);
}

// Which three landmarks form each scored joint angle.
export const ANGLE_JOINTS = {
  left_elbow:     ["left_shoulder", "left_elbow", "left_wrist"],
  right_elbow:    ["right_shoulder", "right_elbow", "right_wrist"],
  left_shoulder:  ["left_elbow", "left_shoulder", "left_hip"],
  right_shoulder: ["right_elbow", "right_shoulder", "right_hip"],
  left_hip:       ["left_shoulder", "left_hip", "left_knee"],
  right_hip:      ["right_shoulder", "right_hip", "right_knee"],
  left_knee:      ["left_hip", "left_knee", "left_ankle"],
  right_knee:     ["right_hip", "right_knee", "right_ankle"],
};

/**
 * Joint angles from a landmark array. Prefers MediaPipe's world landmarks:
 * they are metric and hip-centred, so the angles are anatomical rather than a
 * projection. Falls back to image landmarks scaled to pixels, which at least
 * keeps the three axes in comparable units.
 */
export function computeAngles(world, image, w, h) {
  let points;
  if (world) {
    points = (n) => world[LM[n]];
  } else {
    points = (n) => {
      const lm = image[LM[n]];
      return { x: lm.x * w, y: lm.y * h, z: (lm.z ?? 0) * w };
    };
  }

  const out = {};
  for (const [joint, [a, b, c]] of Object.entries(ANGLE_JOINTS)) {
    out[joint] = calcAngle(points(a), points(b), points(c));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Reliability
// ─────────────────────────────────────────────────────────────
/**
 * Landmarks we can actually trust this frame: confidently seen, not a held-over
 * guess, and inside the frame. Everything else is greyed out rather than scored.
 */
export function reliableLandmarks(landmarks) {
  const reliable = new Set();
  for (const name of Object.keys(LM)) {
    const lm = landmarks[LM[name]];
    if (!lm) continue;
    if (lm.held) continue;
    if ((lm.visibility ?? 1) < VIS_THRESHOLD) continue;
    if (lm.x < -0.02 || lm.x > 1.02 || lm.y < -0.02 || lm.y > 1.02) continue;
    reliable.add(name);
  }
  return reliable;
}

// ─────────────────────────────────────────────────────────────
// Pose Matching (single pose)
// ─────────────────────────────────────────────────────────────
// How far beyond its tolerance a joint has to go before it counts for nothing.
// Inside tolerance a joint is simply correct; past tolerance + margin it is
// simply wrong; in between the score slides.
export const FALLOFF_MARGIN = 25;

/**
 * How right a joint is, from 1 to 0.
 *
 * The old answer was a boolean, and the boundary showed. A knee resting on its
 * tolerance flipped the outline red and green frame to frame, and each flip
 * moved the total by a full eighth. Worse, it made every degree inside the
 * tolerance worth nothing and the first degree outside it worth everything,
 * which is not how a body works.
 *
 * Smoothstep rather than a straight line, so the curve is flat where it meets 1
 * and flat where it meets 0: no kink at either end for the score to catch on.
 */
export function jointQuality(diff, tolerance, margin = FALLOFF_MARGIN) {
  if (diff <= tolerance) return 1;
  if (margin <= 0) return 0;
  const t = Math.min(1, (diff - tolerance) / margin);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Score only the joints we can actually judge. A joint is set aside for one of
 * two different reasons, and the difference matters to the user:
 *
 *   unscored   its landmarks are off-screen or occluded — "step back"
 *   uncertain  it is pointing down the camera axis — "turn side-on"
 *
 * Neither helps nor hurts the score. That is what lets tracking carry on with
 * your feet out of shot, and what stops the app inventing a fault out of the
 * one coordinate it cannot see.
 *
 * Joints carry weights, because they are not equally the pose. Tree is about a
 * straight standing leg and level hips; the elbow is decoration. An unweighted
 * mean says otherwise and lets a good pose be dragged down by a detail.
 *
 * `coverage` is the share of the pose's total weight that was actually judged.
 * A score is a fraction of what could be seen, so without coverage beside it a
 * user with their legs out of frame reads 100% for holding half a pose.
 *
 * opts: { reliable: Set<string>, measurability: object,
 *         weights: { [joint]: number }, margin: number }
 */
export function matchSinglePose(angles, template, opts = {}) {
  const { reliable = null, measurability = null, weights = null,
          margin = FALLOFF_MARGIN } = opts;
  const results = {};
  const unscored = [];
  const uncertain = [];
  const weightOf = (joint) => (weights && weights[joint] != null ? weights[joint] : 1);

  let correct = 0, total = 0;
  let earned = 0, judgedWeight = 0, totalWeight = 0;

  for (const [joint, [target, tolerance]] of Object.entries(template)) {
    if (!(joint in angles)) continue;

    // A weight of zero is a pose saying "this joint is not part of me". It is
    // then not scored, not counted in coverage, not coloured on the outline and
    // never corrected — anything less than all of those and the user is still
    // being told to move a joint the pose does not care about.
    if (weightOf(joint) === 0) continue;
    totalWeight += weightOf(joint);

    if (reliable) {
      const needed = ANGLE_JOINTS[joint] || [];
      if (!needed.every(name => reliable.has(name))) {
        unscored.push(joint);
        continue;
      }
    }

    if (measurability && measurability[joint] && !measurability[joint].measurable) {
      uncertain.push(joint);
      continue;
    }

    total++;
    const actual = angles[joint];
    const diff = Math.abs(actual - target);
    const ok = diff <= tolerance;
    const direction = actual - target;
    const quality = jointQuality(diff, tolerance, margin);
    const weight = weightOf(joint);

    results[joint] = { actual, target, tolerance, diff, ok, direction, quality, weight };
    if (ok) correct++;
    earned += quality * weight;
    judgedWeight += weight;
  }

  const score = judgedWeight > 0 ? (earned / judgedWeight) * 100 : 0;
  return {
    score, results, unscored, uncertain, scored: total,
    aligned: correct,
    coverage: totalWeight > 0 ? judgedWeight / totalWeight : 0,
    judgedWeight, totalWeight,
  };
}

// ─────────────────────────────────────────────────────────────
// Camera geometry
//
// World landmarks are metric and hip-centred, but their axes are the camera's:
// x right, y down, z away from the lens. So the pose is described in a frame
// that moves when the user turns, even though the body has not changed shape.
//
// Joint angles are already immune to that — an angle is rotation-invariant, and
// tests/scoring.test.js proves ours is, exactly, for any rigid turn. What is
// *not* immune is the depth axis itself: MediaPipe regresses z from a single
// RGB image, and it is much the least certain of the three. A limb lying along
// the camera axis has its direction decided almost entirely by that number.
//
// That is the real view-dependence, and it cannot be rotated away. What can be
// done is to notice it, and to say "can't tell" instead of scoring a guess.
// ─────────────────────────────────────────────────────────────

export const v3 = {
  sub:   (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) }),
  scale: (a, k) => ({ x: a.x * k, y: a.y * k, z: (a.z ?? 0) * k }),
  dot:   (a, b) => a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0),
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  len:  (a) => Math.hypot(a.x, a.y, a.z ?? 0),
  unit: (a) => { const n = Math.hypot(a.x, a.y, a.z ?? 0); return n < 1e-12 ? { x: 0, y: 0, z: 0 } : { x: a.x / n, y: a.y / n, z: (a.z ?? 0) / n }; },
  mid:  (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 }),
};

/**
 * An orthonormal frame rigidly attached to the torso, built from the hip and
 * shoulder vectors:
 *
 *   spine    hips → shoulders, up the body
 *   lateral  right hip → left hip, made perpendicular to the spine
 *   forward  out of the chest
 *
 * `facing` is how squarely the chest points at the lens: 1 when the user is
 * head-on (or backs-on — the camera cannot tell, and for measurability it does
 * not matter), 0 when they are edge-on. `turnDegrees` is the same thing in
 * degrees off-axis, which is what you would say out loud to a person.
 *
 * A body whose hips have collapsed onto each other yields a zero frame, which
 * reads as fully edge-on — the safe direction to fail in, since it makes the
 * app say "I can't see this" rather than score noise.
 */
export function bodyFrame(world) {
  const P = (n) => world[LM[n]];
  const hipC = v3.mid(P("left_hip"), P("right_hip"));
  const shC  = v3.mid(P("left_shoulder"), P("right_shoulder"));

  const spine = v3.unit(v3.sub(shC, hipC));
  const hipAxis = v3.unit(v3.sub(P("left_hip"), P("right_hip")));
  // Gram-Schmidt: the hip axis is not quite perpendicular to the spine on a
  // real body, and the frame has to be orthonormal to be a rotation.
  const lateral = v3.unit(v3.sub(hipAxis, v3.scale(spine, v3.dot(hipAxis, spine))));
  const forward = v3.unit(v3.cross(lateral, spine));

  const facing = Math.min(1, Math.abs(forward.z));
  return {
    origin: hipC, spine, lateral, forward, facing,
    turnDegrees: Math.acos(facing) * 180 / Math.PI,
  };
}

export const AXIS_LIMIT = 0.65;

export function depthShare(vector, frame) {
  const n = v3.len(vector);
  if (n < 1e-9) return 1;   // a collapsed segment tells us nothing
  const cosTurn = frame.facing;
  const sinTurn = Math.sqrt(Math.max(0, 1 - frame.facing * frame.facing));
  const alongCamera = sinTurn * v3.dot(vector, frame.lateral) +
                      cosTurn * v3.dot(vector, frame.forward);
  return Math.abs(alongCamera) / n;
}

export function jointMeasurability(world, frame) {
  const f = frame || bodyFrame(world);
  const depthShare_ = (v) => depthShare(v, f);

  const out = {};
  for (const [joint, [a, b, c]] of Object.entries(ANGLE_JOINTS)) {
    const pb = world[LM[b]];
    const share = Math.max(
      depthShare_(v3.sub(world[LM[a]], pb)),
      depthShare_(v3.sub(world[LM[c]], pb)),
    );
    out[joint] = { depthShare: share, measurable: share <= AXIS_LIMIT };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Segment directions
//
// A joint angle says how bent a limb is. It says nothing about where the limb
// points, because an angle is invariant to rotation — which is why a knee can
// collapse 13cm inward, or both arms swing 90° forward, without moving any of
// the eight numbers the app scored.
//
// The rig has always described each segment's *direction*. Those directions
// were used to derive the target angles and then discarded. Scoring them is
// strictly more information, and it is the same information a teacher uses.
// ─────────────────────────────────────────────────────────────

/** Landmark names, plus the two midpoints that behave like landmarks. */
export function landmarkPoint(world, name) {
  if (name === "shoulder_centre") return v3.mid(world[LM.left_shoulder], world[LM.right_shoulder]);
  if (name === "hip_centre") return v3.mid(world[LM.left_hip], world[LM.right_hip]);
  return world[LM[name]];
}

/** Every landmark a named point actually depends on. */
export function pointDependencies(name) {
  if (name === "shoulder_centre") return ["left_shoulder", "right_shoulder"];
  if (name === "hip_centre") return ["left_hip", "right_hip"];
  return [name];
}

export const SEGMENTS = {
  torso:           ["hip_centre", "shoulder_centre"],
  upper_arm_left:  ["left_shoulder", "left_elbow"],
  upper_arm_right: ["right_shoulder", "right_elbow"],
  forearm_left:    ["left_elbow", "left_wrist"],
  forearm_right:   ["right_elbow", "right_wrist"],
  thigh_left:      ["left_hip", "left_knee"],
  thigh_right:     ["right_hip", "right_knee"],
  shin_left:       ["left_knee", "left_ankle"],
  shin_right:      ["right_knee", "right_ankle"],
};

export const SEGMENT_NAMES = Object.keys(SEGMENTS);

/**
 * Each segment's direction, as a unit vector in the body's own frame.
 *
 * The body frame is what makes this comparable at all: it is built from the
 * user's hips and shoulders, so it turns with them. A pose held correctly
 * produces the same directions whether the user faces the camera or stands at
 * 30° to it, which is the invariance the app already has and must not lose.
 */
export function segmentDirections(world, frame) {
  const f = frame || bodyFrame(world);
  const out = {};
  for (const [name, [from, to]] of Object.entries(SEGMENTS)) {
    const vector = v3.sub(landmarkPoint(world, to), landmarkPoint(world, from));
    if (v3.len(vector) < 1e-9) { out[name] = null; continue; }
    out[name] = {
      // In the body frame: lateral, up the spine, out of the chest.
      x: v3.dot(vector, f.lateral),
      y: v3.dot(vector, f.spine),
      z: v3.dot(vector, f.forward),
      // Kept in camera coordinates too, because how well the camera resolved
      // this segment is a question about the camera, not about the body.
      camera: vector,
    };
  }
  for (const name of SEGMENT_NAMES) {
    if (out[name]) {
      const d = out[name];
      const n = Math.hypot(d.x, d.y, d.z) || 1;
      out[name] = { x: d.x / n, y: d.y / n, z: d.z / n, camera: d.camera };
    }
  }
  return out;
}

// How much less a depth error counts than an in-plane one.
//
// From the error profile rather than from taste. MediaPipe's z is roughly four
// times noisier than its x and y, so a given displacement along the camera axis
// is worth about a quarter of the same displacement across the image as
// evidence. Errors are scaled into "in-plane-equivalent" degrees by this
// before being judged, which lets one tolerance cover both.
//
// Note what this is not: it is not zero. Projecting the depth component away
// entirely was the first attempt and it fails on the most important fault
// there is. Warrior I holds its legs spread in the frontal plane, so a knee
// collapsing inward travels toward the camera — 20° of direction error, all of
// it in depth. Discarding depth discards the fault. A knee 13cm out of place
// against 4.6cm of depth noise is a three-sigma signal; attenuated, not
// deleted.
export const DEPTH_TRUST = 0.25;

/**
 * How far an observed segment points from where it should, in degrees,
 * discounted by how well the camera can resolve the direction it moved.
 *
 * The error between the two unit directions is split into the part across the
 * image and the part along the camera axis. The first is measured; the second
 * is largely inferred, so it is scaled by DEPTH_TRUST before the two are
 * recombined. The result is in the units of an in-plane error, which is what
 * makes a single tolerance meaningful.
 *
 * `resolved` reports how much of the *target* direction lies across the image.
 * A segment pointing almost straight down the lens has nothing left to compare
 * and is reported unmeasurable rather than scored — the same answer, for the
 * same reason, as the joint gate gives.
 */
export function directionError(observed, target, frame) {
  if (!observed || !target) return { degrees: 0, resolved: 0, measurable: false };

  // The camera axis in body coordinates. Same reconstruction as depthShare:
  // sin(turn) along lateral plus cos(turn) along forward, using the body frame
  // rather than the raw z, because the raw z is what depth compression eats.
  const cosTurn = frame.facing;
  const sinTurn = Math.sqrt(Math.max(0, 1 - frame.facing * frame.facing));
  const axis = { x: sinTurn, y: 0, z: cosTurn };

  const error = {
    x: observed.x - target.x,
    y: observed.y - target.y,
    z: observed.z - target.z,
  };
  const along = error.x * axis.x + error.y * axis.y + error.z * axis.z;
  const across = Math.hypot(
    error.x - along * axis.x,
    error.y - along * axis.y,
    error.z - along * axis.z,
  );

  // Chord length back to an angle: two unit vectors |e| apart subtend
  // 2·asin(|e|/2).
  const discounted = Math.hypot(across, along * DEPTH_TRUST);
  const degrees = 2 * Math.asin(Math.min(1, discounted / 2)) * 180 / Math.PI;

  const targetAlong = target.x * axis.x + target.y * axis.y + target.z * axis.z;
  const resolved = Math.sqrt(Math.max(0, 1 - targetAlong * targetAlong));

  return { degrees, resolved, measurable: resolved >= RESOLVED_LIMIT };
}

// How much of a segment has to survive the projection onto the image plane
// before its direction is worth scoring.
//
// A segment resolving 0.4 lies 66° from the camera axis. Below that almost
// nothing of where it points is visible across the image, the comparison rests
// on the depth estimate alone, and the honest answer is "can't tell" — the same
// answer, for the same reason, as the joint gate's AXIS_LIMIT.
export const RESOLVED_LIMIT = 0.4;

// How far a segment may point from its target and still be called correct.
//
// Set from the measured separation, through the smoothing the app applies. Per
// segment, on Warrior I:
//
//     a correct pose under the noise model     0.7 – 1.5°
//     the same pose seen 30° off-axis          1.3 – 1.9°
//     a knee collapsed 30° inward              7.1°  (thigh and shin both)
//     the same at 45°                         13.3°
//     a pelvis yawed 30°                       6.0 – 11.0°
//
// 4° sits at 2.7× the noise floor and well under half the smallest fault. It
// is far tighter than the 20–30° the joint angles carry and it can be: those
// measure a quantity that is mostly depth noise, and this one is conditioned on
// what the camera resolves before it is judged.
//
// The honest caveat is that the noise floor above comes from the suite's model
// of landmark error, not from a real body. If real jitter is worse, this is the
// number to revisit first.
export const DIRECTION_TOLERANCE = 4;

export const SEGMENT_PARTS = {
  torso:           { part: "chest", side: null },
  upper_arm_left:  { part: "left elbow", side: "left" },
  upper_arm_right: { part: "right elbow", side: "right" },
  forearm_left:    { part: "left hand", side: "left" },
  forearm_right:   { part: "right hand", side: "right" },
  thigh_left:      { part: "left knee", side: "left" },
  thigh_right:     { part: "right knee", side: "right" },
  shin_left:       { part: "left foot", side: "left" },
  shin_right:      { part: "right foot", side: "right" },
};

/**
 * What to do about a segment pointing the wrong way, as an instruction.
 *
 * Derived rather than tabulated: the correction is the direction the far end
 * has to travel, expressed in the body's own frame, and only the dominant axis
 * is named. One thing to do at a time is the standing rule of the coaching
 * layer and it applies just as much here.
 *
 * "Out" and "in" are relative to the body's midline, so they mean the same
 * thing for a left limb and a right one — which is what makes the phrasing
 * work without a table of special cases.
 */
export function segmentCorrection(name, observed, target) {
  const meta = SEGMENT_PARTS[name];
  if (!meta || !observed || !target) return null;

  const delta = { x: target.x - observed.x, y: target.y - observed.y, z: target.z - observed.z };
  const axes = [
    { size: Math.abs(delta.x), axis: "lateral", positive: delta.x > 0 },
    { size: Math.abs(delta.y), axis: "vertical", positive: delta.y > 0 },
    { size: Math.abs(delta.z), axis: "forward", positive: delta.z > 0 },
  ].sort((a, b) => b.size - a.size);

  const dominant = axes[0];
  let where;
  if (dominant.axis === "vertical") {
    where = dominant.positive ? "higher" : "lower";
  } else if (dominant.axis === "forward") {
    where = dominant.positive ? "forward" : "back";
  } else {
    // The body's lateral axis points to its own left, so which way is "out"
    // depends on which side the limb is on.
    const outward = meta.side === "right" ? !dominant.positive : dominant.positive;
    where = outward ? "further out to the side" : "in towards your midline";
  }

  const verb = dominant.axis === "vertical" && dominant.positive ? "Lift" : "Take";
  return `${verb} your ${meta.part} ${where}`;
}

/**
 * Name the fault, where several segments are telling one story.
 *
 * A segment-by-segment reading is accurate and is not always what a person can
 * act on. Yawing a pelvis moves both thighs and leaves the torso untouched — it
 * is measured on the legs and it is not a leg problem — so reporting "take your
 * left knee forward" is true, useless, and would have them chasing the symptom.
 *
 * Two patterns, each with a signature distinct enough to read off the segments:
 *
 *   hips not square   both thighs *moved*, in opposite senses. Yawing the
 *                     pelvis swings one hip forward and the other back, so one
 *                     thigh drifts towards the camera and the other away, while
 *                     the torso, rotating with the pelvis, does not move at all.
 *
 *                     Moved, not failed. Requiring both thighs to breach
 *                     tolerance only works from a square stance: a yaw of 35°
 *                     measured against this class drifts the front thigh two to
 *                     six times as far as the back one, so in any lunge or wide
 *                     stance exactly one of them fails and the pattern was
 *                     missed — the app then named the thigh it could see, which
 *                     is the symptom. The drift pair is the signature, and it
 *                     held at every point in the class that was checked.
 *   knee tracking     one leg only, thigh and shin moved in opposite senses —
 *                     the signature of a knee swinging about the line from hip
 *                     to ankle while the foot stays planted.
 *
 * Anything else keeps its own per-segment instruction.
 */
export function recogniseFaults(results, observed, targets) {
  const failing = (name) => results[name] && !results[name].ok;
  const drift = (name) => (observed[name] && targets[name])
    ? observed[name].z - targets[name].z : 0;
  const worst = (names) => names
    .map(n => results[n])
    .filter(Boolean)
    .sort((a, b) => a.quality - b.quality)[0];

  const found = [];

  // Clear of the drift a correct pose shows through smoothed landmark noise,
  // and well clear of zero, which is what the opposite thigh does under a knee
  // fault — valgus swings one knee about its own hip-to-ankle line and leaves
  // the other leg untouched to three decimal places.
  const YAW_DRIFT = 0.025;
  const thighDrift = [drift("thigh_left"), drift("thigh_right")];
  const bothThighsYawed = thighDrift[0] * thighDrift[1] < 0
    && Math.abs(thighDrift[0]) > YAW_DRIFT && Math.abs(thighDrift[1]) > YAW_DRIFT;

  // The drift pair identifies the yaw; this only asks whether anything is
  // actually wrong enough to mention. It looks at the shins as well as the
  // thighs because which of the four carries the breach depends on the stance —
  // from the square standing posture early in this class a 35° yaw drifts both
  // thighs plainly and yet breaches on neither, surfacing on the shins instead.
  const LEGS = ["thigh_left", "thigh_right", "shin_left", "shin_right"];
  if (bothThighsYawed && LEGS.some(failing)) {
    const source = worst(LEGS.filter(failing));
    found.push({
      joint: "pelvis",
      text: "Square your hips towards the front",
      weight: source.weight, quality: source.quality,
      explains: ["thigh_left", "thigh_right"],
    });
    return found;
  }

  for (const side of ["left", "right"]) {
    const thigh = `thigh_${side}`, shin = `shin_${side}`;
    if (!failing(thigh) || !failing(shin)) continue;
    if (drift(thigh) * drift(shin) >= 0) continue;      // not a rotation about the leg
    const source = worst([thigh, shin]);
    found.push({
      joint: thigh,
      // "Track" rather than "take": it is the word a teacher uses for a knee,
      // and the direction is still the derived one rather than an assumption
      // that every knee fault is an inward collapse.
      text: (segmentCorrection(thigh, observed[thigh], targets[thigh]) || "")
        .replace(/^Take your /, "Track your ").replace(/^Lift your /, "Track your "),
      weight: source.weight, quality: source.quality,
      explains: [thigh, shin],
    });
  }

  return found;
}

/**
 * Score every segment direction against its target.
 *
 * Deliberately the same shape as matchSinglePose, because it is the same idea
 * applied to a different measurement, and the two are summed into one score.
 *
 * opts: { specs: { [segment]: { tolerance, weight } }, margin, reliable }
 */
export function matchSegments(observed, targets, frame, opts = {}) {
  const { specs = {}, margin = FALLOFF_MARGIN, reliable = null } = opts;
  const results = {};
  const unscored = [];
  const uncertain = [];

  for (const name of SEGMENT_NAMES) {
    const target = targets && targets[name];
    if (!target) continue;

    const spec = specs[name] || specs.default || {};
    const weight = spec.weight ?? 1;
    if (weight === 0) continue;

    if (reliable) {
      const needed = SEGMENTS[name].flatMap(pointDependencies);
      if (!needed.every(n => reliable.has(n))) { unscored.push(name); continue; }
    }

    const seen = observed && observed[name];
    if (!seen) { unscored.push(name); continue; }

    const error = directionError(seen, target, frame);
    if (!error.measurable) { uncertain.push(name); continue; }

    // Widen the tolerance for a segment the camera can only half see.
    //
    // `resolved` is the fraction of the target direction lying across the
    // image. At 1 the whole direction is visible and the tolerance is the
    // measured one; at 0.5 half of it is inferred and the residual is
    // correspondingly less certain, so the bar moves with it. Without this a
    // marginally-resolved segment is held to a standard its measurement cannot
    // support, and a correct pose seen from an awkward angle reads as a fault —
    // which is the exact failure this whole approach exists to avoid.
    const base = spec.tolerance ?? DIRECTION_TOLERANCE;
    const tolerance = base / Math.max(error.resolved, RESOLVED_LIMIT);

    results[name] = {
      degrees: error.degrees,
      resolved: error.resolved,
      tolerance,
      weight,
      quality: jointQuality(error.degrees, tolerance, margin),
      ok: error.degrees <= tolerance,
      correction: segmentCorrection(name, seen, target),
    };
  }

  return { results, unscored, uncertain };
}

export const along = (from, dist, dir) => ({
  x: from.x + dist * dir.x,
  y: from.y + dist * dir.y,
  z: (from.z || 0) + dist * dir.z,
});

const Z_TUNING = { minCutoff: 0.35, beta: 0.10, dCutoff: 1.0 };

export const TUNING = {
  image: { minCutoff: 1.1, beta: 0.35, dCutoff: 1.0, z: Z_TUNING },
  world: { minCutoff: 1.1, beta: 0.30, dCutoff: 1.0, z: Z_TUNING },
};

export const NUM_LANDMARKS = 33;

// ─────────────────────────────────────────────────────────────
// One Euro Filter
// ─────────────────────────────────────────────────────────────
class LowPass {
  constructor() { this.y = null; }
  filter(x, alpha) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  get value() { return this.y; }
}

export class OneEuroFilter {
  constructor({ minCutoff, beta, dCutoff }) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.tPrev = null;
    this.xPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** Feed a trusted measurement. Returns the smoothed value. */
  filter(value, tSeconds) {
    if (this.tPrev === null) {
      this.tPrev = tSeconds;
      this.xPrev = value;
      return this.x.filter(value, 1);
    }
    const dt = Math.min(0.5, Math.max(1 / 240, tSeconds - this.tPrev));
    this.tPrev = tSeconds;

    const dValue = (value - this.xPrev) / dt;
    this.xPrev = value;
    const dHat = this.dx.filter(dValue, OneEuroFilter.alpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(dHat);
    return this.x.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  /**
   * No trustworthy measurement this frame: hold the smoothed history rather
   * than tracking a guessed landmark. Returns null if nothing has been seen yet.
   */
  hold(tSeconds) {
    if (this.x.value === null) return null;
    this.tPrev = tSeconds;   // so the next real sample sees a sane dt
    return this.x.value;
  }
}

/** A filter triple per landmark, for one coordinate space. */
export function makeFilters(tuning) {
  const depth = tuning.z || tuning;      // no z block means treat all three alike
  return Array.from({ length: NUM_LANDMARKS }, () => ({
    x: new OneEuroFilter(tuning),
    y: new OneEuroFilter(tuning),
    z: new OneEuroFilter(depth),
  }));
}

/**
 * Smooth one landmark array. Landmarks below the visibility threshold keep
 * their last smoothed position and come back flagged `held`.
 */
export function smooth(points, filters, tSeconds, visibilities) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const f = filters[i];
    const visibility = visibilities ? visibilities[i] : (p.visibility ?? 1);
    const trusted = visibility >= VIS_THRESHOLD;

    if (trusted) {
      out.push({
        x: f.x.filter(p.x, tSeconds),
        y: f.y.filter(p.y, tSeconds),
        z: f.z.filter(p.z ?? 0, tSeconds),
        visibility,
        held: false,
      });
    } else {
      const hx = f.x.hold(tSeconds), hy = f.y.hold(tSeconds), hz = f.z.hold(tSeconds);
      const seen = hx !== null;
      out.push({
        x: seen ? hx : p.x,
        y: seen ? hy : p.y,
        z: seen ? hz : (p.z ?? 0),
        visibility,
        held: true,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Hysteresis
// ─────────────────────────────────────────────────────────────
/**
 * Latched per-joint verdicts, so the outline stops strobing.
 *
 * The score is smooth now, but the outline is still binary — deliberately, a
 * limb is either where it should be or it is not, and a limb fading through
 * amber says nothing useful at arm's length. A single threshold on a joint
 * sitting exactly on tolerance flickers at frame rate, which is worse than
 * either colour.
 *
 * So the verdict is latched: a joint has to be clearly right to turn green and
 * clearly wrong to turn red again, and in the gap between it keeps whatever it
 * last was. Driven by the graded quality rather than the raw boolean, which is
 * what gives the gap a width.
 */
export class VerdictLatch {
  constructor({ enter = 0.95, leave = 0.55 } = {}) {
    this.enter = enter;
    this.leave = leave;
    this.state = new Map();
  }

  reset() { this.state.clear(); }

  /**
   * Returns a copy of `results` with `ok` replaced by the latched verdict.
   * Joints missing from this frame keep their state, so a joint that drops out
   * for a frame and comes back does not flash.
   */
  apply(results) {
    const out = {};
    for (const [joint, res] of Object.entries(results)) {
      const was = this.state.get(joint);
      let now;
      if (res.quality >= this.enter) now = true;
      else if (res.quality <= this.leave) now = false;
      else now = was === undefined ? res.ok : was;
      this.state.set(joint, now);
      out[joint] = { ...res, ok: now };
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────
// Frame processing
// ─────────────────────────────────────────────────────────────
/**
 * One detection, start to finish, with the MediaPipe landmarker injected.
 *
 * Lives here rather than in the worker so its central promise can be tested:
 * **every call posts exactly one result**. The main thread sends one frame at a
 * time and waits for the reply, so a path that returns without replying wedges
 * the app permanently — no further frame is sent, and the render loop paints
 * the last result it has forever. A frozen skeleton, scored as live, with no
 * error raised anywhere. Two such paths existed.
 */
export class FrameProcessor {
  constructor(tuning = TUNING) {
    this.tuning = tuning;
    this.reset();
  }

  reset() {
    this.imageFilters = makeFilters(this.tuning.image);
    this.worldFilters = makeFilters(this.tuning.world);
    this.lastTimestamp = 0;
  }

  /**
   * deps: { landmarker, post, now }
   *   landmarker  anything with detectForVideo(bitmap, ts); may be null or throw
   *   post        receives exactly one { type: "result", ... }, plus a
   *               { type: "status", state: "error" } first if detection threw
   *   now         monotonic milliseconds, injected so tests can control it
   */
  process({ bitmap, timestamp }, { landmarker, post, now }) {
    // detectForVideo demands strictly increasing timestamps.
    const ts = timestamp > this.lastTimestamp ? timestamp : this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    const close = () => { try { bitmap && bitmap.close && bitmap.close(); } catch { /* ignore */ } };

    if (!landmarker) {
      close();
      post({ type: "result", timestamp: ts, detected: false, inference: 0 });
      return;
    }

    const startedAt = now();
    let result = null;
    try {
      result = landmarker.detectForVideo(bitmap, ts);
    } catch (err) {
      post({ type: "status", state: "error",
             message: err && err.message ? err.message : String(err) });
      post({ type: "result", timestamp: ts, detected: false, inference: 0 });
      return;
    } finally {
      close();
    }

    const inference = now() - startedAt;
    const tSeconds = ts / 1000;

    if (!(result && result.landmarks && result.landmarks.length)) {
      post({ type: "result", timestamp: ts, detected: false, inference });
      return;
    }

    const image = result.landmarks[0];
    const visibilities = image.map(p => p.visibility ?? 1);
    const world = (result.worldLandmarks && result.worldLandmarks[0]) || null;

    post({
      type: "result",
      timestamp: ts,
      detected: true,
      inference,
      landmarks: smooth(image, this.imageFilters, tSeconds, visibilities),
      // World landmarks are metric and origin-centred on the hips — the right
      // input for view-independent joint angles.
      world: world ? smooth(world, this.worldFilters, tSeconds, visibilities) : null,
    });
  }
}
