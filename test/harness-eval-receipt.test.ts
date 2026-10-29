import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgainstBaseline, computeErrataMetrics, computeMetrics, loadEventsWithCoverage, METRICS, ERRATA_METRICS, type HarnessData } from "../scripts/harness-eval";
import { createEvalReceipt, parseEvalBaseline, readEvalTrend, sha256, writeEvalReceipt, type EvalReceipt } from "../scripts/harness-eval-receipt";
import { appendEventBatch } from "../src/events/event-log";

const homes: string[] = [];
const now = new Date("2026-10-29T12:00:00.000Z");
const script = join(import.meta.dir, "../scripts/harness-eval.ts");

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "eval-receipt-"));
  homes.push(home);
  return home;
}

function fixture() {
  const data: HarnessData = { now, windowDays: 60, runs: [], events: [], errata: null };
  const results = computeMetrics(data).map((metric) => ({ ...metric, value: 50, denominator: 100 }));
  const baseline = {
    capturedAt: now.toISOString(), windowDays: 60,
    metrics: Object.fromEntries(results.map((metric) => [metric.id, { value: 50, denominator: 100 }])),
  };
  return {
    now, windowDays: 60, results, specs: METRICS, baseline, errata: computeErrataMetrics(data),
    regressions: [], coverageComplete: true, runsAvailable: true, result: "ok",
    inputs: [{ source: "fixture", sha256: sha256("fixture bytes") }],
  } satisfies Parameters<typeof createEvalReceipt>[0];
}

test("receipt has every documented metric, unchanged baseline/tolerance, and measured verdicts", () => {
  const input = fixture();
  input.results = input.results.map((metric) => metric.id === "hollow_pass_attempt_rate" ? { ...metric, value: 90 } : metric);
  const regressions = checkAgainstBaseline(input.results, input.baseline, { feedbackCandidates: 1 });
  const receipt = createEvalReceipt({ ...input, regressions, result: "regressed" });
  expect(receipt.result).toBe("regressed");
  expect(receipt.metrics.map((metric) => metric.id)).toEqual([...METRICS, ...ERRATA_METRICS].map((metric) => metric.id));
  for (const spec of METRICS) {
    expect(receipt.metrics.find((metric) => metric.id === spec.id)).toMatchObject({
      baseline: 50, tolerance: spec.tolerance, status: spec.id === "hollow_pass_attempt_rate" ? "fail" : "pass",
    });
  }
  expect(receipt.inputs).toEqual(input.inputs);
});

test("missing baseline, missing runs, null value, small sample and incomplete coverage cannot pass", () => {
  const input = fixture();
  for (const options of [{ baseline: null }, { coverageComplete: false }, {
    results: input.results.map((metric) => ({ ...metric, value: null })),
  }, { results: input.results.map((metric) => ({ ...metric, denominator: 0 })) }]) {
    expect(createEvalReceipt({ ...input, ...options }).metrics.every((metric) => metric.status === "unavailable")).toBe(true);
  }
  const missingRuns = createEvalReceipt({ ...input, runsAvailable: false });
  expect(missingRuns.metrics.filter((metric) => metric.id !== "memory_loop_closure").every((metric) => metric.status === "unavailable")).toBe(true);
  expect(createEvalReceipt({ ...input, baseline: { ...input.baseline, windowDays: 30 } }).metrics.every((metric) => metric.status === "unavailable")).toBe(true);
});

test("ungated Errata retains measured values without inventing a baseline or tolerance", () => {
  const receipt = createEvalReceipt({ ...fixture(), errata: {
    rejected_passes: [{ check: "R/C1", count: 2 }], errata_unlinked: 1,
    errata_fix_closure: { value: 50, fixed: 1, proposed: 2, detail: "1/2" },
  } });
  expect(receipt.metrics.slice(-2)).toEqual([
    { id: "rejected_passes", value: { checks: [{ check: "R/C1", count: 2 }], unlinked: 1 }, baseline: null, tolerance: null, status: "unavailable" },
    { id: "errata_fix_closure", value: 50, baseline: null, tolerance: null, status: "unavailable" },
  ]);
});

