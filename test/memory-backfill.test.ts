/**
 * Memory subsystem M8 — backfill (`src/memory-backfill.ts`).
 *
 * Bulk-import legacy free-form markdown into schema-valid notes through the M1
 * write path. Deterministic, no LLM, `import`-trigger → `quarantined` trust,
 * SHA-manifest idempotency. See `Plans/declarative-twirling-lampson.md`.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { auditMemory } from "../src/index";
import { planMemoryBackfill, runMemoryBackfill } from "../src/memory-backfill";
import { parseMemoryNote } from "../src/memory-note";
import { parseMemoryArgs } from "../src/cli/memory";
import type { SomaMemoryNote } from "../src/types";

async function withTempSoma<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-backfill-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write a legacy source file under `<somaHome>/memory/<rel>` with an optional mtime. */
async function seed(somaHome: string, rel: string, body: string, mtime?: Date): Promise<string> {
  const path = join(somaHome, "memory", rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body, "utf8");
  if (mtime) await utimes(path, mtime, mtime);
  return path;
}

async function readNote(path: string): Promise<SomaMemoryNote> {
  return parseMemoryNote(await readFile(path, "utf8"));
}

test("maps category dir → note type (LEARNING→procedural, KNOWLEDGE→semantic, other→semantic)", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "LEARNING/a-lesson.md", "how to do the thing well");
    await seed(somaHome, "KNOWLEDGE/a-fact.md", "the sky is a certain color today");
    await seed(somaHome, "RELATIONSHIP/a-note.md", "some other category content here");

    const result = await runMemoryBackfill({ somaHome });

    expect(result.writtenCount).toBe(3);
    const byRel = new Map(result.entries.map((e) => [e.relativePath, e]));
    expect(byRel.get("LEARNING/a-lesson.md")?.type).toBe("procedural");
    expect(byRel.get("KNOWLEDGE/a-fact.md")?.type).toBe("semantic");
    expect(byRel.get("RELATIONSHIP/a-note.md")?.type).toBe("semantic");
  });
});

test("a custom --from root imports markdown sitting directly under it (category \"\" → semantic)", async () => {
  await withTempSoma(async (somaHome) => {
    const from = join(somaHome, "external-notes");
    await mkdir(from, { recursive: true });
    await writeFile(join(from, "loose-note.md"), "a note living at the custom root", "utf8");
    await mkdir(join(from, "TOPIC"), { recursive: true });
    await writeFile(join(from, "TOPIC", "nested.md"), "a nested note under a topic dir", "utf8");

    const result = await runMemoryBackfill({ somaHome, from });
    expect(result.writtenCount).toBe(2);
    const byRel = new Map(result.entries.map((e) => [e.relativePath, e]));
    // Root-level file is imported (not treated as README/INDEX territory).
    expect(byRel.get("loose-note.md")?.type).toBe("semantic");
    expect(byRel.get("loose-note.md")?.noteId).toBe("loose-note");
    expect(byRel.get("TOPIC/nested.md")?.type).toBe("semantic");
  });
});

test("--type forces a single type, overriding the category map", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/x.md", "forced type body one two three");
    const result = await runMemoryBackfill({ somaHome, type: "procedural" });
    expect(result.entries[0]?.type).toBe("procedural");
  });
});

test("every backfilled note lands at quarantined trust with import provenance and source_of_truth", async () => {
  await withTempSoma(async (somaHome) => {
    const src = await seed(somaHome, "KNOWLEDGE/fact.md", "an imported fact worth keeping around");
    const result = await runMemoryBackfill({ somaHome });
    const note = await readNote(result.entries[0].target);
    expect(note.trust).toBe("quarantined");
    expect(note.provenance).toBe("import");
    expect(note.source_of_truth).toBe(src);
    expect(note.body).toContain("an imported fact worth keeping around");
    // Body is verbatim legacy content — no injected preamble (would inflate dedup).
    expect(note.body).not.toContain("Backfilled from");
  });
});

test("created/last_verified derive from the source mtime, not the clock", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/dated.md", "content with a known mtime abc def", new Date("2025-03-14T10:00:00Z"));
    const result = await runMemoryBackfill({ somaHome });
    const note = await readNote(result.entries[0].target);
    expect(note.created).toBe("2025-03-14");
    expect(note.last_verified).toBe("2025-03-14");
    expect(result.entries[0].created).toBe("2025-03-14");
  });
});

test("id derivation slugifies <category>-<stem> and disambiguates collisions", async () => {
  await withTempSoma(async (somaHome) => {
    // Same stem in two subdirs of the same category → same base slug → collision.
    await seed(somaHome, "LEARNING/ALGORITHM/deploy_ci.md", "first distinct body about deploy ci alpha");
    await seed(somaHome, "LEARNING/REFLECTIONS/deploy_ci.md", "second distinct body about deploy ci beta");
    const result = await runMemoryBackfill({ somaHome });
    const ids = result.entries.map((e) => e.noteId).sort();
    expect(ids).toEqual(["learning-deploy-ci", "learning-deploy-ci-2"]);
    // Both are valid slugs and unique.
    expect(new Set(ids).size).toBe(2);
  });
});

