import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { appendSomaMemoryEvent, bootstrapSomaHome, searchSomaMemory, somaMemoryEventsPath, type SomaMemoryEvent } from "../src/index";

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
