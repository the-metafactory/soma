/**
 * #125 — progress emitter unit tests.
 *
 * The emitter writes per-skill progress lines to stderr while the
 * migrator orchestrates plan/apply. Test surface:
 *
 *   - quiet=true → emits nothing.
 *   - non-TTY → append-only lines ending in `\n`.
 *   - TTY → `\r`-prefixed updates for fast phases (classification),
 *           `\n`-terminated for slow phases (rewrite, write, smoke).
 *   - stepComplete emits the elapsed-time suffix on the same line
 *     when TTY (CR-overwrite) or as a new line when non-TTY.
 *   - finishTimingSummary returns a multi-line block (NOT written
 *     to stderr — appended to stdout by the caller).
 *
 * The emitter is a pure transducer over a `NodeJS.WritableStream`
 * (the test injects a capturing buffer). No real TTY interaction.
 */
import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { createProgressEmitter } from "../src/claude-skills-progress";

interface CaptureResult {
  bytes: Buffer[];
  text: string;
}

function makeCapturingStream(): { stream: Writable; capture: CaptureResult } {
  const capture: CaptureResult = { bytes: [], text: "" };
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      capture.bytes.push(buf);
      capture.text += buf.toString("utf8");
      cb();
    },
  });
  return { stream, capture };
}

test("quiet emitter writes nothing", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: true, isatty: true });
  emitter.start(3);
  emitter.step(1, "Foo", "reading + classifying", "portable");
  emitter.stepComplete(1, "Foo", "reading + classifying", 12, "portable");
  emitter.step(2, "Bar", "rewriting description via claude", "1318 chars → target 900");
  emitter.stepComplete(2, "Bar", "rewriting description via claude", 1800, "836 chars");
  expect(capture.text).toBe("");
});

test("non-TTY emitter appends \\n-terminated lines for every step + complete", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.start(2);
  emitter.step(1, "Foo", "reading + classifying", "portable");
  emitter.stepComplete(1, "Foo", "reading + classifying", 5, "portable");
  emitter.step(2, "Bar", "writing", "120B");
  emitter.stepComplete(2, "Bar", "writing", 8, "120B");
  // No \r overwrites in non-TTY mode.
  expect(capture.text).not.toContain("\r");
  // Every line ends with \n.
  const lines = capture.text.split("\n").slice(0, -1); // last is empty
  expect(lines.length).toBeGreaterThanOrEqual(4);
  expect(capture.text).toContain("[1/2]");
  expect(capture.text).toContain("Foo");
  expect(capture.text).toContain("reading + classifying");
  expect(capture.text).toContain("[2/2]");
  expect(capture.text).toContain("Bar");
  expect(capture.text).toContain("writing");
});

test("TTY emitter uses \\r-overwrite for steps and emits final \\n on stepComplete", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: true });
  emitter.start(1);
  emitter.step(1, "Foo", "reading + classifying");
  emitter.stepComplete(1, "Foo", "reading + classifying", 7, "portable");
  // TTY uses \r-prefixed updates; stepComplete finishes with \n.
  expect(capture.text).toContain("\r");
  expect(capture.text.endsWith("\n")).toBe(true);
  expect(capture.text).toContain("Foo");
  expect(capture.text).toContain("portable");
});

test("discovery banner emitted on start", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.start(97);
  expect(capture.text).toContain("discovering");
  expect(capture.text).toContain("97");
});

test("rewrite step shows oldLen → target and stepComplete shows newLen", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.start(1);
  emitter.step(1, "Apify", "rewriting description via claude", "1318 chars → target 900");
  emitter.stepComplete(1, "Apify", "rewriting description via claude", 1800, "836 chars");
  expect(capture.text).toContain("Apify");
  expect(capture.text).toContain("rewriting description via claude");
  expect(capture.text).toContain("1318 chars → target 900");
  expect(capture.text).toContain("836 chars");
  // The elapsed time appears formatted as seconds.
  expect(capture.text).toMatch(/1\.8s|1800ms/);
});

test("finishTimingSummary returns multi-line Timing block; nothing on stderr", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  const timings = {
    totalMs: 12_400,
    phases: [
      { name: "read + classify", elapsedMs: 800, count: 97, unit: "skills" },
      { name: "description rewrites", elapsedMs: 47_300, count: 10, unit: "LLM calls via claude" },
      { name: "apply write", elapsedMs: 1_200, count: 78, unit: "files" },
    ],
  };
  const out = emitter.finishTimingSummary(timings);
  expect(out).toContain("Timing:");
  expect(out).toContain("12.4s total");
  expect(out).toContain("read + classify");
  expect(out).toContain("0.8s");
  expect(out).toContain("97 skills");
  expect(out).toContain("description rewrites");
  expect(out).toContain("47.3s");
  expect(out).toContain("apply write");
  expect(out).toContain("78 files");
  // stderr untouched by the timing helper.
  expect(capture.text).toBe("");
});

