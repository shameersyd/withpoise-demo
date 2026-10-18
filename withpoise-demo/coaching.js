/**
 * What to say while someone is following a class, and when to say nothing.
 *
 * The governing rule comes straight from the mocks: there is no additional UI
 * if all is going well. The same is true of the voice. A class that comments
 * on every frame is a class nobody finishes, and the instructor is already
 * talking — anything said here is said over them.
 *
 * So: silent by default, one instruction at a time, and out of the way the
 * moment it is no longer needed.
 */

// Never two corrections closer together than this, even across different
// faults. The instructor is mid-sentence and we are interrupting them.
export const MIN_GAP_MS = 5000;

// And never the same instruction again inside this, unless nothing else is
// wrong. Repetition is how a coach becomes background noise.
export const REPEAT_GAP_MS = 14000;

// A paused class is a different situation: the user is standing still waiting
// to be told what to do, and the instructor is not talking over us.
// How long the user has to be out of frame before it is worth mentioning.
//
// Generous, because the cost is asymmetric: saying nothing for four seconds
// while somebody walks back to their mat costs nothing, and saying "step back
// so I can see you" to somebody already standing there is the app being wrong
// out loud, in the first sentence it ever speaks.
export const MISSING_GRACE_MS = 4000;

/**
 * And how long before the class stops altogether.
 *
 * Letting a class play on to an empty room is the one failure with no upside.
 * Whatever else the app cannot judge, it always knows whether there is a body
 * in front of it, and when there is not, continuing is pointless: either the
 * student is out of shot and practising unguided, or nobody is watching.
 *
 * Longer than the grace above, so the spoken instruction always arrives first
 * and a student who steps back in time is never interrupted at all. Stopping a
 * class is a bigger intervention than mentioning something.
 */
export const MISSING_PAUSE_MS = 7000;

// How much the worst fault has to shrink before it is worth saying "almost".
// A third of the way back, which on the faults this catches is a limb visibly
// on the move rather than a limb that has drifted a degree.
export const NEARLY_FRACTION = 0.7;

export const PAUSED_GAP_MS = 3000;

export const LINES = {
  minor: (fault) => fault,
  criticalOpen: "Hold on — let's fix your posture.",
  nearly: "Almost — just a little more.",
  fixed: "That's it. Nice.",
  lost: "Step back so I can see you.",
  // Different from `lost`, and the difference matters: the student is standing
  // right there and can see themselves on screen, so being told they cannot be
  // seen at all reads as the app being broken. This says what is actually
  // wrong and what to do about it.
  cropped: "Step back — I need to see your whole body, head to feet.",
  // Said when the student is visible, measurable, and doing something else
  // entirely. Phrased as an invitation rather than a correction, because
  // there is nothing to correct — they are not in the pose at all.
  notFollowing: "Let's get you back with the class — follow along with me.",
  resumed: null,            // the class resuming speaks for itself
};

/**
 * Decides the single thing worth saying this frame, or nothing.
 *
 * Returns { text, interrupt } or null. `interrupt` means it should cut off
 * whatever is still being spoken: a correction that arrives after the body has
 * already moved on is worse than silence.
 */
export class FollowCoach {
  constructor(options = {}) {
    this.minGap = options.minGap ?? MIN_GAP_MS;
    this.repeatGap = options.repeatGap ?? REPEAT_GAP_MS;
    this.pausedGap = options.pausedGap ?? PAUSED_GAP_MS;
    this.reset();
  }

  reset() {
    this.lastSpokeAt = -Infinity;
    this.saidAt = new Map();
    this.state = "ok";
    this.focus = null;
    this.announcedCritical = false;
    this.saidNearly = false;
    this.worstSeverity = 0;
    this.missingSince = null;
  }

  say(text, now, { interrupt = false } = {}) {
    this.lastSpokeAt = now;
    this.saidAt.set(text, now);
    return { text, interrupt };
  }

