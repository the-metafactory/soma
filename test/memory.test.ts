import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  appendSomaMemoryEvent,
  bootstrapSomaHome,
  captureSomaFeedback,
  captureSomaResult,
  classifySomaFeedback,
  createAlgorithmRun,
  promoteAlgorithmRunMemory,
  readAlgorithmRunById,
  searchSomaMemory,
  searchSomaResults,
  somaMemoryEventsPath,
  SOMA_RESULT_EVENT_KINDS,
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
  expect(classifySomaFeedback("check this for me")).toMatchObject({
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
      storeExcerpt: true,
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

test("feedback capture omits prompt-derived excerpts by default", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await captureSomaFeedback({
      homeDir,
      substrate: "codex",
      source: "prompt-submit",
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
      storeExcerpt: true,
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

test("captures Codex skill results as append-only result events without full output text", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const result = await captureSomaResult({
      homeDir,
      substrate: "codex",
      source: "assistant-final",
      summary: "OfferPitch produced an offer draft for the current task.",
      skill: "OfferPitch",
      sessionId: "codex-session-1",
      artifactPaths: ["codex-sessions/session.jsonl"],
    });

    expect(result.event).toMatchObject({
      substrate: "codex",
      kind: "result.captured",
      summary: "OfferPitch produced an offer draft for the current task.",
      artifactPaths: ["codex-sessions/session.jsonl"],
      metadata: {
        skill: "OfferPitch",
        sessionId: "codex-session-1",
        source: "assistant-final",
        promptStored: false,
        resultStored: false,
        resultKind: "skill-output",
      },
    });

    const events = await readFile(somaMemoryEventsPath(somaHome), "utf8");
    expect(events).toContain("OfferPitch produced an offer draft");
    expect(events).not.toContain("Full generated pitch text");
  });
});

test("captures Pi.dev typed learning result events", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    const result = await captureSomaResult({
      homeDir,
      substrate: "pi-dev",
      source: "pai-tool",
      kind: "learning.signal",
      summary: "GetCounts appended a rating signal for the completed review.",
      artifactPaths: ["memory/LEARNING/SIGNALS/ratings.jsonl"],
    });

    expect(result.event).toMatchObject({
      substrate: "pi-dev",
      kind: "learning.signal",
      artifactPaths: ["memory/LEARNING/SIGNALS/ratings.jsonl"],
      metadata: {
        source: "pai-tool",
        promptStored: false,
        resultStored: false,
      },
    });
  });
});

test("rejects full-result shaped capture summaries", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });

    await expect(
      captureSomaResult({
        homeDir,
        substrate: "codex",
        source: "assistant-final",
        summary: `Short heading\nFull generated result body follows.`,
      }),
    ).rejects.toThrow("summary must be a single line");
    await expect(
      captureSomaResult({
        homeDir,
        substrate: "codex",
        source: "assistant-final",
        summary: "x".repeat(501),
      }),
    ).rejects.toThrow("500 characters or fewer");
  });
});

test("searches captured result events with event and artifact provenance", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    const capture = await captureSomaResult({
      homeDir,
      substrate: "codex",
      source: "assistant-final",
      summary: "CourseBuilder produced a backward design outline for crisis training.",
      skill: "CourseBuilder",
      artifactPaths: ["codex-sessions/coursebuilder.jsonl"],
    });

    const result = await searchSomaResults({
      homeDir,
      query: "CourseBuilder crisis training",
    });

    expect(result.matches[0]).toMatchObject({
      eventPath: somaMemoryEventsPath(somaHome),
      line: 1,
      eventId: capture.event.id,
      kind: "result.captured",
      artifactPaths: ["codex-sessions/coursebuilder.jsonl"],
    });
  });
});

test("result search skips malformed result-shaped events", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await appendFile(
      somaMemoryEventsPath(somaHome),
      [
        JSON.stringify({ id: "bad-summary", kind: "result.captured", artifactPaths: ["bad.jsonl"] }),
        JSON.stringify({ kind: "result.captured", summary: "AI missing id" }),
        JSON.stringify({ id: "bad-artifacts", kind: "result.captured", summary: "AI malformed", artifactPaths: "bad.jsonl" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await searchSomaResults({ homeDir, query: "AI malformed" });

    expect(result.matches).toEqual([
      expect.objectContaining({
        eventId: "bad-artifacts",
        summary: "AI malformed",
        artifactPaths: [],
      }),
    ]);
  });
});

test("searches short result queries such as AI and Pi", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    await captureSomaResult({
      homeDir,
      substrate: "pi-dev",
      source: "pai-tool",
      summary: "Pi tool produced an AI signal.",
    });

    await expect(searchSomaResults({ homeDir, query: "AI" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ summary: "Pi tool produced an AI signal." })],
    });
    await expect(searchSomaResults({ homeDir, query: "Pi" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ summary: "Pi tool produced an AI signal." })],
    });
  });
});

