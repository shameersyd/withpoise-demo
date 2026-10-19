/**
 * Drawing one person's posture on another person's body.
 *
 * This is the whole idea of the overlay, and it is worth being precise about
 * why it is possible at all. The user is in a different room, at a different
 * distance, with a different build. None of their pixels belong on this screen
 * and neither do their coordinates.
 *
 * What does transfer is the *direction* each limb points in the body's own
 * frame — "the upper arm leaves the shoulder 40° out from the spine" means the
 * same thing for both bodies. Rebuilding the user's pose from the instructor's
 * joints, at the instructor's limb lengths, puts the two shapes in one place
 * where the only visible thing is the difference between them.
 *
 * Everything here works in normalised frame coordinates (0–1 across the video),
 * which is what the instructor trace stores and what the overlay canvas maps
 * linearly onto its stage.
 */

import { LM } from "./pose-core.js";

/** The instructor's traced landmarks, keyed by name. */
export function instructorPoints(image) {
  const out = {};
  for (const name of Object.keys(LM)) out[name] = image[LM[name]];
  return out;
}

/** Which joint sits at the far end of each segment — the end an arrow points at. */
export const SEGMENT_END = {
  torso: "nose",
  upper_arm_left: "left_elbow", upper_arm_right: "right_elbow",
  forearm_left: "left_wrist", forearm_right: "right_wrist",
  thigh_left: "left_knee", thigh_right: "right_knee",
  shin_left: "left_ankle", shin_right: "right_ankle",
};

/**
 * The instructor's body as a 2D frame: where the hips are, which way is up the
 * spine, and which way is the body's own left.
 *
 * The lateral axis is taken from the hips and then made perpendicular to the
 * spine, because on a real body they are not quite square and a skewed frame
 * puts every limb slightly wrong.
 */
