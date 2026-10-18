/**
 * What the instructor is asking for, from what they say.
 *
 * Body tracking says what shape the instructor is in. It cannot say what they
 * *want*, and that is the difference between a student who is correctly holding
 * a pose while the teacher steps out of it to explain, and a student who has
 * stopped following. An earlier version of this app inferred the difference
 * from how still the instructor was, which worked about three quarters of the
 * time and was wrong in a way that felt robotic: it corrected people for doing
 * exactly what they had been told to do.
 *
 * This reads the instruction instead. The transcript comes from
 * tools/transcribe-instructor.py — Whisper, offline, once — and what matters is
 * not the words but which of a few things the teacher is doing with them:
 *
 *   start      naming a movement or pose and setting it up. The student is
 *              getting into position and is not yet doing anything to judge.
 *   count      counting repetitions. The student is moving, dynamically and on
 *              their own rhythm, and comparing them to one frame of video is
 *              meaningless.
 *   hold       asking the student to stay. This is the only mode where a
 *              static pose comparison is the right instrument, and it is where
 *              the whole app earns its keep.
 *   release    coming out of it. Whatever was being corrected is finished.
 *   aside      explaining, encouraging, addressing the room, naming the person
 *              on the mat next to them. The practice does not change, so
 *              neither does the reference.
 *
 * `aside` is the important one and the reason this file exists. It is also the
 * most common thing a teacher says.
 *
 * The lists below were written from the demo class's own transcript rather than
 * imagined, and tests/cues.test.js checks them against real lines from it. They
 * are English because the transcriber translates to English — the class is
 * delivered in Hindi and English mixed in the same sentence, and matching two
 * languages at once is a much worse problem than translating first.
 */

/** A number word or digit, for spotting a count. */
const NUMBER = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b/gi;

/**
 * Asking the student to stay where they are.
 *
 * Deliberately not the bare word "hold". This class says "hold your hands
 * together like this" and "hold your arms up", which are instructions to *get*
 * somewhere, not to stay — and treating them as sustain cues would freeze the
 * reference on a pose the student had not reached yet. So "hold" only counts
 * with something after it that means the position rather than a body part.
 */
