import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { consolidateMemory, parseMemoryNote, serializeMemoryNote, type SomaMemoryNote } from "../src/index";
import { memoryIndexPath } from "../src/memory-index";
import { createPaths } from "../src/paths";
// Plan/apply internals are module-private (not public index API) — import direct,
// for the #412 plan-immutability acceptance test.
import { applyConsolidationPlan, planConsolidation, type ConsolidationPlan } from "../src/memory-consolidate";

const NOW = new Date("2026-07-04T10:00:00.000Z");

async function withTempSoma<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-consol-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function note(overrides: Partial<SomaMemoryNote> & { id: string; body: string; type: SomaMemoryNote["type"] }): SomaMemoryNote {
  return {
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

async function writeNote(somaHome: string, relPath: string, n: SomaMemoryNote): Promise<string> {
  const path = join(somaHome, relPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeMemoryNote(n), "utf8");
  return path;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

// --- episodic prune → archive ------------------------------------------------

test("aged episodic session (>90d) is archived + folded into a monthly digest; recent stays", async () => {
  await withTempSoma(async (somaHome) => {
    const oldPath = await writeNote(
      somaHome,
      "memory/episodic/sessions/2026-03/20260301-old.md",
      note({ id: "20260301-old", type: "episodic", trust: "assistant", created: "2026-03-01", body: "old session summary" }),
    );
    const recentPath = await writeNote(
      somaHome,
      "memory/episodic/sessions/2026-07/20260701-new.md",
      note({ id: "20260701-new", type: "episodic", trust: "assistant", created: "2026-07-01", body: "recent session" }),
    );

    const result = await consolidateMemory({ somaHome, now: NOW });

    expect(result.archived).toHaveLength(1);
    expect(result.archived[0].from).toContain("memory/episodic/sessions/2026-03/20260301-old.md");
    // archive mirrors the source path relative to memory/, kept under memory/archive/
    expect(result.archived[0].to).toBe("memory/archive/episodic/sessions/2026-03/20260301-old.md");
    expect(await exists(oldPath)).toBe(false); // moved
    expect(await exists(join(somaHome, "memory/archive/episodic/sessions/2026-03/20260301-old.md"))).toBe(true);
    expect(await exists(recentPath)).toBe(true); // untouched
    const digest = await readFile(join(somaHome, "memory/episodic/digests/2026-03.md"), "utf8");
    expect(digest).toContain("- 20260301-old: old session summary");
  });
});

test("aged episodic action uses the 180d TTL (a 100d-old action is NOT pruned)", async () => {
  await withTempSoma(async (somaHome) => {
    // 2026-03-26 is ~100 days before NOW — older than the 90d session TTL but within
    // the 180d action TTL, so it must survive.
    await writeNote(
      somaHome,
      "memory/episodic/actions/2026-03/20260326-act.md",
      note({ id: "20260326-act", type: "episodic", trust: "assistant", created: "2026-03-26", body: "an action" }),
    );
    const result = await consolidateMemory({ somaHome, now: NOW });
    expect(result.archived).toHaveLength(0);
  });
});

test("episodic enumeration is depth-limited: a note NESTED below a month dir is NOT archived", async () => {
  await withTempSoma(async (somaHome) => {
    // An aged note directly under its month dir — MUST be archived.
    const direct = await writeNote(
      somaHome,
      "memory/episodic/sessions/2026-03/20260301-direct.md",
      note({ id: "20260301-direct", type: "episodic", trust: "assistant", created: "2026-03-01", body: "direct session" }),
    );
    // A same-aged note one level DEEPER (`<month>/<subdir>/...`) — an episodic note
    // lives at `<month>/<note>.md`, never deeper, so this is not a note the pass
    // should ever parse or move. Consolidation must not descend into the subdir.
    const nested = await writeNote(
      somaHome,
      "memory/episodic/sessions/2026-03/nested/20260302-nested.md",
      note({ id: "20260302-nested", type: "episodic", trust: "assistant", created: "2026-03-02", body: "nested session" }),
    );

    const result = await consolidateMemory({ somaHome, now: NOW });

    // Only the direct note is archived; the nested one is left completely untouched.
    expect(result.archived).toHaveLength(1);
    expect(result.archived[0].from).toContain("2026-03/20260301-direct.md");
    expect(await exists(direct)).toBe(false); // moved to archive
    expect(await exists(nested)).toBe(true); // never seen, never moved
    // The regression signal: a recursive walk would have PARSED the nested note
    // and (its parent dir "nested" ≠ its created month) surfaced it as unreadable.
    // A depth-limited walk never enumerates it, so `unreadable` stays empty.
    expect(result.unreadable).toHaveLength(0);
    expect(result.unreadable.some((p) => p.includes("20260302-nested"))).toBe(false);
  });
});

test("a symlinked episodic month directory is NOT traversed (trust-boundary guard)", async () => {
  await withTempSoma(async (somaHome) => {
    // A foreign directory with an old note, reached only via a symlinked month dir.
    const foreign = join(somaHome, "..", "foreign");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "20260301-evil.md"), serializeMemoryNote(
      note({ id: "20260301-evil", type: "episodic", trust: "assistant", created: "2026-03-01", body: "foreign note" }),
    ), "utf8");
    await mkdir(join(somaHome, "memory/episodic/sessions"), { recursive: true });
    await symlink(foreign, join(somaHome, "memory/episodic/sessions/2026-03"));

    const result = await consolidateMemory({ somaHome, now: NOW });
    // the symlinked month is skipped → nothing archived, foreign file untouched
    expect(result.archived).toHaveLength(0);
    expect(await exists(join(foreign, "20260301-evil.md"))).toBe(true);
  });
});

test("the monthly digest is regenerated cumulatively from the archive across runs", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "memory/episodic/sessions/2026-03/20260301-a.md",
      note({ id: "20260301-a", type: "episodic", trust: "assistant", created: "2026-03-01", body: "session a" }));
    await consolidateMemory({ somaHome, now: NOW });

    // a second aged note in the SAME month, archived on a later run
    await writeNote(somaHome, "memory/episodic/sessions/2026-03/20260315-b.md",
      note({ id: "20260315-b", type: "episodic", trust: "assistant", created: "2026-03-15", body: "session b" }));
    await consolidateMemory({ somaHome, now: NOW });

    const digest = await readFile(join(somaHome, "memory/episodic/digests/2026-03.md"), "utf8");
    expect(digest).toContain("- 20260301-a: session a");
    expect(digest).toContain("- 20260315-b: session b"); // prior-archived note NOT lost
  });
});