test("skips reserved dirs, root-level files, and README.md", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/keep.md", "keep this real knowledge body");
    await seed(somaHome, "KNOWLEDGE/README.md", "readme skip");
    await seed(somaHome, "STATE/current-work-x.json", "{}");
    await seed(somaHome, "episodic/sessions/x.md", "episodic skip");
    await seed(somaHome, "README.md", "root readme skip");

    const result = await runMemoryBackfill({ somaHome });
    expect(result.writtenCount).toBe(1);
    expect(result.entries.map((e) => e.relativePath)).toEqual(["KNOWLEDGE/keep.md"]);
  });
});

test("refuses a symlinked source root", async () => {
  await withTempSoma(async (somaHome) => {
    const real = join(somaHome, "real-src");
    await mkdir(join(real, "KNOWLEDGE"), { recursive: true });
    await writeFile(join(real, "KNOWLEDGE", "n.md"), "a note under the real source", "utf8");
    const link = join(somaHome, "linked-src");
    await symlink(real, link);
    await expect(runMemoryBackfill({ somaHome, from: link })).rejects.toThrow(/refused symlink source root/i);
  });
});

test("leaves the store audit-clean: INDEX rebuilt after writes", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/a.md", "an imported fact for audit health");
    await seed(somaHome, "LEARNING/b.md", "a lesson for audit health check");
    const result = await runMemoryBackfill({ somaHome });
    expect(result.writtenCount).toBe(2);
    const audit = await auditMemory({ somaHome });
    expect(audit.healthy).toBe(true);
  });
});

test("imports only markdown files — non-markdown under a category dir is skipped", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/note.md", "a real markdown note body");
    await seed(somaHome, "KNOWLEDGE/creds.env", "SECRET=should-never-be-imported");
    await seed(somaHome, "KNOWLEDGE/data.json", '{"not":"a note"}');
    await seed(somaHome, "KNOWLEDGE/deep.markdown", "a .markdown file is also imported");
    // READMEs are skipped case-insensitively, for both markdown extensions.
    await seed(somaHome, "KNOWLEDGE/Readme.md", "readme variant skip");
    await seed(somaHome, "KNOWLEDGE/README.MD", "readme variant skip two");
    await seed(somaHome, "KNOWLEDGE/README.markdown", "readme variant skip three");

    const result = await runMemoryBackfill({ somaHome });
    expect(result.entries.map((e) => e.relativePath).sort()).toEqual([
      "KNOWLEDGE/deep.markdown",
      "KNOWLEDGE/note.md",
    ]);
    expect(result.writtenCount).toBe(2);
  });
});

test("no-op rerun is byte-stable even when a source is touched (mtime bumped, bytes unchanged)", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/a.md", "stable body content one two three", new Date("2025-01-01T00:00:00Z"));
    const first = await runMemoryBackfill({ somaHome, now: new Date("2026-07-04T00:00:00Z") });
    expect(first.writtenCount).toBe(1);
    const manifest1 = await readFile(first.manifestPath, "utf8");

    // Touch the source: mtime changes, bytes (and thus SHA) do not.
    await utimes(join(somaHome, "memory", "KNOWLEDGE", "a.md"), new Date("2025-06-06T00:00:00Z"), new Date("2025-06-06T00:00:00Z"));
    const second = await runMemoryBackfill({ somaHome, now: new Date("2026-07-05T00:00:00Z") });
    expect(second.skippedManifestCount).toBe(1);
    expect(second.writtenCount).toBe(0);
    expect(await readFile(second.manifestPath, "utf8")).toBe(manifest1);
  });
});

test("refuses symlinks loudly", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/real.md", "a real file body here");
    const linkPath = join(somaHome, "memory", "KNOWLEDGE", "link.md");
    await symlink(join(somaHome, "memory", "KNOWLEDGE", "real.md"), linkPath);
    await expect(runMemoryBackfill({ somaHome })).rejects.toThrow(/refused symlink/i);
  });
});

test("near-duplicate bodies are skipped as duplicates, not errors (sequential intra-batch dedup)", async () => {
  await withTempSoma(async (somaHome) => {
    const body = "the federation deploy runbook lives in cortex and runs nightly at midnight";
    await seed(somaHome, "KNOWLEDGE/a.md", body);
    await seed(somaHome, "KNOWLEDGE/b.md", body);
    const result = await runMemoryBackfill({ somaHome });
    expect(result.writtenCount).toBe(1);
    expect(result.skippedDuplicateCount).toBe(1);
    expect(result.errorCount).toBe(0);
    const dup = result.entries.find((e) => e.status === "skipped-duplicate");
    expect(dup?.detail).toMatch(/Recall-first refusal/);
  });
});

