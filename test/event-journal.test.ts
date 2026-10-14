import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { appendSomaMemoryEvent, somaMemoryEventsPath } from "../src/event-journal";

async function withTempHome(fn: (somaHome: string) => Promise<void>): Promise<void> {
  const somaHome = await mkdtemp(join(tmpdir(), "soma-event-journal-"));
  try {
    await fn(somaHome);
  } finally {
    await rm(somaHome, { recursive: true, force: true });
  }
}

test("journal preserves the state path and exact event line", async () => {
  await withTempHome(async (somaHome) => {
    const eventPath = somaMemoryEventsPath(somaHome);
    expect(eventPath).toBe(join(somaHome, "memory", "STATE", "events.jsonl"));
    await appendSomaMemoryEvent(somaHome, {
      id: "event-1",
      timestamp: "2026-05-14T12:00:00.000Z",
      substrate: "codex",
      kind: "verification",
      summary: "Verified.\nNext line.",
      artifactPaths: ["report.md"],
      metadata: { tests: 23 },
    });
    expect(await readFile(eventPath, "utf8")).toBe(
      '{"id":"event-1","timestamp":"2026-05-14T12:00:00.000Z","substrate":"codex","kind":"verification","summary":"Verified.\\nNext line.","artifactPaths":["report.md"],"metadata":{"tests":23}}\n',
    );
  });
});

test("journal propagates a directory creation error", async () => {
  await withTempHome(async (somaHome) => {
    await writeFile(join(somaHome, "memory"), "obstruction", "utf8");
    await expect(appendSomaMemoryEvent(somaHome, {
      substrate: "codex", kind: "verification", summary: "Cannot create state directory.",
    })).rejects.toMatchObject({ code: "ENOTDIR", syscall: "mkdir" });
    expect(await readFile(join(somaHome, "memory"), "utf8")).toBe("obstruction");
  });
});

test("journal propagates a file write error", async () => {
  await withTempHome(async (somaHome) => {
    await mkdir(somaMemoryEventsPath(somaHome), { recursive: true });
    await expect(appendSomaMemoryEvent(somaHome, {
      substrate: "codex", kind: "verification", summary: "Cannot write event file.",
    })).rejects.toMatchObject({ code: "EISDIR" });
  });
});
