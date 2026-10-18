import { readTextFile } from "./platform.js";
import { suite, test, assert, assertEqual, assertClose } from "./harness.js";
import { LM } from "../pose-core.js";
import { InstructorTrack } from "../instructor.js";
import {
  RepTracker, repSignals, referenceRep, repFaults, FAULTS, anchorOf,
} from "../reps.js";
import { RepCoach, REP_LINES, REP_CUE_GAP_MS, REPEAT_EVERY_REPS } from "../coaching.js";
import { CURRENT as EXERCISE, isRepeated } from "../exercise.js";

const track = new InstructorTrack(
  JSON.parse(readTextFile("withpoise-demo/media/instructor.json")));
const reference = referenceRep(track.frames, EXERCISE.from, EXERCISE.to);

/**
 * The real session, as the worker produced it: every distinct result, at the
 * camera's own rate of about fifteen a second.
 */
const loadSession = (name) => {
  const raw = JSON.parse(readTextFile(`withpoise-demo/tests/fixtures/${name}.json`));
  return raw.rows.map(([at, t, paused, ...flat]) => {
    const image = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
    raw.keep.forEach((index, i) => {
      image[index] = { x: flat[i * 3], y: flat[i * 3 + 1], visibility: flat[i * 3 + 2] };
    });
    return { at, t, paused: !!paused, image };
  });
};
const recording = loadSession("session-jumping-jacks");

// ─────────────────────────────────────────────────────────────
// A student made from the instructor
//
// The instructor's real reps, sampled at the student's camera rate and bent
// into each fault. Every one is a way people actually get a jumping jack
// wrong, done on a body MediaPipe actually produced.
// ─────────────────────────────────────────────────────────────
const copy = (image) => image.map((p) => ({ ...p }));
const centre = (image) => (image[LM.left_hip].x + image[LM.right_hip].x) / 2;
const shoulderY = (image) => (image[LM.left_shoulder].y + image[LM.right_shoulder].y) / 2;

const BEND = {
  // Hands stop at shoulder height.
  shortArms(image) {
    const out = copy(image);
    for (const w of [LM.left_wrist, LM.right_wrist]) out[w].y = Math.max(out[w].y, shoulderY(image));
    return out;
  },
  // Feet open to a third of the way.
  narrowFeet(image) {
    const out = copy(image);
    const c = centre(image);
    for (const a of [LM.left_ankle, LM.right_ankle]) out[a].x = c + (out[a].x - c) * 0.35;
    return out;
  },
  // Legs only: arms hang at the sides throughout.
  legsOnly(image, t) {
    const out = copy(image);
    const still = track.at(78.83).image;   // the bottom of a rep
    for (const n of ["left_elbow", "right_elbow", "left_wrist", "right_wrist"]) {
      out[LM[n]] = { ...still[LM[n]] };
    }
    return out;
  },
  // One arm only gets to the shoulder.
  lowLeftArm(image) {
    const out = copy(image);
    out[LM.left_wrist].y = Math.max(out[LM.left_wrist].y, shoulderY(image));
    return out;
  },
  // Feet a third of a rep behind the arms.
  lateFeet(image, t) {
    const out = copy(image);
    const earlier = track.at(t - 0.42).image;
    for (const n of ["left_ankle", "right_ankle", "left_knee", "right_knee"]) {
      out[LM[n]] = { ...earlier[LM[n]] };
    }
    return out;
  },
};

/** Run a whole set through the tracker and the coach. */
function perform(bend, { from = EXERCISE.from, to = EXERCISE.to, fixAt = Infinity, fps = 15 } = {}) {
  const tracker = new RepTracker();
  const coach = new RepCoach(FAULTS);
  const said = [];
  const markers = [];
  let reps = 0;
  for (let t = from; t <= to; t += 1 / fps) {
    const frame = track.at(t);
    if (!frame || !frame.image) continue;
    const image = bend && t < fixAt ? bend(frame.image, t) : frame.image;
    const event = tracker.observe(t, repSignals(image));
    if (!event) continue;
    if (event.kind === "rep") {
      reps++;
      coach.rep(event.rep, repFaults(event.rep, reference));
    } else {
      const decision = coach.top(event.top, repFaults(event.top, reference), t * 1000);
      if (decision.say) said.push({ t, text: decision.say });
      if (decision.marker) markers.push({ t, ...decision.marker });
    }
  }
  return { said, markers, reps };
}

