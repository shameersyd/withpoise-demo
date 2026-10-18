/**
 * Judging a movement by the repetition, not by the frame.
 *
 * A held pose can be compared with the instructor one frame at a time, because
 * the frame *is* the exercise. A jumping jack cannot: any single frame of one
 * is half-way to somewhere, and a student a quarter-beat behind the video
 * matches nothing the instructor is doing at that instant. Comparing frames was
 * measured doing exactly the wrong thing — a recorded session spent 62 seconds
 * getting through 9 seconds of class, stopped repeatedly to be told to "take
 * your left hand further out to the side" in the middle of a jump.
 *
 * So the unit here is one repetition. Each rep is reduced to a handful of
 * numbers about the body it was done with — how high the hands got, how wide
 * the feet went, whether they came back, whether arms and legs moved together —
 * and those are compared with the same numbers taken from the instructor's own
 * reps. Timing drops out completely: it does not matter whether the student is
 * half a beat behind, or faster, or mirrored, only whether their rep looks like
 * the instructor's rep.
 *
 * Everything is in the student's own body units, measured on the image:
 *
 *   reach   how far the wrist rises above the shoulders, in torso lengths
 *           (shoulders to hips). Vertical over vertical, so the camera's aspect
 *           ratio cancels. Hands at the sides read about −1, at shoulder height
 *           about 0, and the instructor's overhead about +0.7.
 *   feet    the distance between the ankles, in shoulder widths. Horizontal
 *           over horizontal, for the same reason. Together about 0.3, the
 *           instructor's jump about 1.45.
 *
 * Measured from the instructor's 17 reps at 78–100s of the demo class: one rep
 * every 1.33s, reach +0.70 at the top and −1.0 at the bottom, feet 1.45 open
 * and 0.3 closed, and arms and feet peaking together, within one sample.
 */

import { LM } from "./pose-core.js";

/** A landmark has to be at least this sure of itself to be measured. */
export const MIN_VISIBILITY = 0.5;

/**
 * How far a signal has to rise from its low, and then fall from its high, to
 * count as one repetition — in the signal's own units.
 *
 * Hysteresis rather than a level: a level fixed for the instructor's full
 * overhead reach would never fire for a student whose arms stop at shoulder
 * height, and that student is precisely the one who needs telling. Half a
 * torso length is a deliberate movement, well clear of the wobble of somebody
 * standing still (under 0.1 in the recording), and well inside the smallest
 * real jumping jack anybody does — hands from the sides to the shoulders is a
 * whole torso length.
 */
export const ARM_SWING = 0.5;
export const FEET_SWING = 0.4;

/**
 * If the arms have not completed a repetition for this long but the feet have,
 * the rep boundaries come from the feet. Somebody doing the legs without the
 * arms is doing the exercise, wrongly, and must still be judged — or the one
 * fault the app can always see would be the one it never mentions.
 */
const ARMS_QUIET_SECONDS = 2.5;

/** How close to its lowest a signal still counts as "at the bottom". */
const BOTTOM_BAND = 0.12;

/**
 * Feet further apart than this, in shoulder widths, are not a jumping jack —
 * they are a body turned side-on, which collapses the shoulder width the
 * measure is divided by. Seen in the recording: 5.7 from somebody walking
 * across their mat.
 */
const MAX_FEET = 3;

/** Longest a single rep can plausibly take. Anything slower is not a rep. */
const MAX_REP_SECONDS = 4;

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const seen = (p) => !!p && !p.held && (p.visibility ?? 1) >= MIN_VISIBILITY;

/**
 * One frame's worth of the numbers a rep is judged on, or null where a part of
 * the body cannot be seen. `image` is a 33-entry landmark array in normalised
 * image coordinates — the student's straight from the worker, the
 * instructor's straight from the trace.
 */
