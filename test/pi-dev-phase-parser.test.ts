import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  ALGORITHM_PHASES,
  parseAlgorithmPhaseMarkers,
} from "../src/adapters/pi-dev/extensions/phase-parser";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "algorithm-transcript.md");

describe("parseAlgorithmPhaseMarkers", () => {
  test("returns [] for empty input", () => {
    expect(parseAlgorithmPhaseMarkers("")).toEqual([]);
  });

  test("returns [] when no markers are present", () => {
    expect(parseAlgorithmPhaseMarkers("just some prose with ━━━ but no marker")).toEqual([]);
  });

  test("identifies all eight canonical phase markers from the fixture transcript (AC-3 snapshot)", async () => {
    const text = await readFile(FIXTURE_PATH, "utf8");
    const markers = parseAlgorithmPhaseMarkers(text);

    // AC-3: all seven phases (eight markers — LEARN + SUMMARY both at 7/7)
    // are recognized. Snapshot the phase keys + positions only — line
    // numbers shift if the fixture is reformatted, but the structural
    // assertion is what matters.
    expect(markers.map((m) => ({ phase: m.phase, position: m.position, total: m.total }))).toEqual([
      { phase: "observe", position: 1, total: 7 },
      { phase: "think", position: 2, total: 7 },
      { phase: "plan", position: 3, total: 7 },
      { phase: "build", position: 4, total: 7 },
      { phase: "execute", position: 5, total: 7 },
      { phase: "verify", position: 6, total: 7 },
      { phase: "learn", position: 7, total: 7 },
      { phase: "summary", position: 7, total: 7 },
    ]);
  });

  test("preserves line index for each match", async () => {
    const text = await readFile(FIXTURE_PATH, "utf8");
    const markers = parseAlgorithmPhaseMarkers(text);

    // Strictly monotonic — markers appear in source order.
    for (let i = 1; i < markers.length; i += 1) {
      expect(markers[i].lineIndex).toBeGreaterThan(markers[i - 1].lineIndex);
    }
  });

  test("rawLine is the matched marker line, trimmed of trailing whitespace only", () => {
    const text = "noise\n━━━ 👁️ OBSERVE ━━━ 1/7   \nmore noise\n";
    const [marker] = parseAlgorithmPhaseMarkers(text);

    expect(marker.rawLine).toBe("━━━ 👁️ OBSERVE ━━━ 1/7");
  });

  test("tolerates extra whitespace around the digits", () => {
    const text = "━━━ ⚡ EXECUTE ━━━ 5 / 7";
    const [marker] = parseAlgorithmPhaseMarkers(text);

    expect(marker?.phase).toBe("execute");
    expect(marker?.position).toBe(5);
  });

  test("ignores uppercase tokens that aren't canonical phases", () => {
    const text = "━━━ 🚫 UNKNOWN ━━━ 1/7";
    expect(parseAlgorithmPhaseMarkers(text)).toEqual([]);
  });

  test("ignores prose mentioning phase names without the heavy-line frame", () => {
    const text = "Now entering the OBSERVE phase, position 1 of 7.";
    expect(parseAlgorithmPhaseMarkers(text)).toEqual([]);
  });

  test("ignores a marker-shaped substring embedded in a longer line (anchored regex)", () => {
    // Sage R4 codequality: a model that quotes another transcript may
    // emit a body line containing what looks like a marker. The
    // anchored regex must reject it so we don't false-trigger a phase
    // transition.
    const text = "> quoted: ━━━ 👁️ OBSERVE ━━━ 1/7  (this is a quote, not a real marker)";
    expect(parseAlgorithmPhaseMarkers(text)).toEqual([]);
  });

  test("captures duplicates when a phase header is re-emitted", () => {
    const text = ["━━━ ⚡ EXECUTE ━━━ 5/7", "(tool call interlude)", "━━━ ⚡ EXECUTE ━━━ 5/7"].join("\n");
    const markers = parseAlgorithmPhaseMarkers(text);

    expect(markers).toHaveLength(2);
    expect(markers.every((m) => m.phase === "execute")).toBe(true);
  });

  test("tolerates \\r\\n line endings", () => {
    const text = "━━━ 👁️ OBSERVE ━━━ 1/7\r\n━━━ 🧠 THINK ━━━ 2/7\r\n";
    const markers = parseAlgorithmPhaseMarkers(text);

    expect(markers.map((m) => m.phase)).toEqual(["observe", "think"]);
  });

  test("works on a single line in isolation (supports incremental ingest)", () => {
    // The pi.dev extension drives the parser one complete line at a time
    // (Sage perf finding: don't re-parse the full transcript on every
    // streamed delta). Single-line parsing must still produce a marker.
    const [observe] = parseAlgorithmPhaseMarkers("━━━ 👁️ OBSERVE ━━━ 1/7");
    const [think] = parseAlgorithmPhaseMarkers("━━━ 🧠 THINK ━━━ 2/7");

    expect(observe?.phase).toBe("observe");
    expect(think?.phase).toBe("think");
  });
});

describe("ALGORITHM_PHASES table", () => {
  test("contains eight distinct phase descriptors", () => {
    expect(ALGORITHM_PHASES).toHaveLength(8);
    const keys = ALGORITHM_PHASES.map((d) => d.key);
    expect(new Set(keys).size).toBe(8);
  });

  test("LEARN and SUMMARY share position 7", () => {
    const learn = ALGORITHM_PHASES.find((d) => d.key === "learn");
    const summary = ALGORITHM_PHASES.find((d) => d.key === "summary");

    expect(learn?.position).toBe(7);
    expect(summary?.position).toBe(7);
  });
});
