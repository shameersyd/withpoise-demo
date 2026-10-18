/**
 * The exercises in the class, one at a time.
 *
 * The whole class is twenty-one minutes of counted cardio, and trying to coach
 * all of it at once meant tuning everything against an average of movements
 * that have nothing in common — a jumping jack and a scissor kick want
 * different tolerances, different weights, and arguably different instruments.
 * So the app does one form at a time, properly, and the next is added by
 * writing another entry here.
 *
 * Times are video seconds, read off the recording rather than guessed:
 *
 *   announceAt   where the demo starts playing. A few seconds of lead-in so
 *                the student hears the instructor name the exercise and set it
 *                up, rather than being dropped into the middle of a set.
 *   from         where the movement itself begins, and where posture tracking
 *                starts. Nothing is judged before this.
 *   to           where the exercise ends and the demo ends with it.
 *   movement     "reps" for a repeated movement, judged per repetition with
 *                cues in rhythm and the class never paused for form; "hold"
 *                (the default) for a pose, compared frame by frame.
 */
export const EXERCISES = [
  {
    id: "jumping-jacks",
    name: "Jumping Jacks",
    // 75s: "Starting with Jumping Jacks." — the instructor's own words, found
    // in the transcript and confirmed against the frame.
    announceAt: 74,
    // 78s: both of them are moving. 80s carries the on-screen "Jumping Jacks"
    // caption; 104s carries "Next Exercise", which is where this one ends.
    from: 78,
    to: 103,
    // A repeated movement, judged one repetition at a time against the
    // instructor's own reps — see reps.js. Never paused for form: stopping a
    // cardio set to fix one frame of it is the one thing that cannot help.
    movement: "reps",
  },
];

/** The exercise being demonstrated. One, for now. */
export const CURRENT = EXERCISES[0];

/** Is video time `t` inside the part of the exercise that gets judged? */
export function withinExercise(t, exercise = CURRENT) {
  return Number.isFinite(t) && t >= exercise.from && t <= exercise.to;
}

/** Has the exercise finished by video time `t`? */
export function exerciseOver(t, exercise = CURRENT) {
  return Number.isFinite(t) && t > exercise.to;
}

/** Is this exercise a repeated movement rather than a held pose? */
export function isRepeated(exercise = CURRENT) {
  return exercise.movement === "reps";
}
