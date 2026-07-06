import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { appendSomaMemoryEvent, auditMemory, rebuildMemoryIndex, somaMemoryEventsPath, writeMemoryNote, writeSessionDigest } from "../src/index";
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

/** Seed a `memory.recall` journal event directly (bypassing `recallMemory`), for
 *  precise control over the retrieval-quality probe's inputs. */
async function seedRecallEvent(somaHome: string, noteIds: string[]): Promise<void> {
  await appendSomaMemoryEvent(somaHome, {
    substrate: "custom",
    kind: "memory.recall",
    summary: `Recalled ${noteIds.length} note(s)`,
    metadata: { query: "test query", terms: ["test", "query"], noteIds, resultCount: noteIds.length, unresolvedLinksCount: 0 },
  });
}

/** Seed a `memory.verify` journal event directly, matching the shape
 *  `verifyMemoryNote` (memory-write.ts) actually writes (`metadata.id`). */
async function seedVerifyEvent(somaHome: string, id: string): Promise<void> {
  await appendSomaMemoryEvent(somaHome, {
    substrate: "custom",
    kind: "memory.verify",
    summary: `Verified memory note ${id}`,
    metadata: { id, type: "semantic", resurfaceCount: 1 },
  });
}

/** Seed N filler journal events of an unrelated kind, to push a later event
 *  outside the retrieval-quality probe's subsequent-event correlation window. */
async function seedFillerEvents(somaHome: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await appendSomaMemoryEvent(somaHome, { substrate: "custom", kind: "test.filler", summary: `filler ${i}` });
  }
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
    const notePath = await writeNote(somaHome, "durable", "A durable note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    // Pin BOTH the durable note (older) and INDEX (newer) mtimes so freshness is
    // deterministic — otherwise the note keeps its real wall-clock mtime, which the
    // forced INDEX time may predate (a time-of-day flake).
    await setMtime(notePath, new Date("2026-07-04T09:00:00.000Z"));
    await setMtime(join(somaHome, "memory/INDEX.md"), new Date("2026-07-04T10:00:00.000Z"));
    // An episodic write lands AFTER (real mtime, now) but must NOT stale the durable INDEX.
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

test("a NON-canonical digest file cannot satisfy archive coverage", async () => {
  await withTempSoma(async (somaHome) => {
    await writeArchivedEpisodicNote(somaHome, "20260704-real", "2026-07-04", "An archived session.");
    // A nested, non-canonical file named like the month must NOT count as its digest.
    const nested = join(somaHome, "memory/episodic/digests/nested");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "2026-07.md"), "- 20260704-real: sneaky non-canonical digest\n", "utf8");

    const result = await auditMemory({ somaHome });
    expect(result.orphanedArchive.some((p) => p.includes("20260704-real.md"))).toBe(true);
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

test("a symlinked note DIRECTORY is not followed (no reading outside the root)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "real", "A real note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    // Replace memory/procedural with a symlink to an outside dir holding a note.
    const outsideDir = join(somaHome, "..", "outside-notes");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "foreign.md"), "would-be note", "utf8");
    await rm(join(somaHome, "memory/procedural"), { recursive: true, force: true });
    await symlink(outsideDir, join(somaHome, "memory/procedural"));

    const result = await auditMemory({ somaHome });
    // The symlinked dir is not walked → only the one real semantic note is seen.
    expect(result.notesByType.semantic).toBe(1);
    expect(result.notesByType.procedural).toBe(0);
  });
});

test("a durable ROOT replaced by a symlink is UNHEALTHY, not silently empty", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "real", "A real note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    // Replace memory/semantic ROOT with a symlink to an outside dir of notes.
    const outsideDir = join(somaHome, "..", "swapped-root");
    await mkdir(outsideDir, { recursive: true });
    await rm(join(somaHome, "memory/semantic"), { recursive: true, force: true });
    await symlink(outsideDir, join(somaHome, "memory/semantic"));

    const result = await auditMemory({ somaHome });
    // Must NOT fail open as healthy-empty — the root-integrity gate fails.
    expect(result.healthy).toBe(false);
    expect(result.probes.find((p) => p.name === "root-integrity")?.ok).toBe(false);
  });
});

// --- #425 retrieval-quality (informational) -----------------------------------

test("retrieval-quality: a recall-then-verify pair and a recall-then-nothing compute volume, empty-recall-rate, and verify-follows-recall-rate", async () => {
  await withTempSoma(async (somaHome) => {
    // recall #1: returns a note, then gets verified shortly after → counts as followed
    await seedRecallEvent(somaHome, ["note-a"]);
    await seedVerifyEvent(somaHome, "note-a");
    // recall #2: returns a note, never verified → does not count
    await seedRecallEvent(somaHome, ["note-b"]);
    // recall #3: empty result set → counts toward empty-recall-rate, excluded from
    // the verify-follows-recall denominator
    await seedRecallEvent(somaHome, []);

    const result = await auditMemory({ somaHome });
    const probe = result.probes.find((p) => p.name === "retrieval-quality");

    expect(result.retrieval.recallVolume).toBe(3);
    expect(result.retrieval.emptyRecallRate).toBeCloseTo(1 / 3);
    expect(result.retrieval.recallsWithResults).toBe(2);
    expect(result.retrieval.verifyFollowsRecallRate).toBeCloseTo(1 / 2);
    expect(probe?.gatesHealth).toBe(false);
    expect(probe?.ok).toBe(true);
  });
});

