import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  appendSomaMemoryEvent,
  bootstrapSomaHome,
  createAlgorithmRun,
  promoteAlgorithmRunMemory,
  searchSomaMemory,
  somaMemoryEventsPath,
  writeAlgorithmRun,
  type SomaMemoryEvent,
} from "../src/index";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-memory-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function parseEvents(content: string): SomaMemoryEvent[] {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SomaMemoryEvent);
}

test("appends a substrate memory event to soma state JSONL", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const event = await appendSomaMemoryEvent(somaHome, {
      substrate: "codex",
      kind: "verification",
      summary: "Codex projection installed.",
      artifactPaths: ["~/.codex/rules/soma.rules"],
      metadata: {
        tests: 23,
      },
    });

    expect(event.id).toStartWith("evt_");
    expect(event.timestamp).toContain("T");

    const events = parseEvents(await readFile(somaMemoryEventsPath(somaHome), "utf8"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      substrate: "codex",
      kind: "verification",
      summary: "Codex projection installed.",
      artifactPaths: ["~/.codex/rules/soma.rules"],
      metadata: {
        tests: 23,
      },
    });
  });
});

test("preserves caller supplied memory event id and timestamp", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const event = await appendSomaMemoryEvent(somaHome, {
      id: "event-1",
      timestamp: "2026-05-14T12:00:00.000Z",
      substrate: "claude-code",
      kind: "learning",
      summary: "Claude Code produced a useful project overlay.",
    });

    expect(event).toMatchObject({
      id: "event-1",
      timestamp: "2026-05-14T12:00:00.000Z",
    });
  });
});

test("appends multiple memory events without overwriting previous events", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });

    await appendSomaMemoryEvent(somaHome, {
      substrate: "codex",
      kind: "work",
      summary: "First event.",
    });
    await appendSomaMemoryEvent(somaHome, {
      substrate: "pi-dev",
      kind: "work",
      summary: "Second event.",
    });

    const events = parseEvents(await readFile(somaMemoryEventsPath(somaHome), "utf8"));

    expect(events.map((event) => event.summary)).toEqual(["First event.", "Second event."]);
  });
});

test("rejects memory events missing required text fields", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });

    await expect(
      appendSomaMemoryEvent(somaHome, {
        substrate: "codex",
        kind: " ",
        summary: "Missing kind.",
      }),
    ).rejects.toThrow("kind must not be empty");
  });
});

test("searches Soma memory and profile files with cited snippets", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await mkdir(join(somaHome, "memory/KNOWLEDGE/consulting"), { recursive: true });
    await writeFile(
      join(somaHome, "memory/KNOWLEDGE/consulting/autonomy.md"),
      "# Autonomy Consulting\n\nClient sovereignty increases when consulting transfers agency instead of dependency.\n",
      "utf8",
    );

    const result = await searchSomaMemory({
      homeDir,
      query: "client sovereignty agency",
      limit: 3,
    });

    expect(result.matches[0]).toMatchObject({
      line: 3,
      score: 3,
    });
    expect(result.matches[0]?.path).toEndWith("memory/KNOWLEDGE/consulting/autonomy.md");
    expect(result.matches[0]?.snippet).toContain("Client sovereignty");
  });
});

test("promotes an Algorithm run into durable Soma memory", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await writeAlgorithmRun(
      {
        ...createAlgorithmRun({
          id: "consulting-lesson",
          prompt: "Find the consulting lesson",
          intent: "Capture a reusable consulting insight.",
          currentState: "Insight is inside a run.",
          goal: "Consulting lesson becomes durable memory.",
          criteria: [{ id: "C1", text: "Lesson is promoted." }],
        }),
        isa: {
          slug: "consulting-lesson",
          phase: "complete",
          goal: "Consulting lesson becomes durable memory.",
          criteria: [
            {
              id: "C1",
              text: "Lesson is promoted.",
              status: "passed",
              verification: "Promotion evidence is present.",
            },
          ],
        },
        verification: [{ timestamp: "2026-05-14T12:05:00.000Z", phase: "verify", text: "Promotion evidence is present." }],
        learning: [{ timestamp: "2026-05-14T12:00:00.000Z", phase: "learn", text: "Measure autonomy transfer, not dependency." }],
      },
      { homeDir },
    );

    const result = await promoteAlgorithmRunMemory({
      homeDir,
      fromRun: "consulting-lesson",
      store: "knowledge",
      substrate: "codex",
      title: "Consulting autonomy metric",
      appliesWhen: "Recall when designing AI consulting offers.",
      timestamp: "2026-05-14T12:30:00.000Z",
    });
    const content = await readFile(result.path, "utf8");
    const events = parseEvents(await readFile(somaMemoryEventsPath(somaHome), "utf8"));

    expect(result.path).toEndWith("memory/KNOWLEDGE/PROMOTED/consulting-autonomy-metric-consulting-lesson.md");
    expect(content).toContain("Measure autonomy transfer, not dependency.");
    expect(content).toContain("Recall when designing AI consulting offers.");
    expect(events[0]).toMatchObject({
      substrate: "codex",
      kind: "memory.promotion",
      summary: "Promoted Algorithm run consulting-lesson to knowledge: Consulting autonomy metric",
    });
  });
});

test("refuses to promote unverified Algorithm runs", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await writeAlgorithmRun(
      createAlgorithmRun({
        id: "unverified-run",
        prompt: "Promote early",
        intent: "Attempt to promote draft work.",
        currentState: "No evidence exists.",
        goal: "Draft stays out of durable memory.",
        criteria: [{ id: "C1", text: "Verification exists." }],
      }),
      { homeDir },
    );

    await expect(
      promoteAlgorithmRunMemory({
        homeDir,
        fromRun: "unverified-run",
        store: "learning",
        title: "Draft lesson",
      }),
    ).rejects.toThrow("has no verification evidence or passed criteria");
  });
});

test("sanitizes Algorithm run ids in promotion filenames", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await writeAlgorithmRun(
      {
        ...createAlgorithmRun({
          id: "nested/run:id",
          prompt: "Promote nested run id",
          intent: "Keep promotion paths flat.",
          currentState: "Run id contains path-shaped characters.",
          goal: "Promotion filename is path-safe.",
          criteria: [{ id: "C1", text: "Filename is safe." }],
        }),
        isa: {
          slug: "nested-run-id",
          phase: "complete",
          goal: "Promotion filename is path-safe.",
          criteria: [{ id: "C1", text: "Filename is safe.", status: "passed", verification: "Path is flat." }],
        },
      },
      { homeDir },
    );

    const result = await promoteAlgorithmRunMemory({
      homeDir,
      fromRun: "nested/run:id",
      store: "learning",
      title: "Nested ID lesson",
    });

    expect(result.path).toEndWith("memory/LEARNING/PROMOTED/nested-id-lesson-nested-run-id.md");
  });
});
