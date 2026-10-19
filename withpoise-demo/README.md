# withpoise — follow-along demo

Watch a yoga class and get corrected while you follow it. The instructor's video
plays full-screen; your camera watches you but is never shown. When your shape
drifts from theirs the class pauses, your body is drawn over the instructor's —
theirs in one colour, yours in another — and you get one instruction, spoken and
written. When you fix it, all of that disappears and the class resumes.

Nothing appears while you are following correctly. That is the whole design.

```
python3 ../serve-demo.py
```

Then open the printed URL on your phone, on the same Wi-Fi, and accept the
certificate warning. HTTPS is not optional — browsers refuse camera access
without it.

### Getting the video

The instructor's video is not in the repository: it is 318 MB, past what GitHub
accepts, and it is somebody else's class. **Ask the author for the media file**,
and save it as exactly:

```
withpoise-demo/media/instructor.mp4
```

It must be that file, not another copy of the same class. Every timing in the
app and the traced instructor (`media/instructor.json`) is tied to it, and a
re-encode shifted by a fraction of a second puts the coaching out of step with
the instructor. To check:

```
shasum -a 256 withpoise-demo/media/instructor.mp4
# 1aba4eea2c3e184d84f51a98b80194542df96af4895a2b6adbc857857437f4af
```

The path is gitignored, so it cannot be committed by accident. `serve-demo.py`
warns at startup if it is missing. Nothing else needs installing: Python 3 and
`openssl` for the server, Chrome for the app, and an internet connection the
first time, to fetch the pose model.

> The original six-pose app is untouched in `../yoga_app/`. This is a separate
> application that shares its measurement core; neither can break the other.

## Standing where you can be seen

**The class does not begin until enough of you is in the picture.** The video is
held on the instructor introducing the exercise, the app says what is wrong, and
it starts once your shoulders, hips and knees have all been in shot for just
over a second.

This exists because of what happens without it. Recorded from a real session: a
student standing a normal distance from a propped-up phone had their nose at
y=0.59 and their hips at y=1.37 — below the bottom edge. Shoulders scored
94–100% reliable, elbows 54–60%, wrists 12%, and hips, knees and ankles 0%.
Coverage never rose above 0.32 against the 0.5 a verdict needs.

The app was right to refuse to judge on that, and said nothing about it for
thirty seconds. Being *detected* and being *usable* are different things and
only the first was ever checked — and because silence is this design's normal
state, there was nothing to tell "you are doing fine" apart from "I cannot use
any of this". `tests/fixtures/session-too-close.json` is that recording, and
`tests/session.test.js` holds the behaviour down against it.

It is the first fixture here that is neither synthetic nor the instructor's own
body replayed back at itself, and it found in one pass what three rounds of
reasoning had not.

## When it starts watching

Nothing happens until the instructor is actually practising. Classes open with a
greeting — a word about what is coming, sometimes a story — and during it there
is nothing to follow, so correcting anybody would be not merely unhelpful but
wrong. The demo video talks for its first **35 seconds**.

That moment is measured off the trace, not hand-set, on two conditions:

- **The instructor has to be a usable reference** — every scored landmark
  confident and inside the frame. This is not a heuristic: with their legs out of
  shot there is nothing to compare a user's legs against. It covers the
  talking-head opening most classes have; in the demo video the instructor's
  ankles score 0.00 visibility for the first thirteen seconds.
- **They have to be moving**, sustained. Standing full-body in frame and talking
  passes the first condition, so this is what separates it from practice.
  Measured across this class, standing and talking runs at a shape speed of
  0.24–0.36 and practice at 0.8–1.4 — the threshold sits in the gap.

Movement starts the class and is not required to continue it: a held pose is
motionless, and is exactly when coaching matters most. A trace can also carry an
explicit `startsAt` and be believed over the detection, because tracing is an
offline step with a human present, and a human who has watched the video knows
better than this does.

Until then the status dot sits muted and says *waiting for the class*, and the
app says nothing at all — including nothing about not being able to see you. You
may still be unrolling a mat.

## What the class is asking for

The instructor's **words** decide this, not their body.

