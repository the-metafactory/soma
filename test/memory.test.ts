import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  appendSomaMemoryEvent,
  bootstrapSomaHome,
  captureSomaFeedback,
  classifySomaFeedback,
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

test("classifies feedback prompts into candidate kinds", () => {
  expect(classifySomaFeedback("you missed the arc-manifest")).toMatchObject({
    kind: "missed-surface",
    confidence: "high",
  });
  expect(classifySomaFeedback("from now on, check arc manifests on version bumps")).toMatchObject({
    kind: "preference",
    confidence: "high",
  });
  expect(classifySomaFeedback("what should I do next?")).toMatchObject({
    kind: "none",
  });
  expect(classifySomaFeedback("you should add tests")).toMatchObject({
    kind: "none",
  });
  expect(classifySomaFeedback("what is wrong with this bug?")).toMatchObject({
    kind: "none",
  });
  expect(classifySomaFeedback("make a nice UI")).toMatchObject({
    kind: "none",
  });
  expect(classifySomaFeedback("ordinary question about the repo")).toMatchObject({
    kind: "none",
  });
});

test("captures actionable feedback as append-only candidate event", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await captureSomaFeedback({
      homeDir,
      substrate: "codex",
      source: "test",
      text: "you missed the arc-manifest",
    });

    expect(result).toMatchObject({
      captured: true,
      classification: {
        kind: "missed-surface",
      },
    });

    const events = parseEvents(await readFile(somaMemoryEventsPath(somaHome), "utf8"));
    expect(events[0]).toMatchObject({
      substrate: "codex",
      kind: "feedback.candidate",
      summary: "Feedback candidate captured: missed-surface.",
      metadata: {
        feedbackKind: "missed-surface",
        source: "test",
        promptStored: false,
        excerptStored: true,
        redactedExcerpt: "you missed the arc-manifest",
        excerptTruncated: false,
      },
    });
  });
});

test("automatic hook feedback omits prompt-derived excerpts", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await captureSomaFeedback({
      homeDir,
      substrate: "codex",
      source: "prompt-submit",
      storeExcerpt: false,
      text: "you missed this secret detail",
    });

    const events = await readFile(somaMemoryEventsPath(somaHome), "utf8");
    expect(events).toContain('"excerptStored":false');
    expect(events).not.toContain("secret detail");
    expect(events).not.toContain("redactedExcerpt");
  });
});

test("does not persist prompt text when capturing feedback", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const githubToken = ["ghp", "1234567890abcdefghijklmnop"].join("_");
    const awsKey = ["AKIA", "1234567890ABCDEF"].join("");
    await captureSomaFeedback({
      homeDir,
      substrate: "codex",
      source: "test",
      text: `you missed this: api_key=test-key-value-123456789 ${githubToken} ${awsKey}`,
    });

    const events = await readFile(somaMemoryEventsPath(somaHome), "utf8");
    expect(events).toContain("promptStored");
    expect(events).toContain("[redacted]");
    expect(events).not.toContain("test-key-value-123456789");
    expect(events).not.toContain(githubToken);
    expect(events).not.toContain(awsKey);
  });
});

test("captures standalone feedback without bootstrapping profile files", async () => {
  await withTempHome(async (homeDir) => {
    const result = await captureSomaFeedback({
      homeDir,
      substrate: "codex",
      text: "you missed the standalone bootstrap path",
    });

    expect(result.captured).toBe(true);
    await expect(readFile(join(homeDir, ".soma/profile/assistant.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(homeDir, ".soma/memory/STATE/events.jsonl"), "utf8")).resolves.toContain("feedback.candidate");
  });
});

test("does not capture non-feedback prompts", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await captureSomaFeedback({
      homeDir,
      substrate: "codex",
      text: "what is the next useful thing to port?",
    });

    expect(result.captured).toBe(false);
    expect(result.event).toBeUndefined();
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