test("writer replaces the same UTC date, leaves no temp files, and trend reads oldest first", () => {
  const state = temporaryHome();
  const receipt = createEvalReceipt(fixture());
  const path = writeEvalReceipt(state, receipt);
  expect(path).toEndWith("harness-eval/2026-10-29.json");
  writeEvalReceipt(state, { ...receipt, result: "regressed" });
  writeEvalReceipt(state, { ...receipt, evaluatedAt: "2026-10-28T23:59:00.000Z" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...receipt, result: "regressed" });
  writeFileSync(join(state, "harness-eval", "ignored.tmp"), "partial");
  expect(readdirSync(join(state, "harness-eval")).sort()).toEqual(["2026-10-28.json", "2026-10-29.json", "ignored.tmp"]);
  const lines = readEvalTrend(state);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toStartWith("2026-10-28 RESULT ok");
  expect(lines[1]).toStartWith("2026-10-29 RESULT regressed");
  expect(readEvalTrend(join(state, "missing"))).toEqual([]);
  writeFileSync(path, "{}");
  expect(() => readEvalTrend(state)).toThrow();
});

test("readers see complete receipts throughout same-day atomic replacement", async () => {
  const state = temporaryHome();
  const receipt = createEvalReceipt(fixture());
  const destination = writeEvalReceipt(state, receipt);
  const modulePath = join(import.meta.dir, "../scripts/harness-eval-receipt.ts");
  const proc = Bun.spawn(["bun", "--eval", `
    import { writeEvalReceipt } from ${JSON.stringify(modulePath)};
    const receipt = ${JSON.stringify(receipt)};
    for (let i = 0; i < 200; i++) writeEvalReceipt(${JSON.stringify(state)}, { ...receipt, result: i % 2 ? "regressed" : "ok" });
  `], { stdout: "pipe", stderr: "pipe" });
  let reads = 0;
  while (proc.exitCode === null) {
    expect(JSON.parse(readFileSync(destination, "utf8")).metrics).toHaveLength(9);
    reads++;
    await Bun.sleep(1);
  }
  expect(await proc.exited).toBe(0);
  expect(reads).toBeGreaterThan(0);
  expect(readdirSync(join(state, "harness-eval"))).toEqual(["2026-10-29.json"]);
});

test("failed rename removes the temporary file", () => {
  const state = temporaryHome();
  mkdirSync(join(state, "harness-eval", "2026-10-29.json"), { recursive: true });
  expect(() => writeEvalReceipt(state, createEvalReceipt(fixture()))).toThrow();
  expect(readdirSync(join(state, "harness-eval"))).toEqual(["2026-10-29.json"]);
});

test("event digest includes archived and live lines, before window filtering", async () => {
  const home = temporaryHome();
  const path = join(home, "events.jsonl");
  const first = `${JSON.stringify({ timestamp: "2026-07-01T00:00:00.000Z", kind: "memory.recall" })}\n`;
  const second = `${JSON.stringify({ timestamp: "2026-10-28T00:00:00.000Z", kind: "memory.recall" })}\n`;
  await appendEventBatch(path, Buffer.from(first), 80);
  await appendEventBatch(path, Buffer.from(second), 80);
  const loaded = await loadEventsWithCoverage(path, Date.parse("2026-09-01T00:00:00.000Z"));
  expect(loaded.coversWindow).toBe(true);
  expect(loaded.events).toHaveLength(1);
  expect(loaded.sha256).toBe(sha256(first + second));
});

test("baseline parser rejects inputs that cannot support a verdict", () => {
  expect(parseEvalBaseline(JSON.stringify(fixture().baseline))).toEqual(fixture().baseline);
  expect(() => parseEvalBaseline("{}")).toThrow();
  expect(() => parseEvalBaseline("not json")).toThrow();
});