Inferring intent from how still the instructor was got it right about three
quarters of the time, and was wrong in the way that matters most: it corrected
people for doing exactly what they had been told to do. So the class is
transcribed offline, once, and each spoken line is read as one of five things:

| cue | what it means for the student | what the app does |
|---|---|---|
| `hold` | stay where you are | **correct form** — the only mode a static pose comparison fits |
| `count` | repetitions are being counted | nothing; they are moving on their own rhythm |
| `start` | a movement has just been named | nothing; they are getting into it |
| `release` | come out of it | nothing |
| `aside` | explaining, encouraging, addressing the room | **nothing changes** — the practice carries on |

Form correction is suppressed outside `hold`, but **"are you doing this at all"
is asked throughout**. Those are different questions and collapsing them was a
real bug: with no `hold` cues anywhere in the demo video, the app judged nine
seconds of a six-minute stretch and said nothing to somebody standing motionless
through three sets. It now notices that within about five seconds of the class
starting.

The two questions also need different measures, which took measuring to find:

- **Form** rides on the *worst* weighted segment. A teacher looks at the knee,
  not at an average.
- **Following** rides on *how much* of the body is in the wrong place — neither
  the worst part nor the average. Severity saturates (one heaviest segment fully
  wrong already reads 1.00, so a collapsed knee is indistinguishable from a body
  in the wrong place), and the weighted mean separated by only three points.
  The share of the body out of tolerance separates cleanly, provided most of the
  body is measurable at all — a statement about the whole of somebody cannot be
  made from a quarter of them.

`aside` is the one that matters, and it is the most common thing a teacher says:
109 of this class's 169 spoken lines. None of them may move the reference. That
is the fix, and it is a fact about language rather than a threshold that needed
tuning.

When a cue is older than its lifetime, or there is no transcript at all, the app
falls back to the geometric test described below. A missing transcript is not an
error.

### What the transcript revealed about the demo video

Worth stating plainly, because it changes what this demo can show: **the demo
video asks nobody to hold a pose.** Zero `hold` cues in twenty-one minutes.

It is a counted cardio and core routine — "simple walk", "high knees", "elbow to
the knee", "bicycle movement", "90/90", "sumo squat" — every set counted to ten
and released, finishing with breathing. Measured from the cues, after the
greeting ends:

```
counted repetition   25%
no recent cue        37%   → handed back to the geometric test
resting              24%
getting into it      14%
holding a pose        0%
```

This app's instrument is a comparison between two static shapes. Against a class
like this it has little to say about *form* — but it can still tell whether you
are doing the class, and that turned out to be the useful thing to say about a
video like this one. Judging someone's form from one frame of
video while they are doing their eighth of twenty bicycle crunches is not a
threshold problem; the information is not there. It is in the whole rep — see
*Repeated movements* below.

**Demonstrating posture correction needs a class with held poses in it** — any
asana class where the teacher says "stay here and breathe". The `hold` patterns
are written and tested against exactly those lines, which this video never says.

## Repeated movements

A jumping jack is judged **one rep at a time**, never frame by frame, and the
class is **never paused to correct it**.

Frame-by-frame comparison was measured doing the wrong thing here. In a recorded
session it took 62 seconds to get through 9 seconds of class: it stopped
repeatedly to say "take your left hand further out to the side" partway through
a jump. While the class was frozen, the student kept doing jumping jacks.

So `reps.js` splits the movement into reps and reduces each one to a few numbers
in the student's own body units:

- **reach**: how far the wrists rise above the shoulders, in torso lengths
- **feet**: the distance between the ankles, in shoulder widths
- whether the hands and feet come back at the bottom
- whether arms and feet peak together

These are compared with the instructor's typical rep, measured from their own 17
reps in the trace: reach +0.72, feet 1.45 open and 0.31 closed, arms and feet in
phase. Timing doesn't matter. A student who is half a beat behind, faster, or
mirrored is compared on what their rep looked like, not on when it happened.

What the student gets (`RepCoach` in `coaching.js`):

