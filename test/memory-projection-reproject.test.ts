import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { bootstrapSomaHome, reprojectSubstrateMemoryProjection, serializeMemoryNote, type SomaMemoryNote } from "../src/index";
import { memoryIndexPath } from "../src/memory-index";
import { memoryNotePath, type WritableType } from "../src/memory-write";

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-memory-reproject-"));
  try {
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

function note(overrides: Partial<SomaMemoryNote> & { id: string; body: string }): SomaMemoryNote {
  return {
    type: "semantic",
    created: "2026-07-01",
    last_verified: "2026-07-01",
    valid_until: null,
    provenance: "conversation",
    trust: "principal",
    source_of_truth: null,
    project: null,
    links: [],
    resurface_count: 0,
    ...overrides,
  };
}

async function seed(somaHome: string, n: SomaMemoryNote): Promise<void> {
  const path = memoryNotePath(somaHome, n.type as WritableType, n.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeMemoryNote(n), "utf8");
}

const FAR_PAST = new Date("2020-01-01T00:00:00.000Z");

/** Narrow a nullable `projected` path to `string`, failing loudly if absent. */
function expectProjected(projected: string | null): string {
  if (projected === null) throw new Error("expected reprojectSubstrateMemoryProjection to project a file");
  return projected;
}

test("reprojectSubstrateMemoryProjection writes only the memory bundle file, not CONTEXT/PURPOSE/SKILLS", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    await seed(somaHome, note({ id: "fact", body: "the gateway retries thrice", trust: "principal" }));

    const result = await reprojectSubstrateMemoryProjection({ substrate: "claude-code", homeDir });

    expect(result.reindexed).toBe(true); // missing-index → first rebuild
    expect(result.projected).toBe(join(homeDir, ".claude", "rules", "soma", "MEMORY.md"));
    const content = await readFile(expectProjected(result.projected), "utf8");
    expect(content).toContain("fact —");

    // Sibling projection files were never written by a reproject — CONTEXT.md /
    // PURPOSE.md / SKILLS.md are install/reproject-owned, not reproject-owned.
    await expect(stat(join(homeDir, ".claude", "rules", "soma", "CONTEXT.md"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".claude", "rules", "soma", "PURPOSE.md"))).rejects.toThrow();
    await expect(stat(join(homeDir, ".claude", "rules", "soma", "SKILLS.md"))).rejects.toThrow();
  });
});

test("reprojectSubstrateMemoryProjection picks up a new note across a simulated rebuild", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });

    const first = await reprojectSubstrateMemoryProjection({ substrate: "claude-code", homeDir });
    expect(first.reindexed).toBe(true); // missing-index → rebuild (empty-corpus placeholder)
    const firstContent = await readFile(expectProjected(first.projected), "utf8");
    expect(firstContent).toContain("No notes have earned an index line yet");

    // Force the just-built index stale relative to a NEW note about to land —
    // deterministic regardless of real mtime resolution (see memory-index.test.ts).
    await utimes(memoryIndexPath(somaHome), FAR_PAST, FAR_PAST);
    await seed(somaHome, note({ id: "new-fact", body: "newly learned", trust: "principal" }));

    const second = await reprojectSubstrateMemoryProjection({ substrate: "claude-code", homeDir });

    expect(second.reindexed).toBe(true);
    const secondContent = await readFile(expectProjected(second.projected), "utf8");
    expect(secondContent).toContain("new-fact —");
  });
});

test("reprojectSubstrateMemoryProjection no-ops when the index is up to date but empty", async () => {
  await withTempHome(async (homeDir) => {
    const { somaHome } = await bootstrapSomaHome({ homeDir });
    // Present (so reindex has nothing to rebuild — no notes exist, so it can
    // never look stale) but whitespace-only: loadMemoryIndexForProjection
    // treats that as "no memory file to project", per M4.
    await mkdir(dirname(memoryIndexPath(somaHome)), { recursive: true });
    await writeFile(memoryIndexPath(somaHome), "   \n", "utf8");

    const result = await reprojectSubstrateMemoryProjection({ substrate: "claude-code", homeDir });

    expect(result).toEqual({ reindexed: false, projected: null });
  });
});

test("reprojectSubstrateMemoryProjection no-ops (but still reindexes) for a SubstrateId with no install spec", async () => {
  await withTempHome(async (homeDir) => {
    await bootstrapSomaHome({ homeDir });
    // "custom"/"cortex" are valid SubstrateId values but have no install spec —
    // no default home, no home-projection builder — so there is nothing to
    // project, even though the index itself can still be (re)built.
    const result = await reprojectSubstrateMemoryProjection({ substrate: "custom", homeDir });
    expect(result.reindexed).toBe(true);
    expect(result.projected).toBeNull();
  });
});
