import { suite, test, assert, assertEqual, assertDeepEqual } from "./harness.js";
import {
  PostureMonitor, CRITICAL_SEVERITY, MINOR_SEVERITY,
  CRITICAL_SUSTAIN_MS, MINOR_SUSTAIN_MS, RECOVER_MS,
} from "../follow.js";
import {
  FollowCoach, LINES, MISSING_GRACE_MS, MISSING_PAUSE_MS,
} from "../coaching.js";

suite("deciding when to interrupt");

/** Feed a monitor a run of (time, score) pairs and collect the states. */
function run(monitor, steps) {
  return steps.map(([t, severity]) => monitor.update(severity, t).state);
}

test("a brief wobble does not stop the class", () => {
  // Nobody moves instantly between shapes. A class that pauses every time
  // somebody is mid-transition is unusable, which is why this is sluggish on
  // the way in.
  const monitor = new PostureMonitor();
  const states = run(monitor, [[0, 0], [200, 0.9], [600, 0.9], [900, 0], [1500, 0]]);
  assertDeepEqual(states, ["ok", "ok", "ok", "ok", "ok"]);
});

test("a sustained fault escalates: ok, then minor, then critical", () => {
  const monitor = new PostureMonitor();
  assertEqual(monitor.update(0.9, 0).state, "ok", "not on the first bad frame");
  assertEqual(monitor.update(0.9, MINOR_SUSTAIN_MS - 100).state, "ok", "nor just before the bar");
  assertEqual(monitor.update(0.9, MINOR_SUSTAIN_MS + 50).state, "minor");
  assertEqual(monitor.update(0.9, CRITICAL_SUSTAIN_MS + 50).state, "critical");
});

test("a mild fault never becomes critical", () => {
  // The two tiers are the whole point of the design: most faults are worth a
  // word, and only a few are worth stopping the class for.
  const monitor = new PostureMonitor();
  const mild = (MINOR_SEVERITY + CRITICAL_SEVERITY) / 2;
  let state = "ok";
  for (let t = 0; t < 20000; t += 200) state = monitor.update(mild, t).state;
  assertEqual(state, "minor", "a mild fault held for twenty seconds");
});

test("it gets out of the way quickly", () => {
  // Asymmetric on purpose. Arriving late costs the user a moment; leaving late
  // costs them the class.
  const monitor = new PostureMonitor();
  run(monitor, [[0, 0.9], [2000, 0.9], [3000, 0.9]]);
  assertEqual(monitor.state, "critical");
  assertEqual(monitor.update(0.02, 3100).state, "critical", "not on the first good frame");
  assertEqual(monitor.update(0.02, 3100 + RECOVER_MS + 50).state, "ok");
  assert(RECOVER_MS < CRITICAL_SUSTAIN_MS, "leaving must be faster than arriving");
});

test("a body that cannot be seen holds the state rather than deciding", () => {
  // Losing the user is not evidence that their posture is good or bad.
  const monitor = new PostureMonitor();
  run(monitor, [[0, 0.9], [2000, 0.9]]);
  assertEqual(monitor.state, "critical");
  assertEqual(monitor.update(null, 2500).state, "critical");
  assertEqual(monitor.update(undefined, 3000).state, "critical");
});

test("resetting returns it to a class going well", () => {
  const monitor = new PostureMonitor();
  run(monitor, [[0, 0.95], [2500, 0.95]]);
  monitor.reset();
  assertEqual(monitor.state, "ok");
});

suite("what gets said");

const FAULT = [{ segment: "thigh_left", text: "Take your left knee back" }];

test("a class going well is silent", () => {
  const coach = new FollowCoach();
  for (let t = 0; t < 30000; t += 500) {
    assertEqual(coach.update({ state: "ok", faults: [], severity: 0.02 }, t), null, `at ${t}ms`);
  }
});

