import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";
import { buildSessionEndRegistryArtifacts } from "../src/lifecycle";
import {
  addAlgorithmCapabilities,
  advanceAlgorithmRun,
  bootstrapSomaHome,
  buildSomaStartupContext,
  captureCompletedAlgorithmLearnings,
  createAlgorithmRun,
  readAlgorithmRunById,
  recordAlgorithmCapabilityInvocation,
  recordAlgorithmChange,
  recordAlgorithmLearning,
  runSomaLifecycleAlgorithmObserved,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  setAlgorithmPlan,
  somaWorkRegistryPaths,
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

test("lifecycle algorithm-observed records explicit substrate observation on the active run", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await writeAlgorithmRun(
      createAlgorithmRun({
        id: "pi-observed-run",
        substrate: "claude-code",
        prompt: "Observe pi.dev",
        intent: "Let pi.dev leave durable provenance.",
        currentState: "Pi.dev reads work but does not touch the run.",
        goal: "Pi.dev observation is visible in shared run provenance.",
        criteria: [{ id: "C1", text: "Run provenance includes pi.dev." }],
        timestamp: "2026-06-02T08:00:00.000Z",
      }),
      { homeDir },
    );

    const result = await runSomaLifecycleAlgorithmObserved({
      homeDir,
      substrate: "pi-dev",
      timestamp: "2026-06-02T08:30:00.000Z",
    });
    const runPath = join(homeDir, ".soma/memory/WORK/algorithm-runs/pi-observed-run.json");
    const { run } = await readAlgorithmRunById("pi-observed-run", { homeDir });
    const events = await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8");

    expect(result.files).toContain(runPath);
    expect(run.updatedAt).toBe("2026-06-02T08:30:00.000Z");
    expect(run.provenance.at(-1)).toMatchObject({
      operation: "run.observed",
      substrate: "pi-dev",
      phase: "observe",
      detail: "Lifecycle algorithm-observed observed the active shared run.",
    });
    expect(events).toContain("lifecycle.algorithm_observed");
    expect(events).toContain("pi-dev");
    expect(events).toContain("pi-observed-run.json");
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

test("session-end writes shared work registry state and metadata-only event", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });

    const end = await runSomaLifecycleSessionEnd({
      homeDir,
      substrate: "codex",
      sessionId: "session-3",
      timestamp: "2026-05-26T10:30:00.000Z",
    });

    const workPath = join(homeDir, ".soma/memory/STATE/work.json");
    const namesPath = join(homeDir, ".soma/memory/STATE/session-names.json");
    const currentPath = somaWorkRegistryPaths({ homeDir }, "session-3").currentWork!;
    const currentArtifactPath = relative(join(homeDir, ".soma"), currentPath);
    const events = (await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const sessionEnd = events.find((event) => event.kind === "lifecycle.session_end");
    const work = JSON.parse(await readFile(workPath, "utf8"));
    const names = JSON.parse(await readFile(namesPath, "utf8"));

    expect(end.files).toContain(workPath);
    expect(end.files).toContain(namesPath);
    expect(end.files).toContain(currentPath);
    expect(names).toEqual({ "session-3": "session session-3" });
    expect(work.sessions["session-session-3"]).toMatchObject({
      sessionUUID: "session-3",
      sessionName: "session session-3",
      substrate: "codex",
      phase: "complete",
    });
    expect(sessionEnd.artifactPaths).toEqual(
      expect.arrayContaining([
        "memory/STATE/work.json",
        "memory/STATE/session-names.json",
        currentArtifactPath,
      ]),
    );
    expect(JSON.stringify(sessionEnd.artifactPaths)).not.toContain(homeDir);
    expect(sessionEnd.metadata).toMatchObject({ sessionId: "session-3", substrate: "codex" });
    expect(JSON.stringify(sessionEnd)).not.toContain("prompt");
    expect(JSON.stringify(sessionEnd)).not.toContain("result");
  });
});

test("session-end continues when work registry writeback fails", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const workPath = join(homeDir, ".soma/memory/STATE/work.json");
    await writeFile(workPath, "{\"sessions\":null}\n", "utf8");

    const end = await runSomaLifecycleSessionEnd({
      homeDir,
      substrate: "codex",
      sessionId: "session-bad-registry",
      timestamp: "2026-05-26T10:31:00.000Z",
    });

    const events = (await readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(end.files).not.toContain(workPath);
    const failed = events.find((event) => event.kind === "lifecycle.session_end.registry-write-failed");
    expect(failed?.metadata.error).toContain("sessions must be an object");
    expect(failed?.metadata.error).not.toContain(homeDir);
    expect(events.some((event) => event.kind === "lifecycle.session_end")).toBe(true);
  });
});

test("session-end registry artifact pointers stay relative to Soma home", () => {
  const somaHome = join(tmpdir(), "soma-artifact-home", ".soma");
  const artifacts = buildSessionEndRegistryArtifacts({
    somaHome,
    algorithmWorkIndexPath: join(somaHome, "memory/STATE/algorithm-work-index.json"),
    activeAlgorithmRunPath: join(somaHome, "memory/STATE/active-algorithm-run.json"),
    learningFiles: [join(somaHome, "memory/LEARNING/ALGORITHM/complete-run.md"), "memory/LEARNING/ALGORITHM/relative-run.md"],
  });

  expect(artifacts).toEqual({
    activeAlgorithmRun: "memory/STATE/active-algorithm-run.json",
    algorithmWorkIndex: "memory/STATE/algorithm-work-index.json",
    learning1: "memory/LEARNING/ALGORITHM/complete-run.md",
    learning2: "memory/LEARNING/ALGORITHM/relative-run.md",
  });
  expect(JSON.stringify(artifacts)).not.toContain(somaHome);
});

test("session-end registry artifact pointers reject escaped paths", () => {
  const somaHome = join(tmpdir(), "soma-artifact-home", ".soma");

  expect(() =>
    buildSessionEndRegistryArtifacts({
      somaHome,
      algorithmWorkIndexPath: join(somaHome, "memory/STATE/algorithm-work-index.json"),
      activeAlgorithmRunPath: join(somaHome, "memory/STATE/active-algorithm-run.json"),
      learningFiles: [join(somaHome, "../outside.md")],
    }),
  ).toThrow("escapes Soma home");
});
