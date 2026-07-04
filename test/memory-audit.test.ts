import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { auditMemory, rebuildMemoryIndex, writeMemoryNote, writeSessionDigest } from "../src/index";
import { parseMemoryArgs, runMemoryCli } from "../src/cli/memory";

const NOW = new Date("2026-07-04T10:00:00.000Z");
const SESSION = "0afea4e4-967d-4a38-a855-0d12ac63c2f3";
const DIGEST_BODY = Array.from({ length: 10 }, (_, i) => `- line ${i + 1} of the digest`).join("\n");

async function withTempSoma<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-audit-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a valid semantic note directly (bypassing the write path's clock). */
async function writeNote(somaHome: string, id: string, body: string): Promise<string> {
  const r = await writeMemoryNote({ somaHome, now: NOW, mode: "create", trigger: "import", id, type: "semantic", body, provenance: "import" });
  return r.path;
}

async function setMtime(path: string, when: Date): Promise<void> {
  await utimes(path, when, when);
}

/** Write an archived episodic note under `archive/episodic/sessions/<month>/`. */
async function writeArchivedEpisodicNote(somaHome: string, id: string, created: string, body: string): Promise<void> {
  const month = created.slice(0, 7);
  const dir = join(somaHome, "memory/archive/episodic/sessions", month);
  await mkdir(dir, { recursive: true });
  const note = [
    "---", `id: ${id}`, "type: episodic", `created: ${created}`, `last_verified: ${created}`,
    "valid_until: null", "provenance: tool:test", "trust: assistant", "source_of_truth: null",
    "project: null", "links: []", "resurface_count: 0", "---", body, "",
  ].join("\n");
  await writeFile(join(dir, `${id}.md`), note, "utf8");
}

// --- healthy baseline ---------------------------------------------------------

test("a valid note + fresh INDEX audits HEALTHY with a type count", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "reporter-stack", "Reporter uses Bun and SQLite.");
    await rebuildMemoryIndex({ somaHome, now: NOW });

    const result = await auditMemory({ somaHome });
    expect(result.healthy).toBe(true);
    expect(result.notesByType.semantic).toBe(1);
    expect(result.invalidNotes).toEqual([]);
    expect(result.index.stale).toBe(false);
  });
});

test("an empty tree (no durable notes) is HEALTHY — nothing to index", async () => {
  await withTempSoma(async (somaHome) => {
    const result = await auditMemory({ somaHome });
    expect(result.healthy).toBe(true);
    expect(result.index.stale).toBe(false);
  });
});

// --- schema validity (gates health) ------------------------------------------

test("a schema-invalid note file makes the audit UNHEALTHY and is listed", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "good", "A perfectly good note body.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    await writeFile(join(somaHome, "memory/semantic/broken.md"), "not a note at all", "utf8");

    const result = await auditMemory({ somaHome });
    expect(result.healthy).toBe(false);
    expect(result.invalidNotes.some((p) => p.includes("broken.md"))).toBe(true);
    expect(result.probes.find((p) => p.name === "schema")?.ok).toBe(false);
  });
});

// --- INDEX freshness (gates health) ------------------------------------------

test("a durable note newer than INDEX.md is a stale-INDEX failure", async () => {
  await withTempSoma(async (somaHome) => {
    const notePath = await writeNote(somaHome, "fresh", "This note changed after the index build.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    // Force the note's mtime strictly after the INDEX's.
    await setMtime(join(somaHome, "memory/INDEX.md"), new Date("2026-07-04T10:00:00.000Z"));
    await setMtime(notePath, new Date("2026-07-04T11:00:00.000Z"));

    const result = await auditMemory({ somaHome });
    expect(result.index.stale).toBe(true);
    expect(result.healthy).toBe(false);
    expect(result.index.reason).toContain("newer than INDEX");
  });
});

test("durable notes present but INDEX.md absent is stale", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "unindexed", "No index was ever built for this corpus.");
    const result = await auditMemory({ somaHome });
    expect(result.index.stale).toBe(true);
    expect(result.index.reason).toContain("absent");
    expect(result.healthy).toBe(false);
  });
});

// --- episodic coverage + orphaned archive (informational) --------------------