| when | what happens |
|---|---|
| reps look like the instructor's | nothing |
| a fault in 2 of the last 3 reps | a short cue, said at the top of a rep so it is heard on the way down: *"Arms all the way up."*, *"Jump your feet wider."*, *"Arms and feet together."*. The class's sound is muted while it is said, and the cue stays up as a caption until it is fixed |
| at the top of every rep after that | for about a second and a half, two stick figures on the instructor, as for a held pose: the instructor's body at the top of their rep (black) and yours at the top of yours (red), rebuilt at the instructor's size, with arrows from your hands or feet to theirs. Mirrored, so your left is on the screen's left |
| every 3 reps without a fix | said again, alternating with a second wording (*"Reach higher — hands above your head."*), never closer than 3.5 seconds |
| the first rep that gets there | *"That's it."*, and your figure turns green |
| feet left apart at the bottom, arms not all the way down | marker only, never said: real, but minor next to the others |

The only pause left is for a student who has stopped moving altogether. That is
judged on movement alone, because the shape of a correct jumping jack is "wrong"
for most of every rep.

The margins are set against three recorded sets by one student (2026-10-17, in
`tests/fixtures/session-*.json`): good form, hands stopping near the shoulders,
and feet barely opening. On the good set the student reached +0.62 to +0.84,
opened their feet 1.2 to 2.3 shoulder widths, and closed them only to hip width
(0.44–1.22), which the first margin for feet at the bottom (0.76) called a fault.
That margin is now 1.41, and that fault is never spoken. The short-armed set
reached +0.08 to +0.29 and the narrow set opened 0.42 to 0.71, both well clear.
All three are tests: the good set must be silent, the others must be named
within a few seconds and reminded to the end.

What those sets also showed: the first build said each correction once, about
seven seconds into the set, over the instructor's audio, then gave up after five
reps for fourteen seconds. The student heard none of it. That is why the cue
now comes sooner, repeats, mutes the class and stays on screen.

The faults are also tested on the instructor's real reps bent out of shape: arms
stopping at the shoulders, feet barely opening, legs only, arms only, one arm
low, and feet a third of a rep behind the arms.

## How it was wrong before

The instructor's current shape is not the thing to copy. Instructors demonstrate
a pose, hold it, then **come out of it to explain** — walking, gesturing, talking
to camera — while the student stays put. Measured over the demo class, the
instructor leaves a pose by 46–177° on the worst segment and returns to within
12° of it, at least twenty times.

The app used to compare against whatever they were doing at that instant, so a
student correctly holding was corrected for holding. Of eight such episodes,
three scored badly enough to stop the class and zoom in on somebody doing
exactly the right thing. That is what "robotic" meant.

So the reference is not the instructor's current frame. It is two things
together:

- **Poses they settled into, over the last 20 seconds.** Settled means the shape
  has not moved more than 14° across the preceding 1.5s. Gesturing, walking and
  transitions cannot satisfy that, which is the point — an explanatory aside is
  structurally incapable of becoming the thing a student is held to. 21% of this
  class's frames are settled.
- **Every frame from the last 4 seconds.** The ordinary following lag, plus the
  poses held too briefly or too unsteadily to count as settled. This is not a
  hedge: at 224s a student holds the pose from 214s, the instructor steps away
  and returns — and that pose never qualifies as settled, so on settled poses
  alone the app called a correct student completely wrong, at severity 1.00.

Twenty seconds of *every* frame would also fix that, and was measured doing so,
but it dilutes: a student in an entirely different pose scored 0.01 against
twenty seconds of arbitrary transitional frames, because somewhere in a hundred
and twenty of them is a shape resembling almost anything.

**When the instructor is in continuous motion with nothing settled behind them —
a flowing sequence — the app says nothing.** Form cannot meaningfully be
corrected against a reference that is itself mid-movement two seconds ago. 75%
of the class has a settled pose within the memory and stays coachable; the rest
goes quiet. And a correction already on screen is *released* when the class
moves on, rather than held open — being stuck in a paused, zoomed correction the
class has moved past is the worst of both.

What this gives up: a student still holding a pose the class left twenty seconds
ago reads as correct. That is a pacing error, not a form error, and this does not
claim to teach pacing.

It is also worth being plain that none of this is understanding what the
instructor *said*. "Stay here" versus "now switch sides" is in the audio, and
nothing here listens. That is the real answer to this problem and it is a much
larger piece of work.