suite("repetitions");

test("jumping jacks are coached per rep", () => {
  assert(isRepeated(EXERCISE), "the demo exercise should be marked as a repeated movement");
});

test("the instructor's typical rep is what was measured off the video", () => {
  assert(reference, "no reference rep");
  assert(reference.reps >= 15, `only ${reference.reps} reps found in the set`);
  assertClose(reference.reach, 0.72, 0.08, "reach at the top");
  assertClose(reference.feetTop, 1.45, 0.1, "feet at the top");
  assertClose(reference.feetBottom, 0.31, 0.1, "feet at the bottom");
  assertClose(reference.reachBottom, -0.98, 0.1, "hands at the bottom");
  assertClose(reference.lag, 0, 0.08, "arms and feet together");
});

test("the instructor's own reps count the same at the student's frame rate", () => {
  // The trace is six samples a second and a phone camera about fifteen; the
  // count must not depend on which.
  const { reps } = perform(null);
  assert(reps >= reference.reps - 1 && reps <= reference.reps + 1,
    `${reps} reps at 15fps against ${reference.reps} at 6fps`);
});

test("a student doing exactly what the instructor does is told nothing", () => {
  const { said, markers } = perform(null);
  assertEqual(said.length, 0, `said: ${said.map((s) => s.text).join(" / ")}`);
  assertEqual(markers.length, 0, "showed a marker");
});

const CASES = [
  ["shortArms", "arms-up", "Arms all the way up."],
  ["narrowFeet", "feet-wide", "Jump your feet wider."],
  ["legsOnly", "arms-up", "Arms all the way up."],
  ["lowLeftArm", "arms-even", "Lift your left arm as high as the other."],
  ["lateFeet", "together", "Arms and feet together."],
];

for (const [bend, fault, line] of CASES) {
  test(`${bend}: named as "${line}", within a few reps`, () => {
    const { said, markers } = perform(BEND[bend]);
    assert(said.length > 0, "said nothing");
    assertEqual(said[0].text, line);
    // Two of three reps have to show it, so never on the first; and by the
    // third, under four seconds in.
    const after = said[0].t - EXERCISE.from;
    assert(after > 1 && after < 4, `first said ${after.toFixed(1)}s into the set`);
    assertEqual(markers[0].fault, fault);
  });
}

test("arms only: the feet are named", () => {
  const armsOnly = (image) => {
    const out = copy(image);
    const still = track.at(78.83).image;
    for (const n of ["left_ankle", "right_ankle", "left_knee", "right_knee"]) out[LM[n]] = { ...still[LM[n]] };
    return out;
  };
  const { said } = perform(armsOnly);
  assert(said.length > 0, "said nothing");
  assertEqual(said[0].text, "Jump your feet wider.");
});

test("the marker comes back at the top of every rep until it is fixed", () => {
  const { said, markers } = perform(BEND.shortArms, { fixAt: 88 });
  const before = markers.filter((m) => m.t < 88 && m.state === "wrong");
  assert(before.length >= 3, `only ${before.length} markers before the fix`);
  // Reminded every few reps, never two corrections on top of each other.
  // (Praise is not held back: it is said at the rep that earns it.)
  const cues = said.filter((s) => s.text !== REP_LINES.fixed);
  for (let i = 1; i < cues.length; i++) {
    const gap = (cues[i].t - cues[i - 1].t) * 1000;
    assert(gap >= REP_CUE_GAP_MS, `two lines ${gap.toFixed(0)}ms apart`);
  }
});