test("phases with elapsed 0 / no-op rewrites render as (not requested)", () => {
  const { stream } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  const out = emitter.finishTimingSummary({
    totalMs: 1_500,
    phases: [
      { name: "read + classify", elapsedMs: 1_500, count: 3, unit: "skills" },
      { name: "description rewrites", elapsedMs: 0, count: 0, unit: "(not requested)" },
      { name: "smoke verify", elapsedMs: 0, count: 0, unit: "(not requested)" },
    ],
  });
  expect(out).toContain("(not requested)");
});

test("quiet=true still produces a finishTimingSummary string (timing belongs on stdout)", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: true, isatty: true });
  const out = emitter.finishTimingSummary({
    totalMs: 100,
    phases: [{ name: "read + classify", elapsedMs: 100, count: 1, unit: "skills" }],
  });
  expect(out).toContain("Timing:");
  expect(capture.text).toBe("");
});

// ──────────────────────────────────────────────────────────────
// #139 — concurrent-phase rolling display.
//
// Concurrent phases (read+classify/apply write with 4-wide fan-out)
// emit one rolling TTY line and one summary. Non-TTY and verbose
// preserve append-only per-skill rows for logs/debugging.
//
// Sequential phases (rewrite, write, smoke verify) keep the #125
// `\r`-overwrite behavior. `step` / `stepComplete` outside any
// concurrent phase scope behave exactly as before.
// ──────────────────────────────────────────────────────────────

test("#139: beginConcurrentPhase emits one banner line on non-TTY", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.beginConcurrentPhase("read + classify", 97, 4);
  expect(capture.text).toBe("[read + classify: 97 skills, 4-wide concurrent ...]\n");
});

test("#139: beginConcurrentPhase starts a rolling line on TTY", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: true });
  emitter.beginConcurrentPhase("read + classify", 97, 4);
  expect(capture.text).toBe("\r[0/97] processing skills...\x1b[K");
  expect(capture.text).not.toContain("\n");
});

test("#139: non-TTY concurrent phase preserves append-only per-skill rows", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.beginConcurrentPhase("read + classify", 3, 4);
  emitter.step(1, "Foo", "reading + classifying", "read");
  emitter.stepComplete(1, "Foo", "reading + classifying", 12, "read");
  emitter.stepComplete(2, "Bar", "reading + classifying", 8, "read");
  emitter.stepComplete(3, "Baz", "reading + classifying", 15, "read");
  expect(capture.text).not.toContain("\r");
  expect(capture.text).toContain("[read + classify: 3 skills, 4-wide concurrent ...]\n");
  expect(capture.text).toContain("Foo");
  expect(capture.text).toContain("Bar");
  expect(capture.text).toContain("Baz");
  expect(capture.text.split("\n").filter((l) => l.length > 0).length).toBe(5);
});

test("#139: TTY concurrent phase rolls one line instead of appending per-skill rows", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: true });
  emitter.beginConcurrentPhase("read + classify", 3, 4);
  emitter.step(1, "Foo", "reading + classifying", "read");
  emitter.step(2, "Bar", "reading + classifying", "read");
  emitter.stepComplete(1, "Foo", "reading + classifying", 12, "read");
  emitter.stepComplete(2, "Bar", "reading + classifying", 8, "read");
  expect(capture.text).toContain("\r[0/3] processing skills...");
  expect(capture.text).toContain("\r[0/3] processing Foo...");
  expect(capture.text).toContain("\r[0/3] processing Foo + 1 others...");
  expect(capture.text).toContain("\r[1/3] processing Foo + 1 others...");
  expect(capture.text).toContain("\r[2/3] processing Bar...");
  expect(capture.text).not.toContain("\n[");
});

test("#168: TTY concurrent counter counts each skill once across multi-step phases", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: true });
  emitter.beginConcurrentPhase("read + classify", 2, 4);
  emitter.stepComplete(1, "Foo", "reading + classifying", 12, "read");
  emitter.stepComplete(1, "Foo", "classified", 0, "portable");
  emitter.stepComplete(2, "Bar", "reading + classifying", 8, "read");
  emitter.stepComplete(2, "Bar", "classified", 0, "needs-adapt");

  expect(capture.text).toContain("\r[1/2] processing Foo...");
  expect(capture.text).toContain("\r[2/2] processing Bar...");
  expect(capture.text).not.toContain("[3/2]");
  expect(capture.text).not.toContain("[4/2]");
});

