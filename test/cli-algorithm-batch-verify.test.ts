import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runSomaCli } from "../src/cli";
import { parseAlgorithmArgs } from "../src/cli/algorithm";
import { VerificationGateError } from "../src/algorithm";
import { getCriteria, readAlgorithmRunById } from "../src/index";

const runId = "batch-verify";
const evidence = "probe.ts on 4222: anonymous connect refused: exit 0";

async function withRun(fn: (homeDir: string, runPath: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-batch-verify-"));
  try {
    await runSomaCli([
      "algorithm", "new", "--home-dir", homeDir, "--id", runId,
      "--prompt", "Verify batch evidence", "--intent", "Persist real verification evidence.",
      "--current-state", "Batch parsing drops evidence kinds.", "--goal", "Batch passes carry probe kinds.",
      "--criterion", "C1:Anonymous connections are refused.",
    ]);
    await fn(homeDir, join(homeDir, ".soma/memory/WORK/algorithm-runs", `${runId}.json`));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

for (const kind of ["probed", "tested"] as const) {
  test(`CLI batch persists ${kind} passes and colon-bearing evidence with other operations`, async () => {
    await withRun(async (homeDir) => {
      await runSomaCli([
        "algorithm", "batch", "--home-dir", homeDir, "--id", runId,
        "--op", "change:Added the connection probe.",
        "--op", `verify:C1:passed+${kind}:${evidence}`,
        "--op", "decision:Keep explicit probe kinds.",
        "--op", "learn:The connection probe checks refusal before authentication.",
      ]);
      const { run } = await readAlgorithmRunById(runId, { homeDir });
      expect(getCriteria(run.vsa)[0]).toMatchObject({ status: "passed", evidenceKind: kind, verification: evidence });
      expect(run.changelog.some((entry) => entry.text === "Added the connection probe.")).toBe(true);
      expect(run.decisions.some((entry) => entry.text === "Keep explicit probe kinds.")).toBe(true);
      expect(run.learning).toHaveLength(1);
    });
  });
}

for (const status of ["failed", "dropped", "deferred-probe"] as const) {
  test(`legacy CLI batch ${status} syntax remains valid`, async () => {
    await withRun(async (homeDir) => {
      await runSomaCli([
        "algorithm", "batch", "--home-dir", homeDir, "--id", runId,
        "--op", `verify:C1:${status}:${evidence}`,
      ]);
      const { run } = await readAlgorithmRunById(runId, { homeDir });
      expect(getCriteria(run.vsa)[0]).toMatchObject({ status, verification: evidence });
    });
  });
}

for (const op of [
  `verify:C1:passed:${evidence}`,
  `verify:C1:passed+specified:${evidence}`,
  "verify:C1:passed+probed:done",
]) {
  test(`refused batch preserves saved run and gate telemetry: ${op}`, async () => {
    await withRun(async (homeDir, runPath) => {
      const before = await readFile(runPath, "utf8");
      const result = runSomaCli([
        "algorithm", "batch", "--home-dir", homeDir, "--id", runId,
        "--op", "change:Must not persist.", "--op", "decision:Must not persist.",
        "--op", "learn:Must not persist this learning.", "--op", op,
      ]);
      await expect(result).rejects.toBeInstanceOf(VerificationGateError);
      await expect(result).rejects.toThrow(/batch refused.*no ops recorded.*VerificationGate/i);
      expect(await readFile(runPath, "utf8")).toBe(before);
      const events = await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8");
      expect(events).toContain('"kind":"verification.gate_violation"');
    });
  });
}

for (const status of ["passed+", "passed+invented", "passed+probed+tested", "unknown+probed"]) {
  test(`invalid batch status or evidence kind is refused before persistence: ${status}`, async () => {
    await withRun(async (homeDir, runPath) => {
      const before = await readFile(runPath, "utf8");
      await expect(runSomaCli([
        "algorithm", "batch", "--home-dir", homeDir, "--id", runId,
        "--op", "change:Must not persist.", "--op", `verify:C1:${status}:${evidence}`,
      ])).rejects.toThrow(/batch refused.*no ops recorded/i);
      expect(await readFile(runPath, "utf8")).toBe(before);
    });
  });
}

test("JSON batch parse failures report that no operations were recorded", () => {
  expect(() => parseAlgorithmArgs([
    "algorithm", "batch", "--id", runId, "--op", "change:Must not persist.", "--ops-json", "[",
  ])).toThrow(/batch refused.*no ops recorded/i);
});

test("non-verification batch rejection also leaves earlier operations unrecorded", async () => {
  await withRun(async (homeDir, runPath) => {
    const before = await readFile(runPath, "utf8");
    await expect(runSomaCli([
      "algorithm", "batch", "--home-dir", homeDir, "--id", runId,
      "--op", "change:Must not persist.", "--op", "step:P404:done:No such step.",
    ])).rejects.toThrow(/batch refused.*no ops recorded/i);
    expect(await readFile(runPath, "utf8")).toBe(before);
  });
});