  /**
   * state      ok | minor | critical
   * faults     ranked, worst first
   * severity   how bad the worst fault is now, 0–1, for the "almost" nudge
   * visible    is the user in frame at all
   * listening  is there anything to compare them against — false during the
   *            greeting, mid-flow and between sets. Gates everything about how
   *            the student is doing, and nothing about whether they are there.
   * following  are they attempting the class at all
   * framing    ok | cropped | absent — how much of them is usable
   */
  update({ state, faults = [], severity = 0, visible = true, listening = true,
           following = true, framing = "ok" }, now) {
    const entering = state !== this.state;
    const wasCritical = this.state === "critical";
    this.state = state;

    // "I cannot see you" comes before everything, including before the class
    // has started.
    //
    // This used to sit behind the same gate as form correction, which was
    // wrong twice over. It is not a correction — there is nothing to correct,
    // because there is nobody there — and the moment it matters most is during
    // the greeting, which is exactly when the gate was shut. A student whose
    // body is out of frame while the instructor is still introducing the class
    // is a student with thirty seconds to fix it, and the app said nothing and
    // then stayed silent for the rest of the class because it could not see
    // them. Getting somebody into frame is the one thing that has to work
    // before anything else can.
    if (!visible || framing !== "ok") {
      // Still only once they have genuinely gone, not the instant a detection
      // drops. See MISSING_GRACE_MS.
      if (this.missingSince === null) this.missingSince = now;
      if (now - this.missingSince < MISSING_GRACE_MS) return null;
      if (now - this.lastSpokeAt < this.pausedGap) return null;
      const line = !visible ? LINES.lost : LINES.cropped;
      const saidBefore = this.saidAt.get(line);
      if (saidBefore != null && now - saidBefore < this.repeatGap) return null;
      return this.say(line, now, { interrupt: true });
    }
    this.missingSince = null;

    // Everything below is about how the student is doing, and none of it can
    // be said while there is nothing to compare them against — during the
    // greeting, mid-flow, or between sets.
    if (!listening) {
      this.focus = null;
      this.announcedCritical = false;
      this.saidNearly = false;
      this.worstSeverity = 0;
      return null;
    }

    // Not following outranks any form note: there is no point naming a limb to
    // somebody who is not attempting the movement.
    if (!following) {
      this.focus = null;
      this.saidNearly = false;
      if (now - this.lastSpokeAt < this.pausedGap) return null;
      const last = this.saidAt.get(LINES.notFollowing);
      if (last != null && now - last < this.repeatGap) return null;
      return this.say(LINES.notFollowing, now, { interrupt: true });
    }

    if (state === "ok") {
      // Congratulate only on the way out of an interruption. Saying "nice" to
      // somebody who was never corrected is noise.
      if (wasCritical) {
        this.focus = null;
        this.announcedCritical = false;
        this.saidNearly = false;
        this.worstSeverity = 0;
        return this.say(LINES.fixed, now, { interrupt: true });
      }
      this.focus = null;
      this.announcedCritical = false;
      this.saidNearly = false;
      this.worstSeverity = 0;
      return null;
    }

    const gap = state === "critical" ? this.pausedGap : this.minGap;

    if (state === "critical" && !this.announcedCritical) {
      this.announcedCritical = true;
      this.focus = faults.length ? faults[0].segment : null;
      return this.say(LINES.criticalOpen, now, { interrupt: true });
    }

    if (now - this.lastSpokeAt < gap) return null;
    if (!faults.length) return null;

    // Nearly there: said once, and said for *moving*, not for being close.
    //
    // A fixed threshold cannot tell the two apart. The faults this catches sit
    // in a narrow band — a limb 20° out of place and one 35° out of place score
    // within a few points of each other, because seven other segments are fine
    // in both — so "close to correct" is not something an absolute number can
    // pick out. What is unambiguous is whether the fault is shrinking, and that
    // is the thing worth encouraging anyway: a teacher says "almost" when they
    // see you moving, not when they see you stationary and nearly right.
    this.worstSeverity = Math.max(this.worstSeverity, severity);
    const improving = severity < this.worstSeverity * NEARLY_FRACTION;

    if (state === "critical" && improving && !this.saidNearly) {
      this.saidNearly = true;
      return this.say(LINES.nearly, now, { interrupt: true });
    }

    // Stay on one instruction until it is acted on. Cycling through faults is
    // how "one correction at a time" turns back into a running commentary.
    const held = faults.find(f => f.segment === this.focus);
    const pick = held || faults[0];
    if (!pick.text) return null;

    const last = this.saidAt.get(pick.text);
    if (last != null && now - last < this.repeatGap) return null;

    this.focus = pick.segment;
    return this.say(pick.text, now, { interrupt: state === "critical" });
  }
}

