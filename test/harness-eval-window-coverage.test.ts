import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { loadEventsWithCoverage } from "../scripts/harness-eval";

const homes: string[] = [];
const script = join(import.meta.dir, "../scripts/harness-eval.ts");
const dayMs = 24 * 60 * 60 * 1000;

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function runEval(eventTimes: string[], args: string[] = []): Promise<{ exitCode: number; output: string }> {
  const home = await mkdtemp(join(tmpdir(), "harness-eval-coverage-"));
  homes.push(home);
  const state = join(home, "memory", "STATE");
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, "events.jsonl"),
    eventTimes.map((timestamp) => JSON.stringify({ timestamp, kind: "memory.recall" })).join("\n") + "\n",
  );
  const proc = Bun.spawnSync(["bun", script, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, SOMA_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    output: new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr),
  };
}

test("reports a gap and --check distinguishes incomplete coverage from regression", async () => {
  const first = new Date(Date.now() - 2 * dayMs).toISOString();
  const result = await runEval([first], ["--check"]);
  expect(result.exitCode).toBe(3);
  expect(result.output).toContain("Window start:");
  expect(result.output).toContain(`First event: ${first}`);
  expect(result.output).toMatch(/gap 5[78](?:\.\d)? days/i);
  expect(result.output).toContain("INCOMPLETE COVERAGE:");
  expect(result.output).toContain("events-snapshots");
  expect(result.output).not.toContain("REGRESSION:");
  expect(result.output).not.toContain("OK:");
});

test("an event before the window establishes coverage while metrics retain only in-window events", async () => {
  const first = new Date(Date.now() - 61 * dayMs).toISOString();
  const current = new Date(Date.now() - dayMs).toISOString();
  const result = await runEval([first, current]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(`First event: ${first}`);
  expect(result.output).toContain("Gap: none");
  expect(result.output).toContain("1 events in window");
});

test("--check can reach its normal verdict with a full window", async () => {
  const first = new Date(Date.now() - 61 * dayMs).toISOString();
  const result = await runEval([first], ["--check"]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Gap: none");
  expect(result.output).toContain("OK: no regressions");
});

test("an empty event log reports unknown coverage and fails --check", async () => {
  const result = await runEval([], ["--check"]);
  expect(result.exitCode).toBe(3);
  expect(result.output).toContain("First event: none");
  expect(result.output).toContain("INCOMPLETE COVERAGE:");
});

test("a read error after an old event cannot establish coverage", async () => {
  const first = new Date(Date.now() - 61 * dayMs).toISOString();
  const input = Readable.from((async function* () {
    yield `${JSON.stringify({ timestamp: first, kind: "memory.recall" })}\n`;
    throw new Error("read interrupted");
  })());
  const loaded = await loadEventsWithCoverage("unused", Date.now() - 60 * dayMs, input);
  expect(loaded.firstEventAt).toBe(first);
  expect(loaded.readError).toBe(true);
  expect(loaded.coversWindow).toBe(false);
});