export function repSignals(image) {
  if (!image) return null;
  const ls = image[LM.left_shoulder], rs = image[LM.right_shoulder];
  const lh = image[LM.left_hip], rh = image[LM.right_hip];
  if (!seen(ls) || !seen(rs) || !seen(lh) || !seen(rh)) return null;

  const shoulders = mid(ls, rs);
  const hips = mid(lh, rh);
  const torso = hips.y - shoulders.y;
  const width = Math.abs(ls.x - rs.x);
  // Upside down, lying flat or edge-on: none of these measures mean anything.
  if (!(torso > 0.02) || !(width > 0.01)) return null;

  const lw = image[LM.left_wrist], rw = image[LM.right_wrist];
  const la = image[LM.left_ankle], ra = image[LM.right_ankle];
  const reachL = seen(lw) ? (shoulders.y - lw.y) / torso : null;
  const reachR = seen(rw) ? (shoulders.y - rw.y) / torso : null;
  const reach = reachL != null && reachR != null ? (reachL + reachR) / 2 : null;
  let feet = seen(la) && seen(ra) ? Math.abs(la.x - ra.x) / width : null;
  if (feet != null && feet > MAX_FEET) feet = null;
  return { reachL, reachR, reach, feet };
}

/**
 * A rise-and-fall detector on one signal.
 *
 * Reports the moment a peak is confirmed (the signal has come back down by
 * `swing` from its highest) and the moment a trough is confirmed (back up by
 * `swing` from its lowest). Gaps in the signal are skipped rather than reset,
 * because ankles in particular drop out for a frame or two at the top of every
 * jump and that must not cost the rep.
 */
class Swing {
  constructor(swing) {
    this.swing = swing;
    this.reset();
  }

  reset() {
    this.rising = false;
    this.low = null;   // { t, v }
    this.high = null;
  }

  /** Returns "top", "bottom" or null. */
  observe(t, v) {
    if (v == null) return null;
    if (!this.low) { this.low = { t, v }; this.high = { t, v }; return null; }

    if (this.rising) {
      if (v > this.high.v) this.high = { t, v };
      if (v < this.high.v - this.swing) {
        this.rising = false;
        this.low = { t, v };
        return "top";
      }
    } else {
      // The bottom is where the body *left* from, so its time keeps moving
      // forward for as long as the signal stays near its low. Otherwise ten
      // seconds of standing still before the first rep would be counted as
      // part of it, wherever the noise happened to dip lowest.
      if (v < this.low.v) this.low = { t, v };
      else if (v < this.low.v + BOTTOM_BAND) this.low = { t, v: this.low.v };
      if (v > this.low.v + this.swing) {
        this.rising = true;
        this.high = { t, v };
        return "bottom";
      }
    }
    return null;
  }
}

