import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  addAlgorithmCapabilities,
  advanceAlgorithmRun,
  bootstrapSomaHome,
  buildSomaStartupContext,
  captureCompletedAlgorithmLearnings,
  createAlgorithmRun,
  recordAlgorithmCapabilityInvocation,
  recordAlgorithmChange,
  recordAlgorithmLearning,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  setAlgorithmPlan,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
  writeAlgorithmRun,
} from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-lifecycle-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function completeRun() {
  let run = createAlgorithmRun({
    id: "complete-run",
    timestamp: "2026-05-14T10:00:00.000Z",
    prompt: "Finish lifecycle",
    intent: "Capture learning from completed Algorithm work.",
    currentState: "Lifecycle is missing.",
    goal: "Lifecycle captures completed work.",
    criteria: [{ id: "C1", text: "Completed work writes learning." }],
  });

  run = advanceAlgorithmRun(run, "2026-05-14T10:01:00.000Z");
  run = addAlgorithmCapabilities(run, ["sequential-analysis"], "2026-05-14T10:02:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:03:00.000Z");
  run = setAlgorithmPlan(run, [{ id: "P1", text: "Capture session learning.", criteriaIds: ["C1"], status: "open" }], "2026-05-14T10:04:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:05:00.000Z");
  run = recordAlgorithmChange(run, "Added lifecycle learning capture.", "2026-05-14T10:06:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:07:00.000Z");
  run = updateAlgorithmPlanStep(run, "P1", "done", "Learning capture exists.", "2026-05-14T10:08:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:09:00.000Z");
  run = verifyAlgorithmCriterion(run, "C1", "passed", "Learning file was written.", "2026-05-14T10:10:00.000Z");
  run = advanceAlgorithmRun(run, "2026-05-14T10:11:00.000Z");
  run = recordAlgorithmLearning(run, "Lifecycle should capture completed runs once.", "2026-05-14T10:12:00.000Z");
  run = recordAlgorithmCapabilityInvocation(
    run,
    {
      name: "sequential-analysis",
      substrate: "codex",
      evidence: "Used sequential analysis while deciding what completed learning to capture.",
    },
    "2026-05-14T10:12:30.000Z",
  );
  return advanceAlgorithmRun(run, "2026-05-14T10:13:00.000Z");
}

test("builds startup context from Soma profile and active Algorithm runs", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await writeAlgorithmRun(
      createAlgorithmRun({
        id: "active-run",
        timestamp: "2026-05-14T10:00:00.000Z",
        prompt: "Use lifecycle",
        intent: "Expose active work at session start.",
        currentState: "No startup context.",
        goal: "Startup context lists active runs.",
        criteria: [{ id: "C1", text: "Active run appears." }],
      }),
      { homeDir },
    );

    const startup = await buildSomaStartupContext({
      homeDir,
      substrate: "codex",
      sessionId: "session-1",
      timestamp: "2026-05-14T10:01:00.000Z",
    });

    expect(startup.context).toContain("# Soma Startup Context");
    expect(startup.context).toContain("active-run");
    expect(startup.activeRuns).toHaveLength(1);
  });
});

test("lifecycle algorithm-updated writes a canonical work index", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await writeAlgorithmRun(
      createAlgorithmRun({
        id: "indexed-run",
        prompt: "Index me",
        intent: "Write work index.",
        currentState: "No index.",
        goal: "Index contains run summary.",
        criteria: [{ id: "C1", text: "Run appears in index." }],
      }),
      { homeDir },
    );

    const result = await runSomaLifecycleAlgorithmUpdated({
      homeDir,
      substrate: "pi-dev",
      timestamp: "2026-05-14T10:01:00.000Z",
    });
    const indexPath = join(homeDir, ".soma/memory/STATE/algorithm-work-index.json");
    const activePath = join(homeDir, ".soma/memory/STATE/active-algorithm-run.json");

    expect(result.files).toContain(indexPath);
    expect(result.files).toContain(activePath);
    await expect(readFile(indexPath, "utf8")).resolves.toContain('"id": "indexed-run"');
    await expect(readFile(activePath, "utf8")).resolves.toContain('"id": "indexed-run"');
    await expect(readFile(activePath, "utf8")).resolves.toContain('"phase": "observe"');
  });
});

test("session-end captures completed Algorithm learning once", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await writeAlgorithmRun(completeRun(), { homeDir });

    const first = await captureCompletedAlgorithmLearnings({
      homeDir,
      timestamp: "2026-05-14T10:20:00.000Z",
    });
    const second = await captureCompletedAlgorithmLearnings({
      homeDir,
      timestamp: "2026-05-14T10:21:00.000Z",
    });

    expect(first).toEqual([join(homeDir, ".soma/memory/LEARNING/ALGORITHM/complete-run.md")]);
    expect(second).toEqual([]);
    await expect(readFile(first[0] ?? "", "utf8")).resolves.toContain("Lifecycle should capture completed runs once.");
  });
});

test("lifecycle CLI-facing handlers append events and include context", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const start = await runSomaLifecycleSessionStart({
      homeDir,
      substrate: "codex",
      sessionId: "session-2",
      timestamp: "2026-05-14T10:00:00.000Z",
    });
    const end = await runSomaLifecycleSessionEnd({
      homeDir,
      substrate: "codex",
      sessionId: "session-2",
      timestamp: "2026-05-14T10:30:00.000Z",
    });
    const events = await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8");

    expect(start.context).toContain("Soma Startup Context");
    expect(end.files).toContain(join(homeDir, ".soma/memory/STATE/algorithm-work-index.json"));
    expect(end.files).toContain(join(homeDir, ".soma/memory/STATE/active-algorithm-run.json"));
    expect(events).toContain("lifecycle.session_start");
    expect(events).toContain("lifecycle.session_end");
  });
});