test("an interruption opens by saying it is interrupting", () => {
  // The video has just stopped. Saying nothing while it does would be alarming.
  const coach = new FollowCoach();
  const said = coach.update({ state: "critical", faults: FAULT, severity: 0.9 }, 0);
  assertEqual(said.text, LINES.criticalOpen);
  assert(said.interrupt, "and it talks over whatever was being said");
});

test("then one instruction, and only one", () => {
  const coach = new FollowCoach();
  coach.update({ state: "critical", faults: FAULT, severity: 0.9 }, 0);
  const two = [
    { segment: "thigh_left", text: "Take your left knee back" },
    { segment: "upper_arm_left", text: "Lift your left elbow higher" },
  ];
  const first = coach.update({ state: "critical", faults: two, severity: 0.9 }, 4000);
  assertEqual(first.text, two[0].text);

  let others = 0;
  for (let t = 4100; t < 12000; t += 200) {
    const said = coach.update({ state: "critical", faults: two, severity: 0.9 }, t);
    if (said && said.text === two[1].text) others++;
  }
  assertEqual(others, 0, "it moved on to the elbow while the knee was still wrong");
});

test("the congratulation happens on the way out, not at random", () => {
  const coach = new FollowCoach();
  assertEqual(coach.update({ state: "ok", faults: [], severity: 0.01 }, 0), null,
    "nobody is congratulated for never having been wrong");
  coach.update({ state: "critical", faults: FAULT, severity: 0.9 }, 1000);
  assertEqual(coach.update({ state: "ok", faults: [], severity: 0.03 }, 9000).text, LINES.fixed);
});

test("a user who has left the frame is told so, but not straight away", () => {
  const coach = new FollowCoach();
  const gone = (t) => coach.update({ state: "ok", faults: [], visible: false }, t);

  assertEqual(gone(0), null, "not the instant they are not detected");
  assertEqual(gone(MISSING_GRACE_MS - 200), null, "nor just before the grace runs out");
  assertEqual(gone(MISSING_GRACE_MS + 100).text, LINES.lost);
});

test("someone who reappears is never told they were missing", () => {
  // A dropped detection or two is ordinary, and must not become a sentence.
  const coach = new FollowCoach();
  for (let t = 0; t < 30000; t += 250) {
    const away = (t % 2000) < 750;        // in and out, never gone for long
    const said = coach.update({ state: "ok", faults: [], visible: !away }, t);
    assert(!said || said.text !== LINES.lost, `said it at ${t}ms`);
  }
});

test("nothing is said about how the student is doing before the class starts", () => {
  // The whole of the greeting: no correction and no congratulation, because
  // there is nothing yet to be right or wrong about.
  //
  // Note this student is *visible*. Telling somebody they are out of frame is
  // not a judgement about their practice and is covered separately below — an
  // earlier version of this test looped over `visible` too and so asserted
  // that an out-of-frame student should be ignored through the greeting, which
  // is the opposite of what the app should do.
  const coach = new FollowCoach();
  for (let t = 0; t < 40000; t += 200) {
    const said = coach.update({
      state: "critical", faults: FAULT, severity: 0.9, visible: true, listening: false,
    }, t);
    assertEqual(said, null, `said something at ${t}ms`);
  }
});

test("a student out of frame is told so, even before the class starts", () => {
  // The most useful thing the app can say, at the moment it is most useful to
  // say it. The instructor is still introducing the class, so the student has
  // half a minute to step back and fix it before anything is being asked of
  // them.
  //
  // This was broken by gating it behind the same test as form correction: the
  // app went quiet for a student it could not see, and then stayed quiet for
  // the rest of the class *because* it could not see them.
  const coach = new FollowCoach();
  const gone = (t) => coach.update({
    state: "ok", faults: [], visible: false, listening: false,
  }, t);
  assertEqual(gone(0), null, "not the instant they are not detected");
  assertEqual(gone(MISSING_GRACE_MS - 200), null, "nor before the grace runs out");
  assertEqual(gone(MISSING_GRACE_MS + 100).text, LINES.lost);
});

