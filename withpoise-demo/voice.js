/**
 * The browser half of the coaching voice: speech, a completion tone, and the
 * on/off switch that has to survive a reload.
 *
 * Kept apart from coach.js so the policy — what to say and when — stays pure
 * and testable. Everything here is a thin adapter over two APIs that fail in
 * their own ways, and it is written to degrade to silence rather than to throw.
 */

const STORAGE_KEY = "yoga.audio";

/** A line not started by now is not going to be. Local voices start within a second. */
const STALL_MS = 2000;

export class Voice {
  constructor() {
    this.synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
    this.ctx = null;
    this.primed = false;
    // What the speech engine actually did with each line: started, ended,
    // or was dropped. The app deciding to speak is not the same as anything
    // being heard, and only these events tell the two apart.
    this.events = [];
    this.seq = 0;
    this._enabled = this.readPreference();
    // Voices a line stalled on, never chosen again this session.
    this.stalledOn = new Set();
    this.voice = null;
    if (this.synth) {
      this.chooseVoice();
      // Chrome lists its voices only after a moment, and says so.
      try { this.synth.addEventListener("voiceschanged", () => this.chooseVoice()); } catch { /* ignore */ }
    }
  }

  /**
   * An English voice that runs on the device.
   *
   * Left to itself, Chrome may speak with one of its "Google … English"
   * voices, which are fetched from a server line by line. When that server
   * does not answer, the line is queued and never started: no sound, no error,
   * and every line after it stuck behind it. A recorded session showed exactly
   * that, eighteen lines asked for and not one started, while the class video
   * played fine. The voices the operating system ships with (Samantha on a
   * Mac) do not depend on anything but the machine.
   */
  chooseVoice() {
    let voices = [];
    try { voices = this.synth.getVoices() || []; } catch { voices = []; }
    const usable = voices.filter((v) => v.localService && !this.stalledOn.has(v.name));
    const english = (lang) => usable.filter((v) => (v.lang || "").replace("_", "-").startsWith(lang));
    // macOS also ships joke voices (Bad News, Bubbles, Zarvox, …) as en-US;
    // a coach should not sing.
    const novelty = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|fred|good news|jester|junior|kathy|organ|ralph|superstar|trinoids|whisper|wobble|zarvox)\b/i;
    const pick = (list) => {
      const plain = list.filter((v) => !novelty.test(v.name));
      return plain.find((v) => v.default) || plain.find((v) => /^(samantha|alex|daniel|karen|moira|tessa)\b/i.test(v.name)) || plain[0];
    };
    this.voice = pick(english("en-US")) || pick(english("en")) || null;
    return this.voice;
  }

  get supported() { return !!this.synth; }

  // localStorage throws outright in some privacy modes, so every touch of it is
  // guarded and the default survives.
  readPreference() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null ? true : stored === "on";
    } catch { return true; }
  }

  get enabled() { return this._enabled; }

  set enabled(on) {
    this._enabled = on;
    try { localStorage.setItem(STORAGE_KEY, on ? "on" : "off"); } catch { /* ignore */ }
    if (!on) this.cancel();
  }

  /**
   * Must be called from inside a real user gesture, once.
   *
   * iOS will not speak and will not start an AudioContext unless the first one
   * of each happens in a tap handler, and it does not tell you it has refused —
   * the session simply runs in silence. So the Begin button pays for both.
   */
  prime() {
    if (this.primed) return;
    this.primed = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) { this.ctx = new Ctx(); this.ctx.resume(); }
    } catch { this.ctx = null; }
    try {
      // A silent utterance is enough to unlock the queue.
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      if (this.voice) u.voice = this.voice;
      this.synth && this.synth.speak(u);
    } catch { /* ignore */ }
  }

  cancel() { try { this.synth && this.synth.cancel(); } catch { /* ignore */ } }

  /**
   * Speak a line. If the engine has not started it within STALL_MS, the voice
   * is written off, the queue cleared, and the line tried once more with
   * another — so one bad voice costs one late line, not a silent session.
   */
  speak(text, { interrupt = false, onDone = null, retry = true } = {}) {
    if (!this._enabled || !this.synth || !text) return;
    try {
      // Chrome and some Android builds park the queue after a quiet spell and
      // then swallow everything sent to it. Nudging it costs nothing.
      if (this.synth.paused) this.synth.resume();

      // Never let a backlog build: by the time three corrections have queued up
      // the body has moved on and every one of them is a lie.
      if (interrupt || this.synth.speaking || this.synth.pending) this.synth.cancel();

      const u = new SpeechSynthesisUtterance(text);
      if (!this.voice) this.chooseVoice();
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice ? this.voice.lang : "en-US";
      u.rate = 1.0;
      u.pitch = 1.0;
      const note = (what) => (e) => {
        this.events.push({ seq: ++this.seq, at: Math.round(performance.now()), what, text, error: e && e.error });
        if (this.events.length > 50) this.events.shift();
      };
      let started = false;
      u.onstart = (e) => { started = true; note("start")(e); };
      u.onend = (e) => { note("end")(e); if (onDone) onDone(); };
      u.onerror = (e) => { note("error")(e); if (onDone) onDone(); };
      // Chrome drops an utterance's events if nothing holds on to it.
      this.current = u;
      this.events.push({
        seq: ++this.seq, at: Math.round(performance.now()), what: "asked", text,
        voice: u.voice ? u.voice.name : "(browser default)",
      });
      this.synth.speak(u);

      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (started || this.current !== u) return;
        const voice = u.voice ? u.voice.name : "(browser default)";
        this.events.push({ seq: ++this.seq, at: Math.round(performance.now()), what: "stalled", text, voice });
        if (u.voice) this.stalledOn.add(u.voice.name);
        this.chooseVoice();
        this.cancel();
        if (retry) this.speak(text, { interrupt: true, onDone, retry: false });
        else if (onDone) onDone();
      }, STALL_MS);
    } catch { /* a voice that throws is still just silence */ }
  }

  /**
   * The completion chime — two rising notes, short. A tone rather than a word
   * because it has to land the instant the hold finishes, and speech does not.
   */
  chime() {
    if (!this._enabled || !this.ctx) return;
    try {
      if (this.ctx.state === "suspended") this.ctx.resume();
      const t0 = this.ctx.currentTime;
      for (const [i, freq] of [660, 990].entries()) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const start = t0 + i * 0.14;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.30);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(start);
        osc.stop(start + 0.32);
      }
    } catch { /* ignore */ }
  }
}
