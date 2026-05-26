import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  listSomaWorkRegistryEntries,
  upsertSomaWorkRegistryEntry,
} from "../src";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-work-registry-"));

  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("work registry helper writes PAI-aligned shared state without transcripts", async () => {
  await withTempHome(async (homeDir) => {
    const result = await upsertSomaWorkRegistryEntry({
      homeDir,
      sessionId: "session-1",
      sessionName: "ship work registry",
      substrate: "codex",
      task: "Align shared session state",
      phase: "complete",
      progress: "1/1",
      timestamp: "2026-05-26T10:00:00.000Z",
      artifacts: {
        isa: "memory/WORK/ship-work-registry/ISA.md",
      },
    });

    const workPath = join(homeDir, ".soma/memory/STATE/work.json");
    const namesPath = join(homeDir, ".soma/memory/STATE/session-names.json");
    const currentPath = join(homeDir, ".soma/memory/STATE/current-work-session-1.json");

    expect(result.files).toEqual([workPath, namesPath, currentPath]);
    const work = JSON.parse(await readFile(workPath, "utf8"));
    const names = JSON.parse(await readFile(namesPath, "utf8"));
    const current = JSON.parse(await readFile(currentPath, "utf8"));

    expect(Object.keys(work.sessions)).toEqual(["ship-work-registry"]);
    expect(work.sessions["ship-work-registry"]).toMatchObject({
      sessionUUID: "session-1",
      sessionName: "ship work registry",
      substrate: "codex",
      task: "Align shared session state",
      phase: "complete",
      progress: "1/1",
      artifacts: {
        isa: "memory/WORK/ship-work-registry/ISA.md",
      },
    });
    expect(names).toEqual({ "session-1": "ship work registry" });
    expect(current).toMatchObject({ slug: "ship-work-registry", sessionUUID: "session-1" });

    const serialized = JSON.stringify(work);
    expect(serialized).not.toContain("prompt");
    expect(serialized).not.toContain("result");

    await expect(listSomaWorkRegistryEntries({ homeDir })).resolves.toEqual([
      expect.objectContaining({ sessionUUID: "session-1", sessionName: "ship work registry" }),
    ]);
  });
});