test("rejects invalid result search limits at the API boundary", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });

    await expect(searchSomaResults({ homeDir, query: "AI", limit: 0 })).rejects.toThrow("positive safe integer");
    await expect(searchSomaResults({ homeDir, query: "AI", limit: -1 })).rejects.toThrow("positive safe integer");
    await expect(searchSomaResults({ homeDir, query: "AI", limit: 1.5 })).rejects.toThrow("positive safe integer");
  });
});

test("caps large result search limits at the API boundary", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    for (let index = 0; index < 105; index += 1) {
      await captureSomaResult({
        homeDir,
        substrate: "codex",
        source: "test",
        summary: `Repeated result ${index}`,
      });
    }

    const result = await searchSomaResults({ homeDir, query: "repeated", limit: 1000 });

    expect(result.matches).toHaveLength(100);
  });
});

test("defines migrated PAI tool event vocabulary", () => {
  expect(SOMA_RESULT_EVENT_KINDS).toEqual([
    "result.captured",
    "learning.signal",
    "learning.pattern",
    "learning.failure",
    "wisdom.frame-update",
    "wisdom.cross-frame",
    "relationship.reflection",
    "opinion.tracked",
  ]);
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

test("searches migrated PAI artifact roots without exposing root constants", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await mkdir(join(somaHome, "memory/WISDOM/FRAMES"), { recursive: true });
    await mkdir(join(somaHome, "identity"), { recursive: true });
    await writeFile(join(somaHome, "memory/WISDOM/FRAMES/frame.md"), "Crystal clarity connects cross-frame synthesis.\n", "utf8");
    await writeFile(join(somaHome, "identity/opinions.md"), "Opinion confidence favors explicit provenance.\n", "utf8");

    await expect(searchSomaMemory({ homeDir, query: "crystal synthesis" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ snippet: expect.stringContaining("Crystal clarity") })],
    });
    await expect(searchSomaMemory({ homeDir, query: "opinion provenance" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ snippet: expect.stringContaining("Opinion confidence") })],
    });
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
          frontmatter: {
            task: "Capture a reusable consulting insight.",
            effort: "E1",
            mode: "algorithm",
            phase: "complete",
            progress: "1/1",
            verified: true,
            updated: "2026-05-14T12:05:00.000Z",
          },
          sections: [
            { name: "Goal", content: "Consulting lesson becomes durable memory." },
            {
              name: "Criteria",
              content: "- [x] C1: Lesson is promoted.\n  Evidence: Promotion evidence is present.",
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
    const { run } = await readAlgorithmRunById("consulting-lesson", { homeDir });

    expect(result.path).toEndWith("memory/KNOWLEDGE/PROMOTED/consulting-autonomy-metric-consulting-lesson.md");
    expect(content).toContain("Measure autonomy transfer, not dependency.");
    expect(content).toContain("Recall when designing AI consulting offers.");
    expect(events[0]).toMatchObject({
      substrate: "codex",
      kind: "memory.promotion",
      summary: "Promoted Algorithm run consulting-lesson to knowledge: Consulting autonomy metric",
    });
    expect(run.provenance.at(-1)).toMatchObject({
      timestamp: "2026-05-14T12:30:00.000Z",
      operation: "memory.promote",
      substrate: "codex",
      detail: "knowledge",
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
          frontmatter: {
            task: "Keep promotion paths flat.",
            effort: "E1",
            mode: "algorithm",
            phase: "complete",
            progress: "1/1",
            verified: true,
            updated: "2026-05-14T12:05:00.000Z",
          },
          sections: [
            { name: "Goal", content: "Promotion filename is path-safe." },
            { name: "Criteria", content: "- [x] C1: Filename is safe.\n  Evidence: Path is flat." },
          ],
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
