import { readTextFile } from "./platform.js";
import { suite, test, assert, assertEqual } from "./harness.js";
import { classify, CueTrack, CUE_LIFETIME } from "../cues.js";
import { InstructorTrack, classStartsAt, MAX_GREETING_SECONDS } from "../instructor.js";

const track = new InstructorTrack(JSON.parse(readTextFile("withpoise-demo/media/instructor.json")));

const transcript = JSON.parse(readTextFile("withpoise-demo/media/instructor-transcript.json"));
const cues = new CueTrack(transcript);

suite("reading the instruction");

test("the transcript covers the class", () => {
  assert(transcript.complete, "the transcript is incomplete — rerun tools/transcribe-instructor.py");
  assert(transcript.segments.length > 100, `only ${transcript.segments.length} spoken lines`);
  const last = transcript.segments[transcript.segments.length - 1];
  assert(last.from > transcript.duration - 120,
    `transcription stops at ${last.from.toFixed(0)}s of ${transcript.duration.toFixed(0)}s`);
});

test("lines from this class are read the way a student would read them", () => {
  // Every one of these is a real line from the demo transcript. They are the
  // evidence the patterns were written from, so if a pattern is loosened to fix
  // something else, this is what notices.
  const cases = [
    ["Let's start with a simple walk.", "start"],
    ["The next one is high knees again, two versions, simple, normal version.", "start"],
    ["Now what we do is next, elbow to the knee but we have to cross it like this.", "start"],
    ["And now we will do the same movement but this time the movement is different.", "start"],
    ["now you can go left to right go for it", "start"],
    ["Lift your legs up at 90/90.", "start"],
    ["One, two, three, four, five, six, seven, eight, nine, ten.", "count"],
    ["1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1.", "count"],
    ["Relax.", "release"],
    ["And relax.", "release"],
    ["Relax. 3, 2, 1, relax.", "release"],
    ["But we never know that belly fat is actually very dangerous.", "aside"],
    ["Okay, now his name is Pramod.", "aside"],
    ["Remember to breathe in and out through the nose only.", "aside"],
    ["It is not important to do it exactly 20. You can do less also no problem.", "aside"],
    ["Anytime you feel the exercise is too much, you can just simply walk.", "aside"],
  ];
  for (const [text, expected] of cases) {
    assertEqual(classify(text), expected, `"${text.slice(0, 54)}"`);
  }
});

test("a set that ends in a countdown is read as the end, not as counting", () => {
  // "3, 2, 1, relax" closes nearly every set in this class. What matters about
  // it is that the set is over, so release outranks count.
  assertEqual(classify("10, 9, 8, 7, 6, 5, 4, 3, 2, 1 and relax."), "release");
  assertEqual(classify("4, 3, 2, 1 and let go."), "release");
});

test("holding your hands is not holding the pose", () => {
  // The distinction the HOLD patterns exist to make. This class says "hold your
  // hands together like this", which is an instruction to get somewhere — and
  // reading it as a sustain cue would freeze the reference on a pose the
  // student has not reached.
  assertEqual(classify("And hold your hands together like this."), "start");
  // Also a setup rather than a sustain: it says where to put a hand, not to
  // stay as you are.
  assertEqual(classify("hold your toes"), "start");

  // And the real thing, which this class never says but an asana class says
  // constantly.
  for (const line of [
    "Stay here and breathe.", "Hold it for five breaths.", "Keep holding.",
    "Hold this position.", "Stay in this posture for ten seconds.",
    "Don't move, just breathe here.", "Five more seconds.",
  ]) {
    assertEqual(classify(line), "hold", `"${line}"`);
  }
});

test("an explanation does not change what the student is doing", () => {
  // The whole reason for reading the words. 109 of this class's 169 spoken
  // lines are asides, and none of them may move the reference.
  const asides = cues.cues.filter((c) => c.intent === "aside");
  assert(asides.length > 50, `only ${asides.length} asides — the classifier is too eager`);

  // No block boundary sits on an aside.
  for (const block of cues.blocks) {
    const cue = cues.cues.find((c) => c.at === block.from && c.text === block.text);
    assert(cue && cue.intent !== "aside", `a block starts on an aside at ${block.from}s`);
  }
});

test("the class reads as a sequence of sets", () => {
  // settling → reps → resting, over and over, which is what this class is.
  const modes = cues.blocks.map((b) => b.mode);
  assert(modes.filter((m) => m === "reps").length >= 8, `only ${modes.filter(m => m === "reps").length} rep blocks`);
  assert(modes.filter((m) => m === "resting").length >= 8, "no rests between sets");
  assert(cues.blocks.length >= 20, `only ${cues.blocks.length} blocks in a 21-minute class`);
});

test("a cue stops speaking for the class once it is old", () => {
  const block = cues.blocks.find((b) => b.mode === "reps");
  assert(block, "no rep block to check");
  assertEqual(cues.modeAt(block.restatedAt + 1).mode, "reps");
  const stale = cues.modeAt(block.restatedAt + CUE_LIFETIME.reps + 5);
  assert(stale.mode === "unknown" || stale.mode !== "reps",
    "a cue two and a half minutes old is still being believed");
});

test("no transcript is not an error", () => {
  // The app has to work on a video nobody has transcribed, falling back to
  // judging from the instructor's body alone.
  const empty = new CueTrack(null);
  assertEqual(empty.modeAt(100).mode, "unknown");
  assertEqual(empty.blocks.length, 0);
  assertEqual(new CueTrack({ segments: [] }).modeAt(0).mode, "unknown");
});