test("archiving refuses a symlinked archive-destination parent (escape guard)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "memory/episodic/sessions/2026-03/20260301-old.md",
      note({ id: "20260301-old", type: "episodic", trust: "assistant", created: "2026-03-01", body: "old" }));
    // pre-create memory/archive as a symlink pointing outside the memory root
    const outside = join(somaHome, "..", "outside-archive");
    await mkdir(outside, { recursive: true });
    await mkdir(join(somaHome, "memory"), { recursive: true });
    await symlink(outside, join(somaHome, "memory/archive"));

    await expect(consolidateMemory({ somaHome, now: NOW })).rejects.toThrow(/refusing to write outside/);
    // the aged note is NOT moved through the symlink
    expect(await exists(join(somaHome, "memory/episodic/sessions/2026-03/20260301-old.md"))).toBe(true);
  });
});

// --- mark stale --------------------------------------------------------------

test("aged-unverified semantic is marked review:stale but NEVER archived; used/recent are not", async () => {
  await withTempSoma(async (somaHome) => {
    const stalePath = await writeNote(
      somaHome,
      "memory/semantic/old-fact.md",
      note({ id: "old-fact", type: "semantic", last_verified: "2026-01-01", resurface_count: 0, body: "an old unverified fact" }),
    );
    await writeNote(
      somaHome,
      "memory/semantic/used-fact.md",
      note({ id: "used-fact", type: "semantic", last_verified: "2026-01-01", resurface_count: 3, body: "an old but resurfaced fact" }),
    );
    await writeNote(
      somaHome,
      "memory/semantic/recent-fact.md",
      note({ id: "recent-fact", type: "semantic", last_verified: "2026-06-20", resurface_count: 0, body: "a recent fact" }),
    );

    const result = await consolidateMemory({ somaHome, now: NOW });

    expect(result.markedStale.some((p) => p.includes("old-fact.md"))).toBe(true);
    expect(result.markedStale.some((p) => p.includes("used-fact.md"))).toBe(false);
    expect(result.markedStale.some((p) => p.includes("recent-fact.md"))).toBe(false);
    // marked in place, NOT archived
    expect(await exists(stalePath)).toBe(true);
    expect(parseMemoryNote(await readFile(stalePath, "utf8")).review).toBe("stale");
    expect(result.archived).toHaveLength(0);
  });
});