## How it compares two different people

The hard part is not detecting your pose. It is that you and the instructor are
different sizes, different proportions, standing at different distances from
different cameras, and you are a second or two behind.

- **Directions, not positions.** Each of nine body segments is reduced to the
  direction it points, in a frame built from your own hips and shoulders. That
  makes the comparison independent of your size, your position in the frame and
  which way you are facing. A tall person and a short person doing the same pose
  produce the same numbers.
- **The worst limb decides, not the average.** Nine segments averaged will hide
  the one thing that is wrong — a collapsing knee against eight good segments
  moves a mean by five points. A teacher does not average you; they look at the
  knee. The aggregate score is shown; the decision to interrupt rides on the
  worst segment, weighted by how much that segment matters to the pose.
- **Either way round.** Instructors face the camera and mirror; some do not.
  Every frame is scored both direct and mirrored and the better reading wins, so
  nobody has to be told which convention the class uses.
- **A memory, not an instant.** Your pose is compared against everything the
  class has recently asked for, and the best match counts. You are following,
  not synchronised — see *What the class is asking for* above.
- **Only what both cameras can see.** A segment is scored where your camera
  resolved it *and* the instructor's did; either one missing leaves it unscored
  rather than scored against a guess. This matters more than it sounds: only 34%
  of this class has the whole instructor in frame — 31% has the legs with the
  arms cropped, 35% the arms with the legs cropped. Two thirds of a yoga video
  is somebody partly out of shot, and the landmarker reports those joints
  anyway, pinned wherever it guesses they are past the frame edge.

## What it will not do

- **Interrupt a pose it has not been wrong about for a while.** 1.8 seconds of
  sustained fault before the class stops, and half a second of correctness to
  resume. Everybody is mid-transition some of the time.
- **Stop a set of repetitions to fix your form.** Repeated movements are coached
  in rhythm while the class plays. See *Repeated movements*.
- **Talk over the instructor.** One instruction at a time, held until it is acted
  on rather than cycled; five seconds minimum between anything spoken, fourteen
  before the same words repeat.
- **Tell you to step back the moment it loses you.** Four seconds of genuine
  absence first, and never during the greeting. Dropping a detection for a beat
  is ordinary and must not become a sentence.
- **See a limb rotated about its own length.** An arm hanging at your side,
  rotated 50° about the vertical, points where it did. This is arithmetic, not a
  tuning problem — it is the same fact that makes joint angles blind to rotation
  — and it means the standing-rest parts of a class are the parts it sees least.
  `tests/follow.test.js` pins the size of the blind spot rather than hiding it.
- **See a knee collapse on a straight leg.** A knee rotating inward turns about
  the line from its own hip to its own ankle, and on a straight standing leg the
  knee is *on* that line. Visible in the wide stances, invisible in the narrow
  ones. Same arithmetic.
- **Know anything about depth it has not been told.** One camera, one phone
  against a wall. `../docs/LIMITS.md` is blunt about what that costs and applies
  here unchanged.

## Which body is the instructor

The class is filmed with **two people on two mats**: the teacher, who speaks,
and a student following beside them. Tracking the wrong one would make every
correction nonsense; tracking whichever one the detector ranked first would make
it nonsense intermittently, which is worse.

The teacher is the one nearer the camera — placed there so viewers can see them
— so the tracer asks for two poses and keeps the larger torso. Identified from
the video itself: at 20s the person on the right is mid-gesture addressing the
camera under the subtitle "But exercise is still", while the person on the left
stands with their hands at their sides.

Verified over the whole trace: the chosen body is the right-hand one in 7,629 of
7,639 frames, and the ten exceptions are in the opening seconds where the
teacher is a talking head and fails the measurability test anyway. Two tests
hold it down — one for consistency (a person does not teleport across the room
between frames) and one for side.

## The instructor track

Two offline passes over the video, both once-per-video and both producing output
that is identical on every run.

```
python3 ../tools/trace-instructor.py --fps 6      # the body
python3 ../tools/transcribe-instructor.py         # the words
```

