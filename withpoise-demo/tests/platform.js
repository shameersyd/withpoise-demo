/**
 * The two runtimes this suite has to work in.
 *
 * It was written for JavaScriptCore's `jsc`, because the machine it was built
 * on has no Node — `print` and `readFile` are jsc shell globals and exist
 * nowhere else. Node is common enough that assuming its absence is its own kind
 * of parochialism, so the suite now runs under either.
 *
 * Only three things differ: how you print, how you read a file, and how you
 * fail. Everything else is plain ES modules and works identically.
 *
 * The Node branch uses a dynamic import inside a runtime check, so jsc never
 * evaluates `import("node:fs")` — a static import would fail there at parse
 * time. Top-level await is supported by both.
 */

/** Which runtime are we in? Pure, so both branches are testable from either. */
export function detectRuntime(env) {
  return typeof env.print === "function" && typeof env.readFile === "function"
    ? "jsc"
    : "node";
}

export const RUNTIME = detectRuntime(globalThis);

let sayImpl, readImpl, failImpl;

if (RUNTIME === "jsc") {
  sayImpl = (line) => print(line);
  readImpl = (path) => readFile(path);
  // jsc's quit() does not set an exit code. An uncaught throw does.
  failImpl = (message) => { throw new Error(message); };
} else {
  const fs = await import("node:fs");
  sayImpl = (line) => console.log(line);
  readImpl = (path) => fs.readFileSync(path, "utf8");
  failImpl = (message) => {
    console.error(message);
    process.exitCode = 1;
  };
}

export const say = (...parts) => sayImpl(parts.join(" "));
export const readTextFile = (path) => readImpl(path);
export const failRun = (message) => failImpl(message);