// --- contradictions ----------------------------------------------------------

test("lexically-similar active notes are LISTED as near-duplicate pairs (no merge, no semantic check)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "memory/semantic/a.md", note({ id: "a", type: "semantic", body: "gateway retries thrice before dead lettering the message" }));
    await writeNote(somaHome, "memory/semantic/b.md", note({ id: "b", type: "semantic", body: "gateway retries thrice before dead lettering the message now" }));
    await writeNote(somaHome, "memory/semantic/c.md", note({ id: "c", type: "semantic", body: "completely unrelated content about widgets" }));

    const result = await consolidateMemory({ somaHome, now: NOW });
    expect(result.similarPairs).toHaveLength(1);
    expect([result.similarPairs[0].a, result.similarPairs[0].b].sort()).toEqual(["a", "b"]);
    // both files still present — listing only, no merge/delete
    expect(await exists(join(somaHome, "memory/semantic/a.md"))).toBe(true);
    expect(await exists(join(somaHome, "memory/semantic/b.md"))).toBe(true);
  });
});

test("unreadable note files are surfaced, never silently skipped", async () => {
  await withTempSoma(async (somaHome) => {
    await mkdir(join(somaHome, "memory/semantic"), { recursive: true });
    await writeFile(join(somaHome, "memory/semantic/broken.md"), "not a valid note", "utf8");
    const result = await consolidateMemory({ somaHome, now: NOW });
    expect(result.unreadable.some((p) => p.includes("broken.md"))).toBe(true);
  });
});

// --- state GC ----------------------------------------------------------------

test("current-work state older than 7d is GC'd (the one deletion); recent kept", async () => {
  await withTempSoma(async (somaHome) => {
    const stateDir = join(somaHome, "memory/STATE");
    await mkdir(stateDir, { recursive: true });
    const oldState = join(stateDir, "current-work-old-abc.json");
    const newState = join(stateDir, "current-work-new-def.json");
    await writeFile(oldState, "{}", "utf8");
    await writeFile(newState, "{}", "utf8");
    const old = new Date(NOW.getTime() - 8 * 86_400_000);
    const recent = new Date(NOW.getTime() - 2 * 86_400_000);
    await utimes(oldState, old, old);
    await utimes(newState, recent, recent);

    // without --gc-state, protected state is NOT deleted
    const noFlag = await consolidateMemory({ somaHome, now: NOW });
    expect(noFlag.stateGced).toEqual([]);
    expect(await exists(oldState)).toBe(true);

    // with the explicit override, old state is GC'd; recent kept
    const result = await consolidateMemory({ somaHome, now: NOW, gcState: true });
    expect(result.stateGced.some((p) => p.includes("current-work-old-abc.json"))).toBe(true);
    expect(await exists(oldState)).toBe(false);
    expect(await exists(newState)).toBe(true);
  });
});

// --- INDEX + dry-run parity + idempotency ------------------------------------