test("fixing it is noticed at the next top, and said", () => {
  const { said, markers } = perform(BEND.shortArms, { fixAt: 88 });
  const praise = said.find((s) => s.text === REP_LINES.fixed);
  assert(praise, `never said "${REP_LINES.fixed}" — said: ${said.map((s) => s.text).join(" / ")}`);
  assert(praise.t >= 88 && praise.t < 90, `said at ${praise.t.toFixed(1)}s, fixed at 88s`);
  assert(markers.some((m) => m.state === "fixed"), "no green marker for the fix");
  // And it is not raised again afterwards.
  assertEqual(said.filter((s) => s.t > praise.t).length, 0, "kept talking after the fix");
});

test("a fault that is not fixed is said again every few reps, in other words", () => {
  // Once and then silence was what the second recording got: one cue, missed,
  // and nothing for the remaining twenty reps.
  const { said, markers } = perform(BEND.shortArms);
  const cues = said.filter((s) => s.text !== REP_LINES.fixed);
  const set = EXERCISE.to - EXERCISE.from;
  const period = reference.period * (REPEAT_EVERY_REPS + 1);
  assert(cues.length >= Math.floor(set / period) - 1,
    `said ${cues.length} times over a ${set}s set`);
  assert(new Set(cues.map((c) => c.text)).size === 2, "only one wording");
  // And the marker at every top in between, to the end of the set.
  const last = markers[markers.length - 1];
  assert(last.t > EXERCISE.to - 2.5, `marker stopped at ${last.t.toFixed(1)}s`);
});

test("a minor fault is shown, not said", () => {
  // Feet left open at the bottom. Marked, never spoken.
  const feetApart = (image) => {
    const out = copy(image);
    const c = centre(image);
    const width = Math.abs(image[LM.left_shoulder].x - image[LM.right_shoulder].x);
    for (const [ankle, hip] of [[LM.left_ankle, LM.left_hip], [LM.right_ankle, LM.right_hip]]) {
      const side = Math.sign(image[hip].x - c);
      if (Math.abs(out[ankle].x - c) < width * 0.85) out[ankle].x = c + side * width * 0.85;
    }
    return out;
  };
  const { said, markers } = perform(feetApart);
  assertEqual(said.length, 0, `said: ${said.map((s) => s.text).join(" / ")}`);
  assert(markers.some((m) => m.fault === "feet-in"), "no marker for feet left apart");
});

test("a rep with the ankles out of sight is not judged on its feet", () => {
  const hidden = (image) => {
    const out = copy(image);
    out[LM.left_ankle].visibility = 0.1;
    out[LM.right_ankle].visibility = 0.1;
    return BEND.narrowFeet(out);
  };
  const { said } = perform(hidden);
  assertEqual(said.filter((s) => s.text === "Jump your feet wider.").length, 0,
    "told to widen feet it could not see");
});

suite("repetitions — the recorded session");

test("the real student's reps are found", () => {
  // A thin fixture, and worth being plain about: the student did most of their
  // jumping jacks while the old build had the class stopped, and stopped again
  // within a rep or two each time it resumed. It holds four arm reps to the
  // top, one of them complete bottom to bottom. A proper set is the next
  // recording.
  const tracker = new RepTracker();
  let reps = 0, tops = 0;
  for (const row of recording) {
    const e = tracker.observe(row.at / 1000, repSignals(row.image));
    if (e && e.kind === "rep" && e.rep.reach != null && e.rep.reach > 0.5) reps++;
    if (e && e.kind === "top" && e.top.reach != null && e.top.reach > 0.5) tops++;
  }
  assert(tops >= 3, `only ${tops} arm reps reached the top`);
  assert(reps >= 1, "no complete rep");
});

