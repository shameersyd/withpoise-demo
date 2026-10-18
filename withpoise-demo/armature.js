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