test("this class asks nobody to hold a pose", () => {
  // Not a defect — a fact about the video, and the most useful thing the
  // transcript established. It is a 21-minute counted cardio and core routine:
  // "simple walk", "high knees", "bicycle movement", "90/90", every set
  // counted to ten and released. There is no asana held still in it.
  //
  // Which means this app, whose instrument is a static pose comparison, has
  // almost nothing to say about this particular class, and the honest
  // behaviour is the quiet it now keeps. Demonstrating posture correction
  // needs a class with held poses in it.
  //
  // If this ever fails, the demo video has been changed — which would be good
  // news, and the numbers in the README need revisiting.
  const holds = cues.cues.filter((c) => c.intent === "hold");
  assertEqual(holds.length, 0,
    `found holds: ${holds.map((h) => `${h.at.toFixed(0)}s "${h.text.slice(0, 40)}"`).join(", ")}`);

  const census = cues.census(35);
  assert((census.reps ?? 0) > 0.15,
    `only ${(100 * (census.reps ?? 0)).toFixed(0)}% of the class is counted repetition`);
});

suite("cue blocks expire");

test("a cue in the future cannot keep the present alive", () => {
  // The bug that left the app silent. Three setup lines at 34.8s, 37.4s and
  // 115.0s merged into one block stamped with the last of them, so at t=60 the
  // cue was reckoned fifty-five seconds in the *future*, its age was negative,
  // and the mode never expired. Six minutes of class, nine seconds judged.
  const track = new CueTrack({
    duration: 300,
    segments: [
      { from: 34.8, text: "Let's start with a simple walk." },
      { from: 37.4, text: "Let's start with a simple walk." },
      { from: 115.0, text: "The next one is high knees again." },
    ],
  });
  assertEqual(track.blocks.length, 2, "the distant third cue should begin its own block");
  assertEqual(track.modeAt(40).mode, "settling");
  assertEqual(track.modeAt(60).mode, "unknown", "a 25-second-old setup cue is not current");
  assertEqual(track.modeAt(100).mode, "unknown", "nor a 65-second-old one");
  assertEqual(track.modeAt(117).mode, "settling", "the second setup cue should be current");
});

test("restating a transition does not extend it, restating an activity does", () => {
  // A teacher who keeps giving setup instructions is not evidence that the
  // student is still getting into position. A teacher still counting is
  // evidence that the set is still running.
  const setup = [];
  for (let t = 0; t < 60; t += 5) setup.push({ from: t, text: "Now take your hands up." });
  const settling = new CueTrack({ duration: 120, segments: setup });
  assertEqual(settling.modeAt(55).mode, "unknown",
    "repeated setup lines kept the student 'getting set' for a minute");

  const counting = [];
  for (let t = 0; t < 60; t += 5) counting.push({ from: t, text: "1, 2, 3, 4, 5, 6." });
  const reps = new CueTrack({ duration: 120, segments: counting });
  assertEqual(reps.modeAt(55).mode, "reps", "a set still being counted should still be a set");
});

test("the real class leaves most of itself open to judgement", () => {
  // With the expiry working, speech suppresses the parts it knows are
  // unjudgeable and hands the rest back to geometry. Before the fix this was
  // 2%, which is the same thing as an app that does not work.
  const census = cues.census(35);
  assert((census.unknown ?? 0) > 0.25,
    `only ${(100 * (census.unknown ?? 0)).toFixed(0)}% of the class is handed back to geometry`);
  assert((census.settling ?? 0) < 0.35,
    `${(100 * (census.settling ?? 0)).toFixed(0)}% of the class reads as "getting set"`);
});

suite("when to start paying attention");

test("the two detectors corroborate each other", () => {
  // Arrived at from completely different data — one from how the instructor's
  // body moves, the other from what they say — and they agree to within a
  // second. That agreement is the main evidence either of them is right.
  const body = track.startsAt;
  const words = cues.firstInstructionAt;
  assert(Number.isFinite(body) && Number.isFinite(words),
    `body ${body}, words ${words}`);
  assert(Math.abs(body - words) < 5,
    `body says ${body.toFixed(1)}s and words say ${words.toFixed(1)}s`);
});

test("the earliest detector wins", () => {
  assertEqual(classStartsAt(35.7, 34.8), 34.8);
  assertEqual(classStartsAt(34.8, 35.7), 34.8);
  assertEqual(classStartsAt(20, null), 20);
  assertEqual(classStartsAt(null, 20), 20);
});

test("a stuck gate cannot silence the whole class", () => {
  // The failure this backstop exists for. A gate that never opens suppresses
  // every form of guidance for the entire class, and from the outside that is
  // indistinguishable from the app being broken — it was reported that way
  // twice before the cap existed.
  assertEqual(classStartsAt(600, 900), MAX_GREETING_SECONDS);
  assert(classStartsAt(600, 900) <= 77,
    "a class whose first exercise is at 1:17 must be being watched by then");

  // A detector reporting "never" is the same as having no opinion, and falls
  // through to starting immediately rather than to the cap. Both are safe; this
  // is the safer of the two.
  assertEqual(classStartsAt(Infinity, Infinity), 0);
});

test("no detector at all means start immediately", () => {
  // The gate exists to skip a greeting. A greeting nobody detected is not a
  // reason to wait, and failing closed here is what leaves a student
  // unattended.
  assertEqual(classStartsAt(null, null), 0);
  assertEqual(classStartsAt(undefined, undefined), 0);
  assertEqual(classStartsAt(NaN, NaN), 0);
});

test("a nonsensical detector reading is ignored, not believed", () => {
  assertEqual(classStartsAt(-5, null), 0, "a negative start is no start at all");
  assertEqual(classStartsAt(NaN, 40), 40, "NaN should not poison the minimum");
});