export function imageFrame(points) {
  const hip = { x: (points.left_hip.x + points.right_hip.x) / 2,
                y: (points.left_hip.y + points.right_hip.y) / 2 };
  const shoulder = { x: (points.left_shoulder.x + points.right_shoulder.x) / 2,
                     y: (points.left_shoulder.y + points.right_shoulder.y) / 2 };

  const up = { x: shoulder.x - hip.x, y: shoulder.y - hip.y };
  const torso = Math.hypot(up.x, up.y);
  if (!(torso > 1e-6)) return null;
  up.x /= torso; up.y /= torso;

  let side = { x: points.left_hip.x - points.right_hip.x,
               y: points.left_hip.y - points.right_hip.y };
  const along = side.x * up.x + side.y * up.y;
  side = { x: side.x - along * up.x, y: side.y - along * up.y };
  const width = Math.hypot(side.x, side.y);
  if (!(width > 1e-9)) return null;
  side.x /= width; side.y /= width;

  return { hip, shoulder, up, side, torso };
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Build the follower's skeleton on the instructor's body.
 *
 * `directions` are the user's segment directions in their own body frame.
 * `mirrored` says the comparison matched them left-for-right, in which case so
 * must the drawing, or the picture will contradict the score.
 *
 * Depth is dropped. It is not visible on a flat screen and it is the axis the
 * camera knows least about; drawing a limb shorter because it points away would
 * read as a fault the user has not committed.
 */
export function buildFollowerPoints(directions, image, mirrored = false) {
  if (!directions) return null;
  const reference = instructorPoints(image);
  const frame = imageFrame(reference);
  if (!frame) return null;

  const { hip, up, side, torso } = frame;
  const place = (from, direction, length) => {
    if (!direction || !from) return null;
    const lateral = mirrored ? -direction.x : direction.x;
    return {
      x: from.x + length * (lateral * side.x + direction.y * up.x),
      y: from.y + length * (lateral * side.y + direction.y * up.y),
    };
  };

  const halfShoulder = distance(reference.left_shoulder, reference.right_shoulder) / 2;
  const halfHip = distance(reference.left_hip, reference.right_hip) / 2;
  const shoulderMid = place(hip, directions.torso, torso) || frame.shoulder;

  const out = {
    left_hip: { x: hip.x + halfHip * side.x, y: hip.y + halfHip * side.y },
    right_hip: { x: hip.x - halfHip * side.x, y: hip.y - halfHip * side.y },
    left_shoulder: { x: shoulderMid.x + halfShoulder * side.x,
                     y: shoulderMid.y + halfShoulder * side.y },
    right_shoulder: { x: shoulderMid.x - halfShoulder * side.x,
                      y: shoulderMid.y - halfShoulder * side.y },
  };
  out.nose = place(shoulderMid, directions.torso, torso * 0.42) || shoulderMid;

  for (const which of ["left", "right"]) {
    const elbow = place(out[`${which}_shoulder`], directions[`upper_arm_${which}`],
                        distance(reference[`${which}_shoulder`], reference[`${which}_elbow`]));
    out[`${which}_elbow`] = elbow;
    out[`${which}_wrist`] = place(elbow, directions[`forearm_${which}`],
                                  distance(reference[`${which}_elbow`], reference[`${which}_wrist`]));

    const knee = place(out[`${which}_hip`], directions[`thigh_${which}`],
                       distance(reference[`${which}_hip`], reference[`${which}_knee`]));
    out[`${which}_knee`] = knee;
    out[`${which}_ankle`] = place(knee, directions[`shin_${which}`],
                                  distance(reference[`${which}_knee`], reference[`${which}_ankle`]));
  }
  return out;
}

/**
 * Each segment's direction in the body's own 2D frame, read off a picture of
 * it: x toward the body's left, y up the spine. A segment with an end the
 * camera could not see is left out, and is then not drawn.
 *
 * `points` must be in square units — x and y on the same scale — or every
 * angle is stretched by the frame's aspect ratio.
 */
export function imageDirections(points, minVisibility = 0.5) {
  const frame = imageFrame(points);
  if (!frame) return null;
  const { up, side } = frame;
  const seen = (p) => !!p && (p.visibility ?? 1) >= minVisibility;
  const direction = (from, to) => {
    if (!seen(from) || !seen(to)) return null;
    const v = { x: to.x - from.x, y: to.y - from.y };
    const x = v.x * side.x + v.y * side.y;
    const y = v.x * up.x + v.y * up.y;
    const length = Math.hypot(x, y);
    return length > 1e-9 ? { x: x / length, y: y / length } : null;
  };
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const out = {
    torso: direction(mid(points.left_hip, points.right_hip),
                     mid(points.left_shoulder, points.right_shoulder)),
  };
  for (const which of ["left", "right"]) {
    out[`upper_arm_${which}`] = direction(points[`${which}_shoulder`], points[`${which}_elbow`]);
    out[`forearm_${which}`] = direction(points[`${which}_elbow`], points[`${which}_wrist`]);
    out[`thigh_${which}`] = direction(points[`${which}_hip`], points[`${which}_knee`]);
    out[`shin_${which}`] = direction(points[`${which}_knee`], points[`${which}_ankle`]);
  }
  return out;
}

/**
 * One person's pose, from a picture of them, rebuilt on another person's body
 * in another picture — the same transfer as buildFollowerPoints, for when only
 * the picture is to hand and not the camera's 3D estimate.
 *
 * `fromImage` and `ontoImage` are landmark arrays in their own frames'
 * normalised coordinates; `fromAspect` and `ontoAspect` are those frames'
 * width / height, so a phone held upright and a widescreen class compare.
 * Returns points in `ontoImage`'s normalised coordinates, or null.
 *
 * `mirrored` swaps sides as well as flipping them, so each of the student's
 * limbs lands on the instructor limb that is on the same side of the screen.
 */
export function transferPose(fromImage, fromAspect, ontoImage, ontoAspect, mirrored = false) {
  if (!fromImage || !ontoImage) return null;
  const square = (image, aspect) => image.map((p) => p && { ...p, x: p.x * aspect });
  let directions = imageDirections(instructorPoints(square(fromImage, fromAspect)));
  // As in a mirror: the student's left arm is drawn as the instructor's right,
  // which is on the screen's left — the side the student sees as their own.
  if (directions && mirrored) {
    const swapped = {};
    for (const [name, d] of Object.entries(directions)) {
      const other = name.endsWith("_left") ? name.replace(/_left$/, "_right")
        : name.endsWith("_right") ? name.replace(/_right$/, "_left") : name;
      swapped[other] = d && { x: -d.x, y: d.y };
    }
    directions = swapped;
  }
  const built = buildFollowerPoints(directions, square(ontoImage, ontoAspect));
  if (!built) return null;
  const out = {};
  for (const [name, p] of Object.entries(built)) out[name] = p && { x: p.x / ontoAspect, y: p.y };
  return out;
}
