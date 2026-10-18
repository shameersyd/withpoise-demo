/**
 * How often to run detection.
 *
 * Left alone, the pump runs inference back to back: one frame in flight at a
 * time, the next sent the instant the last returns. On a phone that cannot keep
 * up this pins the CPU or GPU at full tilt, and the cost does not land on
 * detection — it lands on the render loop, the camera and the compositor. The
 * overlay stutters, the device gets hot, and the detection rate you end up with
 * is whatever is left over, varying frame to frame.
 *
 * So the rate is chosen rather than discovered. Inference time is measured, a
 * sustainable rate is picked from it, and detection is paced to that rate
 * independently of the render loop, which goes on painting at display rate from
 * the last result either way.
 */

// Candidate rates in Hz, fastest first. Stepping between a few fixed rates
// rather than tracking a continuous one keeps the interval stable enough to
// reason about, and stable is the point.
export const DETECT_RATES = [30, 15, 10];

// Inference may occupy at most this share of a detection period. The rest pays
// for grabbing the frame, posting it, and everything else the device is doing.
export const HEADROOM = 0.8;

export class FrameBudget {
  constructor({ rates = DETECT_RATES, headroom = HEADROOM,
                smoothing = 0.15, stepUpMargin = 1.25 } = {}) {
    this.rates = [...rates].sort((a, b) => b - a);
    this.headroom = headroom;
    this.smoothing = smoothing;
    this.stepUpMargin = stepUpMargin;
    this.reset();
  }

  reset() {
    this.ema = null;
    this.hz = this.rates[0];     // optimistic until measured
    this.lastSentAt = -Infinity;
    this.samples = 0;
  }

  get intervalMs() { return 1000 / this.hz; }

  /** Milliseconds of inference this detection period must accommodate. */
  get required() {
    return this.ema === null ? 0 : this.ema / this.headroom;
  }

  /** Feed one measured inference time. */
  record(inferenceMs) {
    if (!(inferenceMs >= 0)) return;
    this.samples++;
    this.ema = this.ema === null
      ? inferenceMs
      : this.ema + this.smoothing * (inferenceMs - this.ema);

    // A handful of samples first: the first inference of a session includes
    // warm-up and is not representative of anything.
    if (this.samples >= 3) this.choose();
  }

  choose() {
    const need = this.required;
    for (const hz of this.rates) {
      // Slowing down happens as soon as the budget says so; speeding up has to
      // clear a margin, or a rate sitting near a boundary oscillates.
      const margin = hz > this.hz ? this.stepUpMargin : 1;
      if (1000 / hz >= need * margin) { this.hz = hz; return; }
    }
    this.hz = this.rates[this.rates.length - 1];
  }

  /** Is another detection due? */
  due(now) { return now - this.lastSentAt >= this.intervalMs; }

  markSent(now) { this.lastSentAt = now; }
}