test("retrieval-quality: a verify outside the subsequent-event window does not count as followed", async () => {
  await withTempSoma(async (somaHome) => {
    await seedRecallEvent(somaHome, ["note-a"]);
    await seedFillerEvents(somaHome, 50); // fills the whole correlation window
    await seedVerifyEvent(somaHome, "note-a"); // arrives one event too late

    const result = await auditMemory({ somaHome });
    expect(result.retrieval.recallsWithResults).toBe(1);
    expect(result.retrieval.verifyFollowsRecallRate).toBe(0);
  });
});

test("retrieval-quality: a verify just inside the subsequent-event window still counts", async () => {
  await withTempSoma(async (somaHome) => {
    await seedRecallEvent(somaHome, ["note-a"]);
    await seedFillerEvents(somaHome, 49); // last event still inside the window
    await seedVerifyEvent(somaHome, "note-a");

    const result = await auditMemory({ somaHome });
    expect(result.retrieval.verifyFollowsRecallRate).toBe(1);
  });
});

test("retrieval-quality: an empty tree (no journal) reports zeroed rates, not NaN", async () => {
  await withTempSoma(async (somaHome) => {
    const result = await auditMemory({ somaHome });
    expect(result.retrieval).toEqual({
      recallVolume: 0,
      emptyRecallRate: 0,
      verifyFollowsRecallRate: 0,
      recallsWithResults: 0,
      verifyWindowEvents: 50,
      skippedEventLines: 0,
    });
  });
});

test("retrieval-quality: a malformed journal line is skipped, counted, and surfaced — the metric still computes over the parseable events", async () => {
  await withTempSoma(async (somaHome) => {
    // A real recall-then-verify pair, with a garbage line spliced in the middle so
    // the malformed line sits inside the recall's lookahead window.
    await seedRecallEvent(somaHome, ["note-a"]);
    await appendFile(somaMemoryEventsPath(somaHome), "this is not json\n", "utf8");
    await seedVerifyEvent(somaHome, "note-a");

    const result = await auditMemory({ somaHome });
    // the malformed line does not derail the metric: the verify still follows the recall
    expect(result.retrieval.recallVolume).toBe(1);
    expect(result.retrieval.recallsWithResults).toBe(1);
    expect(result.retrieval.verifyFollowsRecallRate).toBe(1);
    // ...and the skipped count is surfaced on the result AND in the probe detail
    expect(result.retrieval.skippedEventLines).toBe(1);
    expect(result.probes.find((p) => p.name === "retrieval-quality")?.detail).toContain("1 malformed line(s) skipped");
  });
});

test("retrieval-quality: the event-ratio line count includes a malformed line (coarse count unchanged)", async () => {
  await withTempSoma(async (somaHome) => {
    await seedRecallEvent(somaHome, ["note-a"]); // 1 valid line
    await appendFile(somaMemoryEventsPath(somaHome), "garbage\n", "utf8"); // 1 malformed line

    const result = await auditMemory({ somaHome });
    // event-ratio counts every non-empty line, parseable or not: 2
    expect(result.events.lines).toBe(2);
    // but only 1 parseable event fed the retrieval metric
    expect(result.retrieval.recallVolume).toBe(1);
    expect(result.retrieval.skippedEventLines).toBe(1);
  });
});

test("soma memory audit renders the retrieval-quality probe, and it never changes healthy/exit code", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "clean", "A clean, indexed note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });
    await seedRecallEvent(somaHome, []); // an empty recall — would gate a stricter check, but this probe never gates

    const result = await auditMemory({ somaHome });
    expect(result.healthy).toBe(true);
    expect(result.probes.find((p) => p.name === "retrieval-quality")?.gatesHealth).toBe(false);

    const out = await runMemoryCli(parseMemoryArgs(["memory", "audit", "--soma-home", somaHome]));
    expect(out).toContain("Soma memory audit: HEALTHY");
    expect(out).toContain("retrieval-quality:");
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

// Real spawned-process exit codes (not just a thrown SomaCliError) — the audit is a
// CI gate, so the actual process exit is what matters.
test("the spawned CLI exits 0 on a healthy tree and non-zero on an unhealthy one", async () => {
  await withTempSoma(async (somaHome) => {
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    await writeNote(somaHome, "clean", "A clean, indexed note.");
    await rebuildMemoryIndex({ somaHome, now: NOW });

    const healthy = Bun.spawnSync(["bun", "run", cli, "memory", "audit", "--soma-home", somaHome]);
    expect(healthy.exitCode).toBe(0);

    // Corrupt a note → the process must exit non-zero.
    await writeFile(join(somaHome, "memory/semantic/broken.md"), "invalid", "utf8");
    const unhealthy = Bun.spawnSync(["bun", "run", cli, "memory", "audit", "--soma-home", somaHome]);
    expect(unhealthy.exitCode).not.toBe(0);
  });
});
