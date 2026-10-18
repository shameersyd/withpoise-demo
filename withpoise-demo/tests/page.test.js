import { readTextFile } from "./platform.js";
import { suite, test, assert, assertEqual } from "./harness.js";
import * as follow from "../follow.js";
import * as coaching from "../coaching.js";
import * as cues from "../cues.js";

const page = readTextFile("withpoise-demo/index.html");
const module = page.slice(page.indexOf('<script type="module">'), page.lastIndexOf("</script>"));

suite("the page itself");

/**
 * Names the frame loop reads before it declares them.
 *
 * `const` and `let` are hoisted but not initialised, so reading one above its
 * own declaration throws at run time rather than failing to parse. In a
 * function that runs thirty times a second, one of those kills the loop on
 * every frame — and the symptom is whatever the loop had already done before
 * reaching it, which here was setting a plausible-looking status label.
 *
 * That shipped, and survived three rounds of debugging. The unit suite imports
 * the modules and never runs the loop; the smoke test runs the loop with no
 * body in front of it and so never reached the line. It took feeding the app a
 * known body to see the exception.
 */
function useBeforeDeclaration(source) {
  const lines = source.split("\n");
  const declaredAt = new Map();
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (m && !declaredAt.has(m[1])) declaredAt.set(m[1], i);
  });

  const problems = [];
  lines.forEach((line, i) => {
    let code = line.replace(/\/\/.*$/, "").replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""');
    // Property keys are not reads. `{ following: true }` names a field; it does
    // not touch the binding called `following`, and counting it as a read made
    // this fire on correct code. Ternaries are left alone, because `a ? b : c`
    // is a read of b and must still be caught.
    if (!code.includes("?")) code = code.replace(/(^|[{,[(])(\s*)[A-Za-z_$][\w$]*(\s*):/g, "$1$2_key$3:");
    for (const [name, at] of declaredAt) {
      if (i >= at) continue;
      if (!new RegExp(`\\b${name}\\b`).test(code)) continue;
      problems.push(`"${name}" is read on line ${i + 1} and declared on line ${at + 1}`);
    }
  });
  return problems;
}

test("the frame loop never reads a binding before it is declared", () => {
  const start = module.indexOf("function frame(");
  assert(start > 0, "could not find the frame loop in index.html");

  // Walk braces to the end of the function rather than guessing at it.
  let depth = 0, end = -1;
  for (let i = module.indexOf("{", start); i < module.length; i++) {
    if (module[i] === "{") depth++;
    else if (module[i] === "}" && --depth === 0) { end = i; break; }
  }
  assert(end > start, "could not find the end of the frame loop");

  const problems = useBeforeDeclaration(module.slice(start, end));
  assertEqual(problems.length, 0,
    `the loop would throw on every frame:\n      ${problems.join("\n      ")}`);
});

test("a property key is not a read", () => {
  // The false positive that this check produced the first time it was pointed
  // at correct code.
  const fine = [
    "function frame(now) {",
    "  Object.assign(diagnostic, { following: true, state: 'ok' });",
    "  const following = verdict.state !== 'critical';",
    "}",
  ].join("\n");
  assertEqual(useBeforeDeclaration(fine).length, 0,
    `flagged a property key: ${useBeforeDeclaration(fine).join("; ")}`);
});

test("the check itself catches the bug it was written for", () => {
  // The shape of what shipped: a label computed from a verdict that is worked
  // out further down.
  const broken = [
    "function frame(now) {",
    "  const classStarted = hasClassStarted(t);",
    "  label.textContent = !following ? 'Not following' : 'Tracking';",
    "  const following = verdict.state !== 'critical';",
    "}",
  ].join("\n");
  const problems = useBeforeDeclaration(broken);
  assertEqual(problems.length, 1, `found ${problems.length}: ${problems.join("; ")}`);
  assert(problems[0].includes("following"), problems[0]);
});

test("every binding the page imports is one the module exports", () => {
  // The other way the page dies on load: a refactor moves a constant and the
  // import is not updated. A page that fails to evaluate shows a dead start
  // screen with nothing in the console the user will ever look at.
  const imports = [...module.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\/[^"]+)"/gs)];
  assert(imports.length >= 5, `only found ${imports.length} imports to check`);
  for (const [, names, from] of imports) {
    const source = readTextFile(`withpoise-demo/${from.slice(2)}`);
    for (const raw of names.split(",")) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      assert(new RegExp(`export\\s+(?:const|let|function|class)\\s+${name}\\b`).test(source)
        || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(source),
        `index.html imports "${name}" from ${from}, which does not export it`);
    }
  }
});

suite("the module surface");

test("everything the app constructs can actually be constructed", () => {
  // A class whose body references a name it never imported parses, imports and
  // exports perfectly well — and throws the first time anybody builds one.
  // MotionTracker shipped like that: the suite imported the module, no test
  // instantiated it, and the failure waited for the browser.
  const built = [
    ["PostureMonitor", () => new follow.PostureMonitor()],
    ["MirrorLock", () => new follow.MirrorLock()],
    ["MotionTracker", () => new follow.MotionTracker()],
    ["FollowCoach", () => new coaching.FollowCoach()],
    ["CueTrack", () => new cues.CueTrack(null)],
  ];
  for (const [name, make] of built) {
    let instance;
    try { instance = make(); } catch (e) {
      assert(false, `new ${name}() threw: ${e && e.message || e}`);
    }
    assert(instance && typeof instance === "object", `new ${name}() produced nothing`);
  }
});

test("the stateful ones all reset to a usable state", () => {
  // Every one of these is reset when a class ends or restarts, and a reset that
  // leaves an object unusable is a bug that only shows on the second run.
  const monitor = new follow.PostureMonitor();
  monitor.update(0.9, 0); monitor.update(0.9, 5000);
  monitor.reset();
  assertEqual(monitor.update(0, 0).state, "ok");

  const lock = new follow.MirrorLock();
  lock.observe({ direct: 10, mirrored: 90 });
  lock.reset();
  assertEqual(lock.value, null);

  const tracker = new follow.MotionTracker();
  tracker.observe({ torso: { x: 0, y: 1, z: 0 } }, 0);
  tracker.reset();
  assertEqual(tracker.travel(), null);
});