test("a MUTATING real run rebuilds INDEX.md; a no-op run skips the rebuild", async () => {
  await withTempSoma(async (somaHome) => {
    // no-op: only a recent note, nothing aged → no mutation → no rebuild
    await writeNote(somaHome, "memory/semantic/f.md", note({ id: "f", type: "semantic", trust: "principal", body: "a fact" }));
    await consolidateMemory({ somaHome, now: NOW });
    expect(await exists(memoryIndexPath(somaHome))).toBe(false);

    // add an aged episodic note → the pass mutates (archives) → INDEX rebuilds
    await writeNote(somaHome, "memory/episodic/sessions/2026-03/20260301-old.md",
      note({ id: "20260301-old", type: "episodic", trust: "assistant", created: "2026-03-01", body: "old" }));
    await consolidateMemory({ somaHome, now: NOW });
    expect(await exists(memoryIndexPath(somaHome))).toBe(true);
  });
});

test("--dry-run changes nothing and its plan matches the subsequent real run", async () => {
  await withTempSoma(async (somaHome) => {
    const oldPath = await writeNote(
      somaHome,
      "memory/episodic/sessions/2026-03/20260301-old.md",
      note({ id: "20260301-old", type: "episodic", trust: "assistant", created: "2026-03-01", body: "old session" }),
    );
    await writeNote(somaHome, "memory/semantic/old-fact.md", note({ id: "old-fact", type: "semantic", last_verified: "2026-01-01", body: "stale fact" }));

    const dry = await consolidateMemory({ somaHome, now: NOW, dryRun: true });
    expect(dry.dryRun).toBe(true);
    // dry-run touched nothing
    expect(await exists(oldPath)).toBe(true);
    expect(await exists(memoryIndexPath(somaHome))).toBe(false);

    const real = await consolidateMemory({ somaHome, now: NOW });
    // the dry-run plan matched what the real run did
    expect(dry.archived).toEqual(real.archived);
    expect(dry.markedStale).toEqual(real.markedStale);
    expect(dry.stateGced).toEqual(real.stateGced);
    expect(dry.similarPairs).toEqual(real.similarPairs);
    expect(await exists(oldPath)).toBe(false); // real run applied
  });
});

test("consolidation is idempotent — a second real run plans no file mutations", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(
      somaHome,
      "memory/episodic/sessions/2026-03/20260301-old.md",
      note({ id: "20260301-old", type: "episodic", trust: "assistant", created: "2026-03-01", body: "old session" }),
    );
    await writeNote(somaHome, "memory/semantic/old-fact.md", note({ id: "old-fact", type: "semantic", last_verified: "2026-01-01", body: "stale fact" }));

    await consolidateMemory({ somaHome, now: NOW });
    const second = await consolidateMemory({ somaHome, now: NOW });
    expect(second.archived).toEqual([]);
    expect(second.markedStale).toEqual([]);
    expect(second.stateGced).toEqual([]);
  });
});

// --- #412: an immutable plan, an applied delta returned separately ----------

