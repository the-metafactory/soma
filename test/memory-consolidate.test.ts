import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { consolidateMemory, parseMemoryNote, serializeMemoryNote, type SomaMemoryNote } from "../src/index";
import { memoryIndexPath } from "../src/memory-index";

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

test("near-duplicate active notes are LISTED as contradictions (no auto-merge)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "memory/semantic/a.md", note({ id: "a", type: "semantic", body: "gateway retries thrice before dead lettering the message" }));
    await writeNote(somaHome, "memory/semantic/b.md", note({ id: "b", type: "semantic", body: "gateway retries thrice before dead lettering the message now" }));
    await writeNote(somaHome, "memory/semantic/c.md", note({ id: "c", type: "semantic", body: "completely unrelated content about widgets" }));

    const result = await consolidateMemory({ somaHome, now: NOW });
    expect(result.contradictions).toHaveLength(1);
    expect([result.contradictions[0].a, result.contradictions[0].b].sort()).toEqual(["a", "b"]);
    // both files still present — listing only, no merge/delete
    expect(await exists(join(somaHome, "memory/semantic/a.md"))).toBe(true);
    expect(await exists(join(somaHome, "memory/semantic/b.md"))).toBe(true);
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

test("real run rebuilds INDEX.md", async () => {
  await withTempSoma(async (somaHome) => {
    await writeNote(somaHome, "memory/semantic/f.md", note({ id: "f", type: "semantic", trust: "principal", body: "a fact" }));
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
    expect(dry.contradictions).toEqual(real.contradictions);
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
