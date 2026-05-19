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