test("#168: concurrent summary average samples each skill once across multi-step phases", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.beginConcurrentPhase("read + classify", 2, 4);
  emitter.stepComplete(1, "Foo", "reading + classifying", 10, "read");
  emitter.stepComplete(1, "Foo", "classified", 1000, "portable");
  emitter.stepComplete(2, "Bar", "reading + classifying", 30, "read");
  emitter.stepComplete(2, "Bar", "classified", 1000, "needs-adapt");
  emitter.endConcurrentPhase("read + classify", 100);

  expect(capture.text).toContain("avg 20ms");
  expect(capture.text).toContain("max 30ms");
});

test("#168: TTY rewrites clear residue from longer previous lines", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: true });
  emitter.beginConcurrentPhase("read + classify", 2, 4);
  emitter.step(1, "LongSkillNameWithVerboseSuffix", "reading + classifying", "read");
  emitter.stepComplete(1, "A", "reading + classifying", 3, "read");

  const writes = capture.bytes.map((b) => b.toString("utf8"));
  expect(writes.every((write) => write.startsWith("\r"))).toBe(true);
  expect(writes.every((write) => write.includes("\x1b[K"))).toBe(true);
});

test("#139: endConcurrentPhase emits a summary line with elapsed + avg + max", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.beginConcurrentPhase("read + classify", 3, 4);
  emitter.stepComplete(1, "Foo", "reading + classifying", 10, "read");
  emitter.stepComplete(2, "Bar", "reading + classifying", 20, "read");
  emitter.stepComplete(3, "Baz", "reading + classifying", 30, "read");
  emitter.endConcurrentPhase("read + classify", 900);
  const lines = capture.text.split("\n").filter((l) => l.length > 0);
  expect(lines.length).toBe(5);
  expect(lines[0]).toBe("[read + classify: 3 skills, 4-wide concurrent ...]");
  // Summary: count, elapsed (seconds), avg (ms), max (ms).
  expect(lines[4]).toContain("read + classify");
  expect(lines[4]).toContain("3 skills");
  expect(lines[4]).toContain("0.9s");
  expect(lines[4]).toContain("avg 20ms");
  expect(lines[4]).toContain("max 30ms");
});

test("#139: endConcurrentPhase with zero recorded steps emits avg 0ms max 0ms", () => {
  // Edge case: phase began but no stepComplete fired (empty skill
  // list reaches the phase wrapper). Avg/max default to 0 rather
  // than NaN.
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.beginConcurrentPhase("read + classify", 0, 4);
  emitter.endConcurrentPhase("read + classify", 50);
  expect(capture.text).toContain("avg 0ms");
  expect(capture.text).toContain("max 0ms");
});

test("#139: sequential step + stepComplete behave normally after endConcurrentPhase", () => {
  // After the concurrent phase closes, subsequent step/stepComplete
  // calls must emit per-skill output (this is the sequential-phase
  // contract — rewrite / write / smoke).
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: false, isatty: false });
  emitter.beginConcurrentPhase("read + classify", 1, 4);
  emitter.stepComplete(1, "Foo", "reading + classifying", 12, "read");
  emitter.endConcurrentPhase("read + classify", 100);
  // Now sequential — should emit normally.
  emitter.step(1, "Foo", "writing", "120B");
  emitter.stepComplete(1, "Foo", "writing", 8, "120B");
  expect(capture.text).toContain("[1/0] Foo  [writing");
  expect(capture.text).toContain("(8ms)");
});

test("#139: quiet=true suppresses concurrent banner + summary", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({ stderr: stream, quiet: true, isatty: false });
  emitter.beginConcurrentPhase("read + classify", 97, 4);
  emitter.stepComplete(1, "Foo", "reading + classifying", 12, "read");
  emitter.endConcurrentPhase("read + classify", 900);
  expect(capture.text).toBe("");
});

test("#139: verbose TTY preserves append-only per-skill rows", () => {
  const { stream, capture } = makeCapturingStream();
  const emitter = createProgressEmitter({
    stderr: stream,
    quiet: false,
    isatty: true,
    verbose: true,
  });
  emitter.beginConcurrentPhase("read + classify", 2, 4);
  emitter.step(1, "Foo", "reading + classifying", "read");
  emitter.stepComplete(1, "Foo", "reading + classifying", 10, "read");
  emitter.stepComplete(2, "Bar", "reading + classifying", 12, "read");
  emitter.endConcurrentPhase("read + classify", 80);
  expect(capture.text).not.toContain("\r");
  expect(capture.text).toContain("[read + classify: 2 skills, 4-wide concurrent ...]");
  expect(capture.text).toContain("Foo");
  expect(capture.text).toContain("Bar");
  expect(capture.text).toContain("avg 11ms");
});