The second runs Whisper in WebAssembly in headless Chrome — about 5× realtime
on this machine, so a twenty-minute class takes four minutes — and writes
`media/instructor-transcript.json`. The class is delivered in Hindi and English
mixed within single sentences, so the task is `translate`: matching cue words in
two languages at once is a much worse problem than translating first. The
transcript is small enough (14 KB) to commit, unlike the video.

Whisper is lossy on this material and the transcript shows it — names come
through mangled, and it degenerates on counting audio, one segment being the
digit 6 repeated ninety times. Neither matters much here, because the cues
being looked for are short imperatives rather than prose, and a degenerate
repetition is still unmistakably a count.

The instructor's pose is traced **offline, once**, not detected live. Two
detections per frame would double the inference cost on a phone that is already
the bottleneck, and the instructor's pose is identical on every run.

```
python3 ../tools/trace-instructor.py --fps 6
```

This drives headless Chrome through `../tools/trace-instructor.html`, seeking the
video and running the heavy model at each sample point, and writes
`media/instructor.json` incrementally — so a tracing run can be interrupted and
the file is usable at whatever point it got to. It keeps 13 of the 33 landmarks,
which is everything the nine scored segments need and nothing else.

Two things worth knowing:

- **The video has to be same-origin.** A cross-origin YouTube iframe cannot be
  pose-detected at all: reading pixels out of it taints the canvas. The demo
  needs the file itself, which is why `media/*.mp4` is gitignored rather than
  absent.
- **Seeking needs HTTP Range.** `python3 -m http.server` does not implement it,
  which makes the video unseekable and the tracer unable to sample it. Both
  servers here do.

## Tests

```
tests/run.sh      # the comparison, the interrupt policy, the cues, the armature
tests/smoke.sh    # does the class actually start? (needs Chrome and a network)
tests/probe.sh 50 # what is the app deciding at 50s into the class, and why?
tests/probe.sh 80 probe-body still          # a student who has stopped moving
tests/probe.sh 80 probe-body correct-later  # …who then starts following
tests/probe.sh 80 probe-body short-arms-fix # jumping jacks, hands to the shoulders, then fixed
tests/probe.sh 80 probe                     # an empty room: must never start
```

To record a real session, serve with `serve-demo.py` and open the app with
`?debug=1&record=1`. It writes `recordings/<exercise>-<timestamp>.jsonl` — every
landmark the camera saw and every number the app decided on. `?fresh=1` clears a
stale service worker, and the `?debug=1` overlay carries a build stamp so a
device running cached code can be told apart from a fix that did not work.

`probe-body` feeds the app a body through a `?debug=1` test hook, because pose
detection needs a camera pointed at a person and no automated test has one. It
is the only thing here that exercises what the product actually is — the pause,
the zoom, the armature and the voice, for a student doing the class wrong — and
the first thing it was pointed at found a `ReferenceError` thrown on every
frame that had survived three rounds of debugging.

The probes exist because the first two suites were green throughout all of it.
`run.sh` exercises the comparison and never runs the frame loop; `smoke.sh` runs
the frame loop but only asks whether inference happens. `probe.sh` runs the real
page, jumps the video to a chosen point, and prints the decision every few
seconds — class started, what the instructor is asking for, whether it is
judging, whether it can see anybody, and what it last said. Both bugs were
obvious in one line of its output.

`tests/run.sh` is unusual in one respect worth calling out: its fixtures are the
**real traced instructor**, and the faults are perturbations of that real body —
a limb tilted out of place, a knee collapsed, a pelvis yawed. The original app's
suite ran entirely on synthetic bodies posed from a rig, which proved the math
and proved nothing about a human. These run on landmarks MediaPipe actually
produced from a real person, with the app's own smoothing applied.

That is a real improvement and it is still not the measurement that matters. The
error that dominates everything here is that **you are a different human being
from the instructor**, and perturbing the instructor's own body cannot stand in
for it. The tolerance was set by sweeping it against this class — which is how
it was found to be twice as wide as it needed to be — and it is still measured
against the wrong thing, just more carefully. The first real session is what
settles it.

`tests/smoke.sh` is the one that would notice the landmarker failing to start.
The jsc suite cannot see a worker, MediaPipe or WebGL, and the original app
shipped green through its entire history while inference never ran once.