const HOLD = [
  /\bhold (it|this|that|here|there|the (pose|position|posture)|for)\b/i,
  /\b(stay|remain|staying) (here|there|in this|like this|put|where)\b/i,
  /\bkeep (holding|the pose|this pose|staying)\b/i,
  /\b(don'?t|do not) move\b/i,
  /\bbreathe (here|in this|deeply here)\b/i,
  /\b(five|ten|three|\d+) more (seconds|breaths)\b/i,
  /\bhold\b.*\b(seconds|breaths)\b/i,
];

/** Coming out of whatever was being done. */
const RELEASE = [
  /\brelax\b/i,
  /\brelease\b/i,
  /\bcome (up|back|out|down)\b/i,
  /\b(and|then) rest\b/i,
  /\blet (it|that )?go\b/i,
  /\bother side\b/i,
  /\bswitch (sides|legs|the side)\b/i,
  /\bchange (sides|legs)\b/i,
];

/**
 * Naming or setting up the next thing.
 *
 * Broad on purpose. A false `start` costs a few seconds of silence while the
 * student is assumed to be getting into position; a missed one leaves the
 * previous pose as the reference after the class has moved on, which produces a
 * correction against something nobody is doing any more.
 */
const START = [
  /\b(the )?next (one|movement|exercise|pose) is\b/i,
  /\bwhat we (do|are doing) is\b/i,
  /\bwe (will|are going to) do\b/i,
  /\blet'?s (start|begin|go|do|try)\b/i,
  /\bgo for it\b/i,
  /\bcome (in)?to\b/i,
  /\bnow (we|you|keep|take|lift|bring|sit|stand|place)\b/i,
  // "hold your hands together", "hold your toes" — positional instructions,
  // and so a setup rather than a sustain. The HOLD patterns run first and claim
  // the sustain sense, so adding "hold" here cannot swallow it.
  /\b(take|keep|lift|bring|place|put|hold) your\b/i,
  /\bsit (in|down)\b/i,
  /\bstand (up|with)\b/i,
];

/**
 * Is this line counting repetitions?
 *
 * Four number tokens rather than one, because "repeat 20 times" and "two
 * components of exercise" are not counts and a single number is not evidence.
 * Whisper also degenerates on counting audio — one segment of this class is the
 * digit 6 repeated ninety times — which this happens to catch rather than choke
 * on, since a degenerate repetition is still unmistakably a count.
 */
function isCount(text) {
  const matches = text.match(NUMBER);
  return !!matches && matches.length >= 4;
}

/**
 * Classify one spoken line.
 *
 * Order is the whole design. A line that both counts and releases — "3, 2, 1,
 * relax" is said at the end of nearly every set in this class — is a release,
 * because what matters is that the set is over. A line that both starts and
 * counts is a start that ran into its own count, and the count will arrive
 * again on the next line.
 */
export function classify(text) {
  if (!text || !text.trim()) return "aside";
  const matched = (patterns) => patterns.some((p) => p.test(text));

  if (matched(RELEASE)) return "release";
  if (matched(HOLD)) return "hold";
  if (isCount(text)) return "count";
  if (matched(START)) return "start";
  return "aside";
}

/**
 * How long a cue still describes what is happening.
 *
 * A teacher who said "stay here" ninety seconds ago is not still saying it, and
 * carrying a cue forever turns one mishearing into a permanently wrong app.
 * Past these, the mode falls back to `unknown` and the caller decides what to
 * do without speech — which for this app means the geometric test it used
 * before any of this existed.
 */
export const CUE_LIFETIME = {
  holding: 90,
  reps: 150,
  settling: 20,
  resting: 25,
};

/**
 * How close two cues of the same kind have to be to count as one stretch of the
 * same instruction.
 *
 * Without this, every cue of a kind merges into a single block, and that
 * block's "last restated" time can sit in the future relative to the moment
 * being asked about — so the mode never expires. In the demo class the three
 * setup lines at 34.8s, 37.4s and 115.0s became one block stamped 115.0s: at
 * t=60 the cue was reckoned fifty-five seconds in the future, the mode stayed
 * "settling" for eighty seconds, and the app judged nothing for the whole of
 * it. Nine seconds of a six-minute stretch were judged at all.
 */
const MERGE_WITHIN = 8;

/**
 * Which modes a restatement genuinely extends.
 *
 * Counting and holding are sustained activities: "seven, eight" or "stay with
 * it" means the thing is still going on. Setting up and resting are
 * transitions, and a teacher who keeps giving setup instructions is not
 * evidence that the student is still getting into position — so those expire
 * from when they began, however often they are restated.
 */
const REFRESHES = { reps: true, holding: true, settling: false, resting: false };

/** What a classified cue means for the student. */
const MODE_OF = {
  hold: "holding",
  count: "reps",
  start: "settling",
  release: "resting",
};

/**
 * The instructor's spoken instruction, as a function of video time.
 *
 * Built once, at load. The same shape and the same reasoning as
 * InstructorTrack: a fixed recording says the same thing every time anybody
 * watches it, so this is a timeline to be looked up rather than a judgement to
 * be made thirty times a second.
 */
export class CueTrack {
  constructor(transcript) {
    this.duration = transcript?.duration ?? 0;
    this.complete = transcript?.complete !== false;

    const segments = (transcript?.segments ?? [])
      .filter((s) => s && s.text && Number.isFinite(s.from))
      .sort((a, b) => a.from - b.from);

    this.cues = segments.map((s) => ({
      at: s.from,
      intent: classify(s.text),
      text: s.text,
    }));

    // Blocks of mode, each starting where a cue changed it. An `aside` changes
    // nothing — the practice carries on through an explanation, which is the
    // entire point of reading the words rather than watching the body.
    this.blocks = [];
    for (const cue of this.cues) {
      const mode = MODE_OF[cue.intent];
      if (!mode) continue;
      const last = this.blocks[this.blocks.length - 1];
      if (last && last.mode === mode && cue.at - last.restatedAt <= MERGE_WITHIN) {
        last.restatedAt = cue.at;
        continue;
      }
      this.blocks.push({ mode, from: cue.at, restatedAt: cue.at, text: cue.text });
    }
  }

  static async load(url = "media/instructor-transcript.json") {
    const response = await fetch(url);
    // A missing transcript is not an error. The app falls back to judging from
    // the instructor's body alone, which is what it did before.
    if (!response.ok) return null;
    return new CueTrack(await response.json());
  }

  /**
   * When the instructor first said something that was an instruction rather
   * than talk — the class beginning, in words.
   *
   * An independent reading of the same event the body-movement detector looks
   * for, and a corroboration of it: speech says 34.8s for the demo class and
   * geometry says 35.7s, arrived at from completely different data.
   */
  get firstInstructionAt() {
    return this.blocks.length ? this.blocks[0].from : null;
  }

  /** Index of the last block starting at or before `t`. */
  blockAt(t) {
    let low = 0, high = this.blocks.length - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.blocks[mid].from <= t) { found = mid; low = mid + 1; } else high = mid - 1;
    }
    return found;
  }

  /**
   * What the student has been asked to be doing at video time `t`.
   *
   * `mode` is holding | reps | settling | resting | unknown, and `since` is
   * when it was last said — the caller wants that, because the instructor's
   * shape at the moment they said "stay here" is the pose to hold them to, not
   * the shape they have wandered into since.
   */
  modeAt(t) {
    const i = this.blockAt(t);
    if (i < 0) return { mode: "unknown", since: null, text: null };
    const block = this.blocks[i];
    const anchor = REFRESHES[block.mode] ? block.restatedAt : block.from;
    const age = t - anchor;
    if (age > (CUE_LIFETIME[block.mode] ?? 60)) {
      return { mode: "unknown", since: null, text: null, stale: block.mode };
    }
    return { mode: block.mode, since: block.from, text: block.text };
  }

  /** Fraction of the class spent in each mode — for sanity, and for the README. */
  census(from = 0, step = 1) {
    const counts = {};
    let n = 0;
    for (let t = from; t < this.duration; t += step) {
      counts[this.modeAt(t).mode] = (counts[this.modeAt(t).mode] ?? 0) + 1;
      n++;
    }
    for (const key of Object.keys(counts)) counts[key] /= n || 1;
    return counts;
  }
}
