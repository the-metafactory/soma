import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  bootstrapSomaHome,
  buildSomaStartupContext,
  createAlgorithmRun,
  listAlgorithmRunSummaries,
  writeAlgorithmRun,
  writeAlgorithmWorkIndex,
} from "../src/index";
import { listStartupAlgorithmRunSummaries } from "../src/algorithm-store";

test("session startup reconciles a long Algorithm history from the work index", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-startup-history-"));
  try {
    await bootstrapSomaHome({ homeDir });
    const somaHome = join(homeDir, ".soma");
    const runsDir = join(somaHome, "memory/WORK/algorithm-runs");
    await mkdir(runsDir, { recursive: true });
    const payload = "x".repeat(64 * 1024);
    const base = createAlgorithmRun({
      id: "history",
      prompt: payload,
      intent: "History fixture",
      currentState: "Old work",
      goal: "Fixture goal",
      criteria: [{ id: "C1", text: "Fixture criterion" }],
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await Promise.all(Array.from({ length: 1024 }, async (_, number) => {
      const id = `history-${String(number).padStart(4, "0")}`;
      const run = { ...base, id, vsa: { ...base.vsa, frontmatter: { ...base.vsa.frontmatter, phase: "complete" as const } } };
      await writeFile(join(runsDir, `${id}.json`), JSON.stringify(run), "utf8");
    }));

    for (let number = 0; number < 9; number += 1) {
      await writeAlgorithmRun({
        ...base,
        id: `active-${number}`,
        prompt: "Active",
        updatedAt: `2026-09-${String(number + 1).padStart(2, "0")}T00:00:00.000Z`,
      }, { somaHome });
    }
    await writeAlgorithmWorkIndex({ somaHome });

    const indexed = await buildSomaStartupContext({ somaHome });
    expect(indexed.activeRuns.map((run) => run.id)).toEqual(
      Array.from({ length: 8 }, (_, number) => `active-${8 - number}`),
    );
    expect(indexed.activeRuns[0]?.path).toBe(join(runsDir, "active-8.json"));

    // An in-place run change does not update the directory mtime. Startup must
    // notice it, including a completed run becoming active after index creation.
    const promotedPath = join(runsDir, "history-0000.json");
    const promoted = JSON.parse(await readFile(promotedPath, "utf8"));
    promoted.vsa.frontmatter.phase = "observe";
    promoted.updatedAt = "2026-10-01T00:00:00.000Z";
    promoted.vsa.sections[0].content = "Promoted goal";
    await writeFile(promotedPath, JSON.stringify(promoted), "utf8");
    const indexInfo = await stat(join(somaHome, "memory/STATE/algorithm-work-index.json"));
    const later = new Date(indexInfo.mtimeMs + 1000);
    await utimes(promotedPath, later, later);
    await rm(join(runsDir, "active-8.json"));
    await writeAlgorithmRun({ ...base, id: "new-active", prompt: "New", updatedAt: "2026-10-02T00:00:00.000Z" }, { somaHome });

    const reconciled = await buildSomaStartupContext({ somaHome });
    const authoritative = (await listAlgorithmRunSummaries({ somaHome }))
      .filter((run) => run.phase !== "complete").slice(0, 8);
    expect(reconciled.activeRuns).toEqual(authoritative);
    expect(reconciled.activeRuns.slice(0, 2).map((run) => run.id)).toEqual(["new-active", "history-0000"]);
    expect(reconciled.activeRuns.map((run) => run.id)).not.toContain("active-8");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("session startup sees a run changed during work-index construction", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-startup-index-race-"));
  try {
    await bootstrapSomaHome({ homeDir });
    const somaHome = join(homeDir, ".soma");
    const run = createAlgorithmRun({
      id: "racing-run",
      prompt: "Race fixture",
      intent: "Show a concurrent update",
      currentState: "Complete",
      goal: "Visible if reactivated",
      criteria: [{ id: "C1", text: "Startup includes the run" }],
    });
    const complete = { ...run, vsa: { ...run.vsa, frontmatter: { ...run.vsa.frontmatter, phase: "complete" as const } } };
    const runPath = (await writeAlgorithmRun(complete, { somaHome })).path;
    const { path: indexPath } = await writeAlgorithmWorkIndex({ somaHome });
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.scanStartedAt = new Date(Date.now() - 10_000).toISOString();

    const active = { ...complete, updatedAt: "2026-10-03T00:00:00.000Z", vsa: { ...complete.vsa, frontmatter: { ...complete.vsa.frontmatter, phase: "observe" as const } } };
    await writeAlgorithmRun(active, { somaHome });
    await writeFile(indexPath, JSON.stringify(index), "utf8");
    const later = new Date(Date.now() + 10_000);
    await utimes(indexPath, later, later);

    const startup = await buildSomaStartupContext({ somaHome });
    expect(startup.activeRuns.map((summary) => summary.id)).toContain("racing-run");
    expect(startup.activeRuns[0]?.path).toBe(runPath);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("session startup reports a run-directory read failure", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-startup-directory-error-"));
  try {
    await bootstrapSomaHome({ homeDir });
    const somaHome = join(homeDir, ".soma");
    const runsDir = join(somaHome, "memory/WORK/algorithm-runs");
    await writeAlgorithmRun(createAlgorithmRun({
      id: "active-run",
      prompt: "Directory error fixture",
      intent: "Keep failures visible",
      currentState: "Active",
      goal: "Report read failure",
      criteria: [{ id: "C1", text: "Read errors propagate" }],
    }), { somaHome });
    await writeAlgorithmWorkIndex({ somaHome });
    await rm(runsDir, { recursive: true });
    await writeFile(runsDir, "not a directory", "utf8");

    await expect(listStartupAlgorithmRunSummaries({ somaHome })).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(listAlgorithmRunSummaries({ somaHome })).rejects.toMatchObject({ code: "ENOTDIR" });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
