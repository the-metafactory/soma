import { expect, test } from "bun:test";
import { boundedJsonlSummaries, collectProbeOutput, outputFromText, type CommandOutput } from "../src/execution/command-output";

function output(...chunks: string[]): CommandOutput {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

const options = {
  maxRecords: 2,
  maxRecordLength: 32,
  eventPrefix: "Event",
  oversizedSummary: "oversized",
  malformedSummary: "malformed",
  truncatedSummary: "truncated",
};

test("reduces chunked JSONL without retaining a full transcript", async () => {
  const summaries: string[] = [];
  for await (const summary of boundedJsonlSummaries(output('{"type":"one"', '}\n{"type":"two"}\n'), options)) summaries.push(summary);
  expect(summaries).toEqual(["Event: one", "Event: two"]);
});

test("bounds oversized records and records beyond the configured limit", async () => {
  const summaries: string[] = [];
  for await (const summary of boundedJsonlSummaries(output("x".repeat(128), "\n{\"type\":\"one\"}\n{\"type\":\"two\"}\n"), options)) summaries.push(summary);
  expect(summaries).toEqual(["oversized", "Event: one", "truncated"]);
});

test("caps probe collection and supports deterministic in-memory streams", async () => {
  expect(await collectProbeOutput(outputFromText("version"))).toBe("version");
  expect((await collectProbeOutput(output("x".repeat(70_000)))).length).toBe(64 * 1024);
});