// ─────────────────────────────────────────────────────────────
// Coaching a repeated movement
// ─────────────────────────────────────────────────────────────

/**
 * How many recent reps a fault has to show up in before it is mentioned: two
 * of the last three that could be measured. One sloppy rep is noise; two in
 * three is how the student is doing the exercise.
 *
 * It was three of four, judged only once a whole rep had finished. In the
 * second recording that put the first cue five seconds after the first bad
 * rep, by which time the student had done four of them unaware. A rep is now
 * read at its top as well as at its end, so the evidence is in a rep sooner.
 */
export const PERSIST_OF = 3;
export const PERSIST_IN = 2;

/**
 * While a fault goes unfixed, it is said again every this many reps — about
 * every three and a half seconds — in alternating words, with the marker at
 * every top in between.
 *
 * It used to be said once and then dropped after five reps, for fourteen
 * seconds. A student in the second recording did twenty-one short-armed reps,
 * heard one cue they missed under the instructor's voice, and got silence for
 * the rest of the set. Mid-jump, one sentence is easy to miss; a reminder every
 * few reps is what a coach in the room would give.
 */
export const REPEAT_EVERY_REPS = 3;

/**
 * Never two cues closer than this. Shorter than MIN_GAP_MS, which is set for
 * talking over an instructor who is mid-explanation: in a counted set they are
 * counting, and a rep is the natural interval.
 */
export const REP_CUE_GAP_MS = 3500;

export const REP_LINES = {
  fixed: "That's it.",
};

/**
 * Decides what to say, and what to show, during a repeated movement.
 *
 * Fed by RepTracker: `top()` at the top of every rep — the moment anything is
 * said or shown, because the student is on the way down and a cue heard then
 * lands before the next rep starts — and `rep()` when a whole rep has finished,
 * which is when the faults that need the whole rep can be judged. Both readings
 * of one rep go into the same entry, so a rep counts once.
 *
 * One fault at a time, held until it is fixed:
 *
 *   quiet      nothing persistent is wrong. Nothing is said or shown.
 *   cued       a fault was named. At the top of every rep after that, the
 *              marker shows where this rep got to against where it should
 *              have, and the caption keeps the cue on screen. Every few reps
 *              it is said again. The first rep that gets there is told so.
 *
 * A fault marked `spoken: false` goes through the same states with the
 * marker alone.
 *
 * The class is never paused for any of this.
 */
export class RepCoach {
  constructor(faults, options = {}) {
    this.faults = faults;
    this.gap = options.gap ?? REP_CUE_GAP_MS;
    this.reset();
  }

  reset() {
    this.history = [];        // { start, faults } per rep, newest last
    this.focus = null;        // the fault id currently being coached
    this.caption = null;      // what to keep on screen while it is
    this.repsSinceCue = 0;
    this.timesSaid = 0;
    this.fixedPending = false;
    this.lastCueAt = -Infinity;
    this.lastRep = null;
  }