test("planConsolidation's plan is frozen and untouched by applyConsolidationPlan (#412)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(
      somaHome,
      "memory/episodic/sessions/2026-03/20260301-old.md",
      note({ id: "20260301-old", type: "episodic", trust: "assistant", created: "2026-03-01", body: "old session" }),
    );
    await writeNote(somaHome, "memory/semantic/old-fact.md", note({ id: "old-fact", type: "semantic", last_verified: "2026-01-01", body: "stale fact" }));

    const paths = createPaths(somaHome);
    const plan = await planConsolidation(paths, {}, NOW);

    // Frozen top-level and every array field — an accidental future mutation
    // throws (ES modules run in strict mode) rather than silently drifting from
    // what a dry-run reported.
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.episodic)).toBe(true);
    expect(Object.isFrozen(plan.digestsWritten)).toBe(true);
    expect(Object.isFrozen(plan.staleMarks)).toBe(true);
    expect(Object.isFrozen(plan.similarPairs)).toBe(true);
    expect(Object.isFrozen(plan.stateGc)).toBe(true);
    expect(Object.isFrozen(plan.unreadable)).toBe(true);
    expect(() => plan.unreadable.push("x")).toThrow(TypeError);
    expect(() => {
      (plan as { mutated: boolean }).mutated = false;
    }).toThrow(TypeError);

    // Sanity: this plan actually has something to apply (episodic archive +
    // stale mark), so the immutability proof below isn't vacuous.
    expect(plan.episodic.length).toBe(1);
    expect(plan.staleMarks.length).toBe(1);
    expect(plan.mutated).toBe(true);

    const planSnapshot = structuredClone({ ...plan });
    const applied = await applyConsolidationPlan(paths, plan, NOW, undefined);

    // The plan object itself is byte-identical to before the apply — the
    // real-run mutations landed on disk (asserted below) and in the SEPARATELY
    // returned `applied` delta, never patched back onto `plan`.
    expect({ ...plan }).toEqual(planSnapshot);
    expect(applied.mutated).toBe(true);
    expect(applied.markedStale).toEqual(plan.staleMarks.map((s) => s.rel));

    // The apply actually happened on disk.
    expect(await exists(join(somaHome, "memory/archive/episodic/sessions/2026-03/20260301-old.md"))).toBe(true);
    expect(parseMemoryNote(await readFile(join(somaHome, "memory/semantic/old-fact.md"), "utf8")).review).toBe("stale");
  });
});

// A plan built by planConsolidation only ever holds in-memory-tree paths, but
// applyConsolidationPlan is exported — a forged plan must not drive a mutation
// outside the Memory compartment, whether by `..` traversal, into a non-Memory
// compartment, or through a symlinked ancestor. (#423 hardening)
const forgedPlan = (somaHome: string, staleMark: string, extra: Partial<ConsolidationPlan> = {}): ConsolidationPlan => ({
  somaHome,
  indexPath: join(somaHome, "memory", "INDEX.md"),
  episodic: [],
  digestsWritten: [],
  staleMarks: staleMark ? [{ path: staleMark, rel: "forged", note: note({ id: "x", type: "semantic", body: "forged mark" }) }] : [],
  similarPairs: [],
  stateGc: [],
  unreadable: [],
  mutated: true,
  ...extra,
});

test("applyConsolidationPlan rejects a forged `..` path escaping the memory tree (#423)", async () => {
  await withTempSoma(async (somaHome) => {
    const escapeTarget = join(somaHome, "..", "escaped-stale.md");
    await expect(applyConsolidationPlan(createPaths(somaHome), forgedPlan(somaHome, escapeTarget), NOW, undefined)).rejects.toThrow(
      /escapes the memory tree/,
    );
    expect(await exists(escapeTarget)).toBe(false);
  });
});

test("applyConsolidationPlan rejects a forged path into a non-Memory compartment (#423)", async () => {
  await withTempSoma(async (somaHome) => {
    // Inside the soma home but OUTSIDE memory/ — consolidation must never touch Identity/Purpose/…
    const target = join(somaHome, "profile", "purpose.md");
    await expect(applyConsolidationPlan(createPaths(somaHome), forgedPlan(somaHome, target), NOW, undefined)).rejects.toThrow(
      /escapes the memory tree/,
    );
    expect(await exists(target)).toBe(false);
  });
});

test("applyConsolidationPlan rejects a forged path through a symlinked in-tree ancestor (#423)", async () => {
  await withTempSoma(async (somaHome) => {
    const outside = join(somaHome, "..", "outside-target");
    await mkdir(outside, { recursive: true });
    const link = join(somaHome, "memory", "evil-link"); // lexically in-tree, resolves outside
    await mkdir(join(somaHome, "memory"), { recursive: true });
    await symlink(outside, link);
    const target = join(link, "note.md");
    await expect(applyConsolidationPlan(createPaths(somaHome), forgedPlan(somaHome, target), NOW, undefined)).rejects.toThrow(
      /resolves outside the memory tree/,
    );
    expect(await exists(join(outside, "note.md"))).toBe(false);
  });
});
