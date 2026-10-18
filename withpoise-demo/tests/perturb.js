/**
 * Posing a real traced body into a known fault.
 *
 * The original app's fixtures were built from rigs — exact shapes in known
 * coordinates. There are no rigs here: the reference is a recording of a person.
 * So the subject under test is the instructor's own traced landmarks, moved by
 * a known amount. That is still exactly labelled by construction, and it has
 * the advantage of carrying MediaPipe's real error, which no rig ever did.
 *
 * It does not carry a *second* person's error, which is the thing none of this
 * can simulate. A user is a different body in a different room, and the only
 * way to know what that costs is to put one in front of a camera.
 */

import { LM, v3, bodyFrame } from "../pose-core.js";

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: (a.z ?? 0) + (b.z ?? 0) });

/** Rodrigues: rotate a vector about an arbitrary axis through the origin. */
export function rotateAbout(vector, axis, degrees) {
  const k = v3.unit(axis);
  const t = degrees * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  const kxv = v3.cross(k, vector);
  const kdv = v3.dot(k, vector) * (1 - c);
  return {
    x: vector.x * c + kxv.x * s + k.x * kdv,
    y: vector.y * c + kxv.y * s + k.y * kdv,
    z: (vector.z ?? 0) * c + kxv.z * s + k.z * kdv,
  };
}

const spin = (p, pivot, axis, degrees) =>
  add(pivot, rotateAbout(v3.sub(p, pivot), axis, degrees));

const VERTICAL = { x: 0, y: 1, z: 0 };
const copy = (world) => world.map(p => ({ ...p }));

const LIMBS = {
  arm_left: { root: "left_shoulder", moves: ["left_elbow", "left_wrist"] },
  arm_right: { root: "right_shoulder", moves: ["right_elbow", "right_wrist"] },
  leg_left: { root: "left_hip", moves: ["left_knee", "left_ankle"] },
  leg_right: { root: "right_hip", moves: ["right_knee", "right_ankle"] },
};

/** Swing a whole limb about the vertical through its root. Bones preserved. */
export function swingLimb(world, limb, degrees) {
  const spec = LIMBS[limb];
  const out = copy(world);
  const pivot = world[LM[spec.root]];
  for (const name of spec.moves) out[LM[name]] = spin(world[LM[name]], pivot, VERTICAL, degrees);
  return out;
}

/**
 * Tilt a whole limb away from where it points, about an axis perpendicular to
 * it. Bones preserved.
 *
 * The companion to swingLimb, and the one to reach for when testing whether a
 * misplaced limb is caught. Swinging about the vertical is the realistic fault
 * but it is invisible on a limb that already hangs vertical — rotating anything
 * about an axis it lies along does not move it — so a test built on it measures
 * the instructor's pose at that instant rather than the app.
 */
export function tiltLimb(world, limb, degrees) {
  const spec = LIMBS[limb];
  const out = copy(world);
  const pivot = world[LM[spec.root]];
  const along = v3.sub(world[LM[spec.moves[0]]], pivot);
  if (v3.len(along) < 1e-9) return out;

  // Rotate about the body's forward axis, which swings the limb across the
  // frontal plane. Any perpendicular axis moves the limb, but most of them move
  // it into depth — where the scoring discounts it fourfold on purpose — and a
  // test instrument that exercises the one axis the camera cannot see is
  // measuring the wrong thing.
  const axis = bodyFrame(world).forward;

  for (const name of spec.moves) out[LM[name]] = spin(world[LM[name]], pivot, axis, degrees);
  return out;
}

/** Collapse a knee about the hip→ankle axis. Bones and the knee angle preserved. */
export function valgus(world, side, degrees) {
  const out = copy(world);
  const hip = world[LM[`${side}_hip`]], ankle = world[LM[`${side}_ankle`]];
  const axis = v3.sub(ankle, hip);
  if (v3.len(axis) < 1e-9) return out;
  out[LM[`${side}_knee`]] = spin(world[LM[`${side}_knee`]], hip, axis, degrees);
  return out;
}

const ABOVE_THE_PELVIS = [
  "nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip",
];

/** Yaw the pelvis and everything it carries; feet stay planted. */
export function yawPelvis(world, degrees) {
  const out = copy(world);
  const pivot = v3.mid(world[LM.left_hip], world[LM.right_hip]);
  for (const name of ABOVE_THE_PELVIS) {
    out[LM[name]] = spin(world[LM[name]], pivot, VERTICAL, degrees);
  }
  return out;
}

/** A body of a different size, to prove the comparison does not care. */
export function rescale(world, factor) {
  return world.map(p => ({ ...p, x: p.x * factor, y: p.y * factor, z: p.z * factor }));
}

/** The whole body turned to face elsewhere. */
export function turn(world, degrees) {
  const t = degrees * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return world.map(p => ({ ...p, x: p.x * c + p.z * s, z: -p.x * s + p.z * c }));
}

/** mulberry32, so a run is reproducible. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Anisotropic landmark noise: depth several times worse, as it really is. */
export function addNoise(world, { seed = 1, xy = 0.011, zRatio = 4 } = {}) {
  const rand = seededRandom(seed);
  return world.map(p => ({
    ...p,
    x: p.x + gaussian(rand) * xy,
    y: p.y + gaussian(rand) * xy,
    z: p.z + gaussian(rand) * xy * zRatio,
  }));
}