  /** Is `id` wrong in enough of the recent reps to be worth saying? */
  persistent(id) {
    const known = this.history.map((h) => h.faults[id]).filter((v) => v != null).slice(-PERSIST_OF);
    if (known.length < PERSIST_IN) return false;
    return known.filter(Boolean).length >= PERSIST_IN;
  }

  /** One rep's readings, merged into its entry: the top's, then the whole rep's. */
  note(start, faults) {
    const last = this.history[this.history.length - 1];
    if (last && start != null && last.start === start) {
      for (const [id, v] of Object.entries(faults)) if (v != null) last.faults[id] = v;
      return;
    }
    this.history.push({ start, faults: { ...faults } });
    if (this.history.length > PERSIST_OF * 3) this.history.shift();
  }

  /** A whole rep has finished. `faults` is repFaults(rep, reference). */
  rep(rep, faults) {
    this.lastRep = rep;
    this.note(rep.start, faults);
    if (!this.focus) return;

    this.repsSinceCue++;
    // Judged here only for faults the top could not see.
    const definition = this.faults.find((f) => f.id === this.focus);
    if (definition && !definition.atTop && faults[this.focus] === false) this.fixedPending = true;
  }

  /**
   * The top of a rep. `top` is the summary so far, `faults` repFaults(top).
   * Returns { say, marker } — either may be null.
   *
   *   marker   { fault, state: "wrong" | "fixed", top, rep }   what to draw
   */
  top(top, faults, now) {
    this.note(top.start, faults);
    if (this.focus) {
      const definition = this.faults.find((f) => f.id === this.focus);
      if (definition && definition.atTop && faults[this.focus] === false) this.fixedPending = true;

      if (this.fixedPending) {
        const fault = this.focus;
        this.clearFocus();
        // The reps that earned the cue are history now. Left in, they would
        // still count as persistent and raise it again in a few seconds, to
        // somebody who has just been told they fixed it.
        for (const h of this.history) h.faults[fault] = null;
        this.lastCueAt = now;
        return {
          say: definition.spoken === false ? null : REP_LINES.fixed,
          marker: { fault, state: "fixed", top, rep: this.lastRep },
        };
      }

      // Something more important has turned up since — say a minor fault that
      // is only being shown, and now the arms have stopped short. Coach that.
      const rank = this.faults.indexOf(definition);
      const worse = this.faults.slice(0, rank).find((f) => this.persistent(f.id));
      if (worse && now - this.lastCueAt >= this.gap) {
        this.clearFocus();
        return this.top(top, {}, now);
      }

      const marker = { fault: this.focus, state: "wrong", top, rep: this.lastRep };
      if (this.repsSinceCue >= REPEAT_EVERY_REPS && now - this.lastCueAt >= this.gap) {
        return { say: this.cue(definition, top, now), marker };
      }
      return { say: null, marker };
    }

    if (now - this.lastCueAt < this.gap) return { say: null, marker: null };

    for (const fault of this.faults) {
      if (!this.persistent(fault.id)) continue;
      this.focus = fault.id;
      this.timesSaid = 0;
      this.fixedPending = false;
      return {
        say: this.cue(fault, top, now),
        marker: { fault: fault.id, state: "wrong", top, rep: this.lastRep },
      };
    }
    return { say: null, marker: null };
  }

  /**
   * The words for the fault being coached, alternating between its wordings
   * so a reminder does not sound like a loop. Phrased from the rep that best
   * shows it: the top for what the top can see, otherwise the last whole rep.
   */
  cue(fault, top, now) {
    const source = fault.atTop ? top : (this.lastRep || top);
    const lines = fault.cues(source);
    const line = lines[this.timesSaid % lines.length];
    this.timesSaid++;
    this.repsSinceCue = 0;
    if (fault.spoken === false) return null;
    this.lastCueAt = now;
    this.caption = lines[0];
    return line;
  }

  clearFocus() {
    this.focus = null;
    this.caption = null;
    this.repsSinceCue = 0;
    this.timesSaid = 0;
    this.fixedPending = false;
  }
}