test("the real student's real reps reach as high as the instructor's", () => {
  // The check that the smoothing in the worker is not shaving the top off every
  // rep, which would turn into "arms all the way up" for everybody.
  const tracker = new RepTracker();
  const reaches = [];
  for (const row of recording) {
    const e = tracker.observe(row.at / 1000, repSignals(row.image));
    if (e && e.kind === "top" && e.top.reach != null && e.top.reach > 0.5) reaches.push(e.top.reach);
  }
  assert(reaches.length >= 2, "no full reps");
  for (const r of reaches) assert(r > reference.reach - 0.1, `a full rep reached only ${r.toFixed(2)}`);
});

test("and none of their full reps reads as a fault", () => {
  const tracker = new RepTracker();
  for (const row of recording) {
    const e = tracker.observe(row.at / 1000, repSignals(row.image));
    if (!e || e.kind !== "rep" || !(e.rep.reach > 0.5)) continue;
    const faults = repFaults(e.rep, reference);
    for (const [id, wrong] of Object.entries(faults)) {
      if (id === "together") continue;  // slow reps while the class was paused
      assert(wrong !== true, `${id} on a rep at ${row.t}s: ${JSON.stringify(e.rep)}`);
    }
  }
});

test("the anchor for the marker sits on the instructor", () => {
  const anchor = anchorOf(track.window(90, 1.4).map((f) => f.image));
  assert(anchor, "no anchor");
  const here = track.at(90).image;
  assertClose(anchor.cx, centre(here), 0.05, "centre");
  assert(anchor.torso > 0.05 && anchor.width > 0.02, "a body this small is not the instructor");
  assert(anchor.ankleY > anchor.shoulderY + anchor.torso, "feet above the hips");
});

suite("repetitions — three sets by a real student, 2026-10-17");

/** A recorded set through the tracker and coach, exactly as the page feeds it. */
function replay(name) {
  const tracker = new RepTracker();
  const coach = new RepCoach(FAULTS);
  const said = [], markers = [];
  let firstWrong = null;
  for (const row of loadSession(name)) {
    if (row.paused) continue;
    const event = tracker.observe(row.at / 1000, repSignals(row.image));
    if (!event) continue;
    if (event.kind === "rep") {
      coach.rep(event.rep, repFaults(event.rep, reference));
    } else {
      const faults = repFaults(event.top, reference);
      if (firstWrong == null && Object.values(faults).some((v) => v === true)) firstWrong = row.t;
      const decision = coach.top(event.top, faults, row.at);
      if (decision.say) said.push({ t: row.t, text: decision.say });
      if (decision.marker) markers.push({ t: row.t, ...decision.marker });
    }
  }
  return { said, markers, firstWrong };
}

test("good reps: nothing is said", () => {
  // This set was told "Bring your feet back together" twice: the student's
  // feet closed to hip width, where the instructor's close to touching.
  const { said } = replay("session-good-form");
  assertEqual(said.length, 0, `said: ${said.map((s) => `${s.t.toFixed(1)}s ${s.text}`).join(" / ")}`);
});

for (const [name, line, other] of [
  ["session-short-arms", "Arms all the way up.", "Reach higher — hands above your head."],
  ["session-narrow-feet", "Jump your feet wider.", "Feet out wide as you jump."],
]) {
  test(`${name}: "${line}" within a few seconds, and again until the set ends`, () => {
    const { said, markers, firstWrong } = replay(name);
    assert(said.length > 0, "said nothing");
    assertEqual(said[0].text, line);
    const late = said[0].t - firstWrong;
    assert(late < 3.5, `first said ${late.toFixed(1)}s after the first bad rep`);
    // Never fixed, so: reminded through the set, in both wordings.
    assert(said.length >= 4, `said ${said.length} times: ${said.map((s) => s.t.toFixed(1)).join(", ")}`);
    assert(said.every((s) => s.text === line || s.text === other),
      `said: ${said.map((s) => s.text).join(" / ")}`);
    assert(said[said.length - 1].t > 95, `went quiet after ${said[said.length - 1].t.toFixed(1)}s`);
    assert(markers[markers.length - 1].t > 100, "marker stopped before the end of the set");
  });
}