test("session digests are counted and do not stale the durable INDEX", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "durable", "A durable note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    // An episodic write lands AFTER the index build but must NOT stale it.
    await setMtime(join(somaHome, "memory/INDEX.md"), new Date("2026-07-04T10:00:00.000Z"));
    await writeSessionDigest({ somaHome, now: new Date("2026-07-04T12:00:00.000Z"), sessionId: SESSION, body: DIGEST_BODY });

    const result = await auditMemory({ somaHome });
    expect(result.digests.sessionNotes).toBe(1);
    expect(result.index.stale).toBe(false); // episodic write does not stale the durable INDEX
    expect(result.healthy).toBe(true);
  });
});

test("an archived episodic note absent from any digest is reported as orphaned", async () => {
  await withTempSoma(async (somaHome) => {
    // An archived episodic note with no corresponding digest.
    await writeArchivedEpisodicNote(somaHome, "20260704-orphan", "2026-07-04", "An archived session with no digest pointer.");

    const result = await auditMemory({ somaHome });
    expect(result.orphanedArchive.some((p) => p.includes("20260704-orphan.md"))).toBe(true);
    // orphaned archive is informational — it does NOT by itself fail health
    expect(result.notesByType.episodic).toBe(1);
  });
});

test("an archived note referenced only in the WRONG month's digest is still orphaned", async () => {
  await withTempSoma(async (somaHome) => {
    // Archived note created 2026-07, but the only digest listing its id is 2026-06.
    await writeArchivedEpisodicNote(somaHome, "20260704-misfiled", "2026-07-04", "A misfiled archived session.");
    const digestsDir = join(somaHome, "memory/episodic/digests");
    await mkdir(digestsDir, { recursive: true });
    await writeFile(join(digestsDir, "2026-06.md"), "# Episodic digest 2026-06\n\n- 20260704-misfiled: a misfiled session\n", "utf8");

    const result = await auditMemory({ somaHome });
    expect(result.orphanedArchive.some((p) => p.includes("20260704-misfiled.md"))).toBe(true);
  });
});

test("a symlinked INDEX.md is refused — it cannot spoof freshness past the gate", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "durable", "A durable note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    // Replace the real INDEX with a symlink to a newer file outside the tree.
    const realIndex = join(somaHome, "memory/INDEX.md");
    const decoy = join(somaHome, "..", "newer-decoy.md");
    await writeFile(decoy, "not a real index", "utf8");
    await rm(realIndex);
    await symlink(decoy, realIndex);

    const result = await auditMemory({ somaHome });
    expect(result.index.stale).toBe(true);
    expect(result.healthy).toBe(false);
    expect(result.index.reason).toContain("symlink");
  });
});

// --- symlink safety -----------------------------------------------------------

test("a symlinked note is NOT followed (only real entries are audited)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "real", "A real note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    // A symlink pointing outside the tree must be ignored, not parsed/failed.
    const outside = join(somaHome, "..", "outside.md");
    await writeFile(outside, "not a note", "utf8");
    await symlink(outside, join(somaHome, "memory/semantic/link.md"));

    const result = await auditMemory({ somaHome });
    expect(result.notesByType.semantic).toBe(1); // only the real note
    expect(result.invalidNotes).toEqual([]); // the symlink was skipped, not flagged
  });
});

// --- CLI gate -----------------------------------------------------------------

test("the CLI exits non-zero (throws) on an unhealthy tree, with the report", async () => {
  await withTempSoma(async (somaHome) => {
    await mkdir(join(somaHome, "memory/semantic"), { recursive: true });
    await writeFile(join(somaHome, "memory/semantic/broken.md"), "invalid", "utf8");

    await expect(runMemoryCli(parseMemoryArgs(["memory", "audit", "--soma-home", somaHome]))).rejects.toThrow(/UNHEALTHY/);
  });
});

test("the CLI returns a HEALTHY report string on a clean tree", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "clean", "A clean, indexed note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    const out = await runMemoryCli(parseMemoryArgs(["memory", "audit", "--soma-home", somaHome]));
    expect(out).toContain("Soma memory audit: HEALTHY");
    expect(out).toContain("[ok] schema:");
  });
});