test("a student missing through the whole greeting is told, but not repeatedly", () => {
  // Said early, and then not nagged about. Thirty seconds of absence is one
  // instruction, not a hundred and twenty.
  const coach = new FollowCoach();
  let spoken = 0;
  for (let t = 0; t < 40000; t += 250) {
    const said = coach.update({ state: "ok", faults: [], visible: false, listening: false }, t);
    if (said && said.text === LINES.lost) spoken++;
  }
  assert(spoken >= 1, "never told the student they were out of frame");
  assert(spoken <= 4, `told them ${spoken} times in forty seconds`);
});

test("form correction stays suppressed while the student is out of frame", () => {
  // There is nothing to correct, because there is nobody there. The queued
  // instruction must not come out instead of, or as well as, "step back".
  const coach = new FollowCoach();
  for (let t = 0; t < 30000; t += 250) {
    const said = coach.update({
      state: "critical", faults: FAULT, severity: 0.9, visible: false, listening: true,
    }, t);
    if (said) assertEqual(said.text, LINES.lost, `said "${said.text}" at ${t}ms`);
  }
});

test("the instructor is not talked over every few seconds", () => {
  // Everything said here is said over a teacher who is already speaking.
  const coach = new FollowCoach();
  let spoken = 0;
  for (let t = 0; t < 120000; t += 100) {
    if (coach.update({ state: "minor", faults: FAULT, severity: 0.4 }, t)) spoken++;
  }
  assert(spoken <= 10, `two minutes of a mild fault produced ${spoken} interruptions`);
});

test("a user who has stopped following is told, not corrected", () => {
  // There is no point naming a limb to somebody who is not attempting the
  // movement, so this outranks any form note that happens to be queued.
  const coach = new FollowCoach();
  const said = coach.update({
    state: "critical", faults: FAULT, severity: 0.9, visible: true, following: false,
  }, 0);
  assertEqual(said.text, LINES.notFollowing);
  assert(said.interrupt, "it talks over whatever was being said");
});

test("not following is said once, not on a loop", () => {
  const coach = new FollowCoach();
  let spoken = 0;
  for (let t = 0; t < 60000; t += 250) {
    const said = coach.update({
      state: "critical", faults: FAULT, severity: 0.9, visible: true, following: false,
    }, t);
    if (said && said.text === LINES.notFollowing) spoken++;
  }
  assert(spoken <= 5, `a minute of not following produced ${spoken} interruptions`);
});

test("a user who starts following again is congratulated, not nagged", () => {
  const coach = new FollowCoach();
  coach.update({ state: "critical", faults: FAULT, severity: 0.9, visible: true, following: false }, 0);
  const back = coach.update({ state: "ok", faults: [], severity: 0.02, visible: true, following: true }, 9000);
  assertEqual(back.text, LINES.fixed);
});

test("nothing is said about following before the class starts", () => {
  const coach = new FollowCoach();
  for (let t = 0; t < 30000; t += 250) {
    assertEqual(coach.update({
      state: "critical", faults: FAULT, severity: 0.9,
      visible: true, following: false, listening: false,
    }, t), null, `said something at ${t}ms`);
  }
});

test("the class is stopped only after the student has been told", () => {
  // Order matters. "Step back so I can see you" has to arrive before the video
  // stops, so that somebody who steps back in time is never interrupted at
  // all — and so that a stopped video always has an explanation attached.
  assert(MISSING_PAUSE_MS > MISSING_GRACE_MS,
    `the class stops at ${MISSING_PAUSE_MS}ms but nothing is said until ${MISSING_GRACE_MS}ms`);
  assert(MISSING_PAUSE_MS - MISSING_GRACE_MS >= 2000,
    "too little time between being told and the class stopping to act on it");
});