test("a manifest built for a different --from root is not treated as a hit", async () => {
  await withTempSoma(async (somaHome) => {
    const dirA = join(somaHome, "a");
    const dirB = join(somaHome, "b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, "note.md"), "body from root A one two three", "utf8");
    await writeFile(join(dirB, "note.md"), "distinct body from root B four five six", "utf8");

    const first = await runMemoryBackfill({ somaHome, from: dirA });
    expect(first.writtenCount).toBe(1);

    // Same relative path ("note.md") but a different root — must NOT skip-manifest.
    const second = await runMemoryBackfill({ somaHome, from: dirB });
    expect(second.skippedManifestCount).toBe(0);
    expect(second.writtenCount).toBe(1);
  });
});

test("an unreadable source is recorded as a per-file error, not a batch abort", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/good.md", "a healthy note body one two three");
    const badPath = await seed(somaHome, "KNOWLEDGE/bad.md", "an unreadable body four five six");
    await chmod(badPath, 0o000);
    // Under root, mode 000 doesn't restrict reads — detect and relax the assertion.
    let restricted: boolean;
    try {
      await readFile(badPath, "utf8");
      restricted = false;
    } catch {
      restricted = true;
    }

    // The key property: one bad source never aborts the whole batch.
    const result = await runMemoryBackfill({ somaHome });
    expect(result.entries.some((e) => e.relativePath === "KNOWLEDGE/good.md" && e.status === "written")).toBe(true);
    if (restricted) {
      expect(result.errorCount).toBe(1);
      const bad = result.entries.find((e) => e.relativePath === "KNOWLEDGE/bad.md");
      expect(bad?.status).toBe("error");
    }
    await chmod(badPath, 0o600); // let withTempSoma clean up
  });
});

test("--dry-run plans without writing or touching the manifest", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/x.md", "dry run body content here");
    const plan = await runMemoryBackfill({ somaHome, dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.entries).toHaveLength(1);
    expect(plan.writtenCount).toBe(0);
    // Nothing on disk.
    await expect(readFile(plan.entries[0].target, "utf8")).rejects.toThrow();
    await expect(readFile(plan.manifestPath, "utf8")).rejects.toThrow();
  });
});

test("planMemoryBackfill matches the dry-run plan shape", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "LEARNING/y.md", "plan shape body content");
    const plan = await planMemoryBackfill({ somaHome });
    expect(plan.dryRun).toBe(true);
    expect(plan.entries[0]?.type).toBe("procedural");
    expect(plan.entries[0]?.noteId).toBe("learning-y");
  });
});

test("idempotent rerun: 0 written, all skipped-manifest, byte-identical manifest", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/a.md", "idempotency body alpha one");
    await seed(somaHome, "LEARNING/b.md", "idempotency body beta two");

    const first = await runMemoryBackfill({ somaHome, now: new Date("2026-07-04T00:00:00Z") });
    expect(first.writtenCount).toBe(2);
    const manifest1 = await readFile(first.manifestPath, "utf8");

    const second = await runMemoryBackfill({ somaHome, now: new Date("2026-07-05T00:00:00Z") });
    expect(second.writtenCount).toBe(0);
    expect(second.skippedManifestCount).toBe(2);
    const manifest2 = await readFile(second.manifestPath, "utf8");

    // importedAt preserved (no writes) → byte-stable manifest despite a later clock.
    expect(manifest2).toBe(manifest1);
  });
});

test("rerun with a different --type is not a silent manifest hit (type guard keeps --type honest)", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/x.md", "distinct body content alpha beta gamma");
    const first = await runMemoryBackfill({ somaHome }); // KNOWLEDGE → semantic
    expect(first.entries[0].type).toBe("semantic");

    // Rerun forcing procedural: NOT a manifest hit (type differs). The identical
    // body is caught by the recall-first gate → skipped-duplicate, not skipped-manifest.
    const second = await runMemoryBackfill({ somaHome, type: "procedural" });
    expect(second.skippedManifestCount).toBe(0);
    expect(second.skippedDuplicateCount).toBe(1);
    expect(second.writtenCount).toBe(0);
  });
});

test("a changed source file after import is re-imported as a new note on rerun", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, "KNOWLEDGE/a.md", "original imported body one two three");
    await runMemoryBackfill({ somaHome });

    // Edit the source (new SHA) → no longer a manifest hit; distinct body avoids the dedup gate.
    await seed(somaHome, "KNOWLEDGE/a.md", "wholly rewritten body four five six seven eight");
    const rerun = await runMemoryBackfill({ somaHome });
    expect(rerun.writtenCount).toBe(1);
  });
});

test("CLI parses backfill flags and rejects an unknown --type", async () => {
  const parsed = parseMemoryArgs([
    "memory",
    "backfill",
    "--from",
    "/tmp/src",
    "--type",
    "semantic",
    "--project",
    "soma",
    "--dry-run",
    "--soma-home",
    "/tmp/soma",
  ]);
  expect(parsed.action).toBe("backfill");
  if (parsed.action === "backfill") {
    expect(parsed.options.from).toBe("/tmp/src");
    expect(parsed.options.type).toBe("semantic");
    expect(parsed.options.project).toBe("soma");
    expect(parsed.options.dryRun).toBe(true);
    expect(parsed.options.somaHome).toBe("/tmp/soma");
  }
  expect(() => parseMemoryArgs(["memory", "backfill", "--type", "bogus"])).toThrow();
});