function run(home: string, ...args: string[]) {
  const proc = Bun.spawnSync(["bun", script, ...args], {
    env: { ...process.env, SOMA_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function readToday(home: string): EvalReceipt {
  return JSON.parse(readFileSync(join(home, "memory/STATE/harness-eval", `${new Date().toISOString().slice(0, 10)}.json`), "utf8"));
}

test("CLI writes a receipt on exit 3 with unavailable metrics and hashes consumed inputs", () => {
  const home = temporaryHome();
  const state = join(home, "memory/STATE");
  mkdirSync(state, { recursive: true });
  const events = `${JSON.stringify({ timestamp: new Date().toISOString(), kind: "memory.write.note" })}\n`;
  writeFileSync(join(state, "events.jsonl"), events);
  const checked = run(home, "--check", "--json");
  expect(checked.exitCode).toBe(3);
  expect(JSON.parse(checked.stdout).coverage.complete).toBe(false);
  const receipt = readToday(home);
  expect(receipt.result).toBe("could-not-run");
  expect(checked.stderr).toContain(`RESULT ${receipt.result}`);
  expect(receipt.metrics).toHaveLength(9);
  expect(receipt.metrics.every((metric) => metric.status === "unavailable")).toBe(true);
  expect(receipt.inputs).toContainEqual({ source: "events:ordered-logical-lines", sha256: sha256(events) });
  expect(receipt.inputs).toContainEqual({ source: join(home, "memory/STATE/errata/ledger.jsonl"), sha256: null });
  expect(run(home, "--trend").stdout).toContain(`RESULT ${receipt.result}`);
});

test("CLI normal and regressed verdicts agree with daily receipts; trend needs no live inputs", () => {
  const home = temporaryHome();
  const state = join(home, "memory/STATE");
  const runs = join(home, "memory/WORK/algorithm-runs");
  mkdirSync(state, { recursive: true });
  mkdirSync(runs, { recursive: true });
  const old = new Date(Date.now() - 61 * 86400000).toISOString();
  const recent = new Date(Date.now() - 86400000).toISOString();
  writeFileSync(join(state, "events.jsonl"), `${JSON.stringify({ timestamp: old, kind: "memory.recall" })}\n`);
  const checked = run(home, "--check");
  expect(checked.exitCode).toBe(0);
  const receipt = readToday(home);
  expect(receipt.result).toBe("ok");
  expect(checked.stdout).toContain(`RESULT ${receipt.result}`);
  const runText = JSON.stringify({ createdAt: recent, vsa: { criteria: [{ status: "open" }] } });
  writeFileSync(join(runs, "run.json"), runText);
  writeFileSync(join(state, "events.jsonl"), [
    { timestamp: old, kind: "memory.recall" },
    { timestamp: recent, kind: "lifecycle.session_start" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const failed = run(home, "--check");
  expect(failed.exitCode).toBe(1);
  const replaced = readToday(home);
  expect(failed.stdout).toContain(`RESULT ${replaced.result}`);
  expect(replaced.result).toBe("regressed");
  expect(replaced.regressions.some((regression) => regression.id === "feedback_candidate_volume")).toBe(true);
  expect(replaced.inputs).toContainEqual({ source: join(runs, "run.json"), sha256: sha256(runText) });
  expect(replaced.inputs.find((input) => input.source.endsWith("harness-eval-baseline.json"))?.sha256).toBe(sha256(readFileSync(join(import.meta.dir, "../scripts/harness-eval-baseline.json"), "utf8")));
  rmSync(join(state, "events.jsonl"));
  rmSync(runs, { recursive: true });
  const trend = run(home, "--trend");
  expect(trend.exitCode).toBe(0);
  expect(trend.stdout.trim().split("\n")).toHaveLength(1);
  expect(trend.stdout).toContain("RESULT regressed");
});
