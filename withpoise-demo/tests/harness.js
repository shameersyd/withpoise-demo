/**
 * A small test harness, because vitest and node:test were not options on the
 * machine this was built on — it has no Node at all. Runs under either Node or
 * JavaScriptCore's `jsc`; see platform.js for the three things that differ.
 */
import { say, failRun } from "./platform.js";


const tests = [];
let currentFile = "";

export function suite(name) { currentFile = name; }
export function test(name, fn) { tests.push({ name, file: currentFile, fn }); }

/**
 * A test for behaviour that is known to be missing.
 *
 * It runs, and failing is the expected outcome — the suite stays green and the
 * gap stays visible in the output. Passing is reported as a failure, because a
 * gap that has closed needs its test promoted to a real one rather than left
 * quietly asserting nothing.
 */
export function expectedFail(name, fn) {
  tests.push({ name, file: currentFile, fn, expectFail: true });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "expected a truthy value");
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

export function assertClose(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg || "not close"}\n      expected: ${expected} ±${tol}\n      actual:   ${actual}`);
  }
}

export function assertDeepEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg || "not deep-equal"}\n      expected: ${b}\n      actual:   ${a}`);
  }
}

/** Set membership, order-independent, with a readable diff. */
export function assertSameSet(actual, expected, msg) {
  const a = [...actual].sort(), b = [...expected].sort();
  assertDeepEqual(a, b, msg);
}

export function run() {
  let passed = 0;
  const failures = [];
  let lastFile = null;

  let known = 0;
  for (const t of tests) {
    if (t.file !== lastFile) { say(`\n  ${t.file}`); lastFile = t.file; }
    let error = null;
    try { t.fn(); } catch (err) { error = err; }

    if (t.expectFail) {
      if (error) {
        known++;
        say(`    ◌ ${t.name}`);
        say(`      not yet: ${error.message.split("\n")[0]}`);
      } else {
        failures.push({ ...t, err: new Error(
          "expected this to fail and it passed — promote it to test()") });
        say(`    ✗ ${t.name}`);
        say("      this now passes; promote it from expectedFail() to test()");
      }
    } else if (error) {
      failures.push({ ...t, err: error });
      say(`    ✗ ${t.name}`);
      say(`      ${error.message}`);
    } else {
      passed++;
      say(`    ✓ ${t.name}`);
    }
  }

  say("");
  const gaps = known ? `, ${known} known gap${known === 1 ? "" : "s"}` : "";
  say(`  ${passed} passed, ${failures.length} failed${gaps}, ${tests.length} total`);
  say("");
  if (failures.length) failRun(`${failures.length} test(s) failed`);
}