/** Median of the finite values, or null. */
export function median(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * When, within a stretch of samples, a signal was at its height — the middle
 * of the time it spent in the top third of its range for that rep.
 *
 * Not simply the highest sample: the top of a jumping jack is a plateau two or
 * three samples wide, and which of those happens to be a hair higher is noise.
 * The middle of the plateau is the moment the movement was aiming for.
 */
function peakTime(samples, key) {
  const values = samples.filter((s) => s[key] != null);
  if (values.length < 3) return null;
  let lo = Infinity, hi = -Infinity;
  for (const s of values) { lo = Math.min(lo, s[key]); hi = Math.max(hi, s[key]); }
  if (!(hi - lo > 0.15)) return null;
  const bar = hi - (hi - lo) / 3;
  const top = values.filter((s) => s[key] >= bar);
  return (top[0].t + top[top.length - 1].t) / 2;
}

const maxOf = (samples, key) => {
  let best = null;
  for (const s of samples) if (s[key] != null && (best == null || s[key] > best)) best = s[key];
  return best;
};
const minOf = (samples, key) => {
  let best = null;
  for (const s of samples) if (s[key] != null && (best == null || s[key] < best)) best = s[key];
  return best;
};
const countOf = (samples, key) => samples.reduce((n, s) => n + (s[key] != null ? 1 : 0), 0);

/**
 * Summarise one repetition from its samples, bottom to bottom.
 *
 * Any measure the camera could not support comes back null and is not judged:
 * a rep with the ankles lost at the top of the jump has an unknown foot width,
 * not a narrow one. Saying "feet wider" to somebody whose feet were merely out
 * of sight is the app being wrong out loud.
 */
export function summariseRep(samples, start, end) {
  const inRep = samples.filter((s) => s.t >= start && s.t <= end);
  const enough = (key) => countOf(inRep, key) >= Math.max(2, inRep.length * 0.4);

  const reachL = enough("reachL") ? maxOf(inRep, "reachL") : null;
  const reachR = enough("reachR") ? maxOf(inRep, "reachR") : null;
  const reach = reachL != null && reachR != null ? (reachL + reachR) / 2 : null;
  const feetTop = enough("feet") ? maxOf(inRep, "feet") : null;

  // The bottom is the lower of the two ends of the rep, which is where the
  // body came back to — not the minimum anywhere inside it.
  const edge = (t) => inRep.filter((s) => Math.abs(s.t - t) <= (end - start) * 0.2);
  const reachBottom = enough("reach")
    ? Math.min(minOf(edge(start), "reach") ?? Infinity, minOf(edge(end), "reach") ?? Infinity)
    : null;
  const feetBottom = enough("feet")
    ? Math.min(minOf(edge(start), "feet") ?? Infinity, minOf(edge(end), "feet") ?? Infinity)
    : null;

  // Arms and legs together: the gap between their peaks, as a share of the
  // rep. Zero for the instructor. A student whose arms go up while their feet
  // are still together reads a quarter of a rep or more.
  const armsAt = peakTime(inRep, "reach");
  const feetAt = peakTime(inRep, "feet");
  const lag = armsAt != null && feetAt != null && end > start
    ? (feetAt - armsAt) / (end - start) : null;

  // How far apart the feet were at the moment the arms peaked: what the
  // student was doing with their legs when their hands were up. For drawing
  // what "arms and feet together" means.
  let feetAtArms = null;
  if (armsAt != null) {
    let best = Infinity;
    for (const s of inRep) {
      if (s.feet == null) continue;
      const d = Math.abs(s.t - armsAt);
      if (d < best && d <= (end - start) * 0.15) { best = d; feetAtArms = s.feet; }
    }
  }

  const finite = (v) => (v != null && Number.isFinite(v) ? v : null);
  return {
    start, end, period: end - start,
    reachL, reachR, reach, feetTop,
    reachBottom: finite(reachBottom), feetBottom: finite(feetBottom),
    lag, feetAtArms,
    // Where the rep peaked, for drawing it — the arms if there were any.
    topAt: armsAt ?? feetAt ?? (start + end) / 2,
  };
}

/**
 * Splits a live stream of frames into repetitions.
 *
 * `observe` returns:
 *   { kind: "top", top }      the top of a rep has just been confirmed — the
 *                             student is on the way down. `top` carries the
 *                             numbers for the top that has just happened.
 *   { kind: "rep", rep }      a whole rep has just finished — bottom to bottom.
 *   null                      neither.
 *
 * The top is reported on its own because that is when a cue has to be said:
 * on the way down, so it is heard before the next rep starts rather than in
 * the middle of it.
 */
export class RepTracker {
  constructor({ armSwing = ARM_SWING, feetSwing = FEET_SWING } = {}) {
    this.arms = new Swing(armSwing);
    this.feet = new Swing(feetSwing);
    this.reset();
  }

  reset() {
    this.arms.reset();
    this.feet.reset();
    this.samples = [];
    this.repStart = null;       // time of the bottom that opened this rep
    this.armsLastAt = -Infinity;
    this.count = 0;
  }

  /** Which signal is drawing the rep boundaries right now. */
  driver(t) {
    return t - this.armsLastAt <= ARMS_QUIET_SECONDS ? "arms" : "feet";
  }

  observe(t, signals) {
    if (!signals) return null;
    this.samples.push({ t, ...signals });
    // Two reps' worth, generously, is all a summary ever needs.
    while (this.samples.length && t - this.samples[0].t > MAX_REP_SECONDS * 2) this.samples.shift();

    const armEvent = this.arms.observe(t, signals.reach);
    const feetEvent = this.feet.observe(t, signals.feet);
    if (armEvent) this.armsLastAt = t;
    const event = this.driver(t) === "arms" ? armEvent : feetEvent;

    if (event === "top" && this.repStart != null && t - this.repStart <= MAX_REP_SECONDS) {
      const top = summariseRep(this.samples, this.repStart, t);
      return { kind: "top", top };
    }

    if (event === "bottom") {
      // The trough was confirmed late, on the way back up; the bottom itself is
      // where the signal was lowest.
      const swing = this.driver(t) === "arms" ? this.arms : this.feet;
      const bottomAt = swing.low ? swing.low.t : t;
      const start = this.repStart;
      this.repStart = bottomAt;
      if (start != null && bottomAt - start <= MAX_REP_SECONDS && bottomAt > start) {
        this.count++;
        return { kind: "rep", rep: summariseRep(this.samples, start, bottomAt) };
      }
    }
    return null;
  }
}

/**
 * The instructor's typical rep, from their trace: the median of each measure
 * across every rep they did between `from` and `to`.
 *
 * The median rather than the mean, because the first and last reps of a set
 * are the instructor getting into it and out of it, and they are not what the
 * student is being asked to copy.
 */
export function referenceRep(frames, from, to) {
  const tracker = new RepTracker();
  const reps = [];
  for (const frame of frames) {
    if (frame.t < from - 2 || frame.t > to) continue;
    const event = tracker.observe(frame.t, repSignals(frame.image));
    if (event && event.kind === "rep" && event.rep.start >= from) reps.push(event.rep);
  }
  if (!reps.length) return null;
  const pick = (key) => median(reps.map((r) => r[key]));
  return {
    reps: reps.length,
    period: pick("period"),
    reach: pick("reach"),
    reachL: pick("reachL"),
    reachR: pick("reachR"),
    feetTop: pick("feetTop"),
    reachBottom: pick("reachBottom"),
    feetBottom: pick("feetBottom"),
    lag: pick("lag"),
  };
}

/**
 * What can be wrong with a jumping jack, most important first.
 *
 * Each fault reads one or two measures off a rep and compares them with the
 * instructor's. A measure the camera could not support is null and the fault
 * is then *unknown* for that rep, not absent and not present.
 *
 * Every margin is wide on purpose: the error that dominates is that the
 * student is a different person, standing differently, in front of a
 * different lens. They are set against what was measured:
 *
 *   arms    the instructor reaches +0.72 and a student in the recording reached
 *           +0.72 to +0.75 on real reps. Arms that stop at the shoulders read
 *           about 0. The line sits at +0.37, between the two.
 *   feet    the instructor opens to 1.45 shoulder widths; the student in the
 *           recording opened 1.06–1.24, which is a real jumping jack done by
 *           somebody else. Arms-only reps stay under 0.6. The line is 0.87.
 *   closed  the instructor closes to 0.31, nearly heels together. A student
 *           doing good reps in the second recording closed to 0.44–1.22: a
 *           normal hip-width stance, which is not worth correcting. The line
 *           was 0.76 and called good reps faults; it is now 1.41, and the
 *           fault is shown, never said.
 *   timing  the instructor's arms and feet peak together, ±0.07 of a rep. The
 *           student's ranged ±0.21 on slow reps, so the line is at 0.3 —
 *           arms going up while the feet are still together.
 *   even    the same good reps read up to 0.34 apart left to right — a camera
 *           off to one side foreshortens one arm. One arm stopping at the
 *           shoulder reads 0.7. The line is 0.45.
 *
 * `spoken: false` faults are real but minor: the marker shows them, the voice
 * does not spend a cue on them.
 */
export const ARMS_SHORT = 0.35;
export const ARMS_UNEVEN = 0.45;
export const FEET_NARROW = 0.6;
export const FEET_OPEN = 1.1;
export const ARMS_HIGH = 0.45;
export const OUT_OF_STEP = 0.3;

const side = (rep) => (rep.reachL < rep.reachR ? "left" : "right");

export const FAULTS = [
  {
    id: "arms-up",
    // Measurable at the top of the rep, so a fix can be heard the moment the
    // hands get there rather than a rep later.
    atTop: true,
    test: (rep, ref) => rep.reach == null ? null : rep.reach < ref.reach - ARMS_SHORT,
    cues: () => ["Arms all the way up.", "Reach higher — hands above your head."],
  },
  {
    id: "feet-wide",
    atTop: true,
    test: (rep, ref) => rep.feetTop == null ? null : rep.feetTop < ref.feetTop * FEET_NARROW,
    cues: () => ["Jump your feet wider.", "Feet out wide as you jump."],
  },
  {
    id: "together",
    atTop: false,
    test: (rep) => rep.lag == null ? null : Math.abs(rep.lag) > OUT_OF_STEP,
    cues: () => ["Arms and feet together.", "Hands and feet move at the same time."],
  },
  {
    id: "arms-even",
    atTop: true,
    test: (rep) => rep.reachL == null || rep.reachR == null ? null
      : Math.abs(rep.reachL - rep.reachR) > ARMS_UNEVEN,
    cues: (rep) => [`Lift your ${side(rep)} arm as high as the other.`, `${side(rep)[0].toUpperCase() + side(rep).slice(1)} arm higher.`],
  },
  {
    id: "feet-in",
    atTop: false,
    test: (rep, ref) => rep.feetBottom == null ? null : rep.feetBottom > ref.feetBottom + FEET_OPEN,
    spoken: false,
    cues: () => ["Bring your feet back together."],
  },
  {
    id: "arms-down",
    atTop: false,
    test: (rep, ref) => rep.reachBottom == null ? null : rep.reachBottom > ref.reachBottom + ARMS_HIGH,
    spoken: false,
    cues: () => ["Bring your arms all the way down."],
  },
];

export const FAULT = Object.fromEntries(FAULTS.map((f) => [f.id, f]));

/** { id: true | false | null } for one rep. */
export function repFaults(rep, ref) {
  const out = {};
  for (const fault of FAULTS) out[fault.id] = ref ? fault.test(rep, ref) : null;
  return out;
}

/**
 * Where to draw a rep's numbers on the instructor: their body's scale and
 * position, steadied over the last rep or so.
 *
 * Steadied because the instructor is jumping. A marker pinned to their
 * shoulders this frame bounces with them, and a target line that moves is
 * not a target. The median over a rep sits still while they move under it.
 *
 * `images` are the instructor's recent image landmarks. Returns null if too
 * few of them show the body.
 */
export function anchorOf(images) {
  const rows = [];
  for (const image of images) {
    if (!image) continue;
    const ls = image[LM.left_shoulder], rs = image[LM.right_shoulder];
    const lh = image[LM.left_hip], rh = image[LM.right_hip];
    const la = image[LM.left_ankle], ra = image[LM.right_ankle];
    if (![ls, rs, lh, rh].every(seen)) continue;
    const shoulders = mid(ls, rs), hips = mid(lh, rh);
    rows.push({
      cx: (shoulders.x + hips.x) / 2,
      shoulderY: shoulders.y,
      torso: hips.y - shoulders.y,
      width: Math.abs(ls.x - rs.x),
      ankleY: seen(la) && seen(ra) ? (la.y + ra.y) / 2 : null,
    });
  }
  if (rows.length < 2) return null;
  const pick = (key) => median(rows.map((r) => r[key]));
  const anchor = {
    cx: pick("cx"), shoulderY: pick("shoulderY"), torso: pick("torso"),
    width: pick("width"), ankleY: pick("ankleY"),
  };
  // No ankles in shot: put the feet where a standing body's feet are, about
  // two and a half torso lengths below the shoulders.
  if (anchor.ankleY == null) anchor.ankleY = anchor.shoulderY + anchor.torso * 2.5;
  return anchor;
}
