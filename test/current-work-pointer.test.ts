import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { portableProjectionInput } from "./fixtures";
import {
  bootstrapSomaHome,
  projectPiDevHome,
  readSomaWorkRegistry,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  somaWorkRegistryPaths,
  upsertSomaCurrentWorkPointer,
} from "../src/index";

async function withTempSomaHome<T>(fn: (homeDir: string, somaHome: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-current-work-"));

  try {
    const somaHome = join(homeDir, ".soma");
    await bootstrapSomaHome({ homeDir, somaHome });
    return await fn(homeDir, somaHome);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("codex session-start writes an active current-work pointer before session end", async () => {
  await withTempSomaHome(async (_homeDir, somaHome) => {
    const sessionId = "codex/session 238";

    const result = await runSomaLifecycleSessionStart({
      somaHome,
      substrate: "codex",
      sessionId,
      timestamp: "2026-05-28T08:00:00.000Z",
    });

    const pointerPath = somaWorkRegistryPaths({ somaHome }, sessionId).currentWork;
    if (pointerPath === undefined) throw new Error("expected a current-work pointer path");
    expect(result.files).toContain(pointerPath);

    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
    expect(pointer.schema).toBe("soma-current-work-v1");
    expect(pointer.status).toBe("active");
    expect(pointer.sessionUUID).toBe(sessionId);
    expect(pointer.substrate).toBe("codex");
    expect(pointer.updatedAt).toBe("2026-05-28T08:00:00.000Z");
  });
});

test("current-work pointer stores bounded single-line task metadata instead of raw prompt text", async () => {
  await withTempSomaHome(async (_homeDir, somaHome) => {
    const sessionId = "privacy-session";
    const rawPrompt = [
      "Implement issue 238",
      "RAW SECRET PROMPT BODY SHOULD NOT BE STORED",
      "Full assistant output should not be mirrored either.",
    ].join("\n");

    await upsertSomaCurrentWorkPointer({
      somaHome,
      sessionId,
      slug: rawPrompt,
      substrate: "codex",
      task: rawPrompt,
      timestamp: "2026-05-28T08:05:00.000Z",
    });

    const pointerPath = somaWorkRegistryPaths({ somaHome }, sessionId).currentWork!;
    const pointerText = await readFile(pointerPath, "utf8");
    const pointer = JSON.parse(pointerText) as Record<string, unknown>;

    expect(pointer.task).toBe("Implement issue 238");
    expect(pointer.slug).toBe("Implement-issue-238");
    expect(pointerText).not.toContain("RAW SECRET PROMPT BODY SHOULD NOT BE STORED");
    expect(pointerText).not.toContain("Full assistant output should not be mirrored either.");
  });
});

test("session-end marks the current-work pointer complete and retains coherent registry state", async () => {
  await withTempSomaHome(async (_homeDir, somaHome) => {
    const sessionId = "completion-session";
    await runSomaLifecycleSessionStart({
      somaHome,
      substrate: "codex",
      sessionId,
      timestamp: "2026-05-28T08:10:00.000Z",
    });

    const end = await runSomaLifecycleSessionEnd({
      somaHome,
      substrate: "codex",
      sessionId,
      timestamp: "2026-05-28T08:30:00.000Z",
    });

    const pointerPath = somaWorkRegistryPaths({ somaHome }, sessionId).currentWork!;
    expect(end.files).toContain(pointerPath);

    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
    expect(pointer.status).toBe("complete");
    expect(pointer.completedAt).toBe("2026-05-28T08:30:00.000Z");
    expect(pointer.sessionUUID).toBe(sessionId);
    expect(pointer.learningSources).toMatchObject({
      events: "memory/STATE/events.jsonl",
    });

    const registry = await readSomaWorkRegistry({ somaHome });
    expect(Object.values(registry.sessions)).toHaveLength(1);
    expect(Object.values(registry.sessions)[0]).toMatchObject({
      sessionUUID: sessionId,
      phase: "complete",
      progress: "1/1",
    });
  });
});

test("current-work pointer rejects artifact and learning-source paths that escape Soma home", async () => {
  await withTempSomaHome(async (_homeDir, somaHome) => {
    await expect(
      upsertSomaCurrentWorkPointer({
        somaHome,
        sessionId: "escape-artifact",
        substrate: "codex",
        artifacts: {
          transcript: "../outside.jsonl",
        },
      }),
    ).rejects.toThrow("escapes Soma home");

    await expect(
      upsertSomaCurrentWorkPointer({
        somaHome,
        sessionId: "escape-learning",
        substrate: "codex",
        learningSources: {
          events: "/tmp/outside/events.jsonl",
        },
      }),
    ).rejects.toThrow("escapes Soma home");
  });
});

test("session-start records the lifecycle event even when current-work pointer write fails", async () => {
  await withTempSomaHome(async (_homeDir, somaHome) => {
    await writeFile(join(somaHome, "memory/STATE/work.json"), "{\"sessions\":null}\n", "utf8");

    const result = await runSomaLifecycleSessionStart({
      somaHome,
      substrate: "codex",
      sessionId: "bad-registry-start",
      timestamp: "2026-05-28T08:45:00.000Z",
    });
    const events = (await readFile(join(somaHome, "memory/STATE/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; metadata?: Record<string, unknown> });
    const failed = events.find((event) => event.kind === "lifecycle.session_start.registry-write-failed");

    expect(result.files).toContain(join(somaHome, "memory/STATE/events.jsonl"));
    expect(failed).toBeDefined();
    expect(events.some((event) => event.kind === "lifecycle.session_start")).toBe(true);
    expect(failed?.metadata?.error).toContain("sessions must be an object");
    expect(failed?.metadata?.error).not.toContain(somaHome);
  });
});

test("pi.dev home projection refreshes the current-work pointer at session and prompt boundaries", () => {
  const projection = projectPiDevHome(portableProjectionInput, "/tmp/soma-home");
  const extension = projection.files.find((file) => file.path === "agent/extensions/soma.ts")?.content ?? "";

  expect(extension).toContain('runSomaLifecycle("session-start", sessionId)');
  expect(extension).toContain('pi.on("session_start"');
  expect(extension).toContain('pi.on("before_agent_start"');
  expect(extension).toContain("const startupContext = refreshStartupContext(sessionId(ctx));");
  expect(extension).toContain('runSomaLifecycle("session-end", sessionId)');
});
