import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  rebuildMemoryIndex,
  renderMemoryIndex,
  retentionScore,
  memoryIndexPath,
  serializeMemoryNote,
  type SomaMemoryNote,
} from "../src/index";
import { memoryNotePath, type WritableType } from "../src/memory-write";
import { parseMemoryArgs, runMemoryCli } from "../src/cli/memory";

const NOW = new Date("2026-07-11T10:00:00.000Z");

async function withTempSoma<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-index-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome);
  } finally {
    await rm(dir, { recursive: true, force: true });
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

// --- retentionScore ----------------------------------------------------------

test("retentionScore is 0 for a quarantined note regardless of resurface/recency", () => {
  const n = note({ id: "q", body: "x", trust: "quarantined", resurface_count: 9, last_verified: "2026-07-11" });
  expect(retentionScore(n, NOW)).toBe(0);
});

test("retentionScore is 0 when a note has never been resurfaced (freshness term is 0)", () => {
  const n = note({ id: "n", body: "x", trust: "principal", resurface_count: 0 });
  expect(retentionScore(n, NOW)).toBe(0);
});

test("retentionScore applies trust × type × freshness, with the recall decay curve", () => {
  // Use a midnight `now` so dt is exactly 10 days (the score uses the continuous
  // fractional dt, not the floored display age). procedural(3) × principal(3) × [3 × 0.5^(10/90)]
  const midnight = new Date("2026-07-11T00:00:00.000Z");
  const n = note({ id: "p", body: "x", type: "procedural", trust: "principal", resurface_count: 3, last_verified: "2026-07-01" });
  const expected = 3 * 3 * (3 * Math.pow(0.5, 10 / 90));
  expect(retentionScore(n, midnight)).toBeCloseTo(expected, 10);
});

test("retentionScore clamps a future last_verified to no decay", () => {
  const n = note({ id: "f", body: "x", type: "semantic", trust: "assistant", resurface_count: 4, last_verified: "2026-08-01" });
  // assistant(1) × semantic(2) × 4 (no decay)
  expect(retentionScore(n, NOW)).toBeCloseTo(1 * 2 * 4, 10);
});

// --- admission ladder --------------------------------------------------------

test("quarantined and superseded notes never earn an index line", () => {
  const notes = [
    note({ id: "quar", body: "secret", trust: "quarantined", resurface_count: 9 }),
    note({ id: "closed", body: "old", trust: "principal", resurface_count: 9, valid_until: "2026-07-05" }),
  ];
  const { content, admitted, excluded } = renderMemoryIndex(notes, NOW);
  expect(admitted).toBe(0);
  expect(excluded).toBe(2);
  expect(content).not.toContain("quar");
  expect(content).not.toContain("closed");
});

test("admission ladder: principal-marked OR resurfaced≥2 OR <7d grace earns a line; nothing else", () => {
  const notes = [
    note({ id: "principal-fresh", body: "b", trust: "principal", resurface_count: 0, created: "2026-01-01" }), // principal-marked
    note({ id: "resurfaced", body: "b", trust: "assistant", resurface_count: 2, created: "2026-01-01" }), // resurfaced ≥2
    note({ id: "grace", body: "b", trust: "assistant", resurface_count: 0, created: "2026-07-10" }), // <7d grace
    note({ id: "not-earned", body: "b", trust: "assistant", resurface_count: 1, created: "2026-01-01" }), // none
  ];
  const { content, admitted } = renderMemoryIndex(notes, NOW);
  expect(admitted).toBe(3);
  expect(content).toContain("principal-fresh");
  expect(content).toContain("resurfaced");
  expect(content).toContain("grace");
  expect(content).not.toContain("not-earned");
});

// --- golden file -------------------------------------------------------------

test("renderMemoryIndex golden output for a fixed tree and now", () => {
  const notes = [
    note({
      id: "restart-gateway",
      type: "procedural",
      trust: "principal",
      resurface_count: 3,
      last_verified: "2026-07-01",
      created: "2026-06-01",
      hook: "how to restart the gateway",
      body: "Drain, stop, start, verify health.",
    }),
    note({
      id: "old-assistant-fact",
      type: "semantic",
      trust: "assistant",
      resurface_count: 5,
      last_verified: "2026-05-01",
      created: "2026-01-01",
      body: "Gateway retries thrice before dead-lettering.",
    }),
    note({
      id: "prefers-colon",
      type: "semantic",
      trust: "principal",
      resurface_count: 0,
      last_verified: "2026-07-10",
      created: "2026-07-10",
      body: "Use a colon instead of an em-dash.",
    }),
    note({ id: "quar", body: "untrusted", trust: "quarantined", resurface_count: 9 }),
    note({ id: "stale", body: "cold", trust: "assistant", resurface_count: 0, created: "2026-01-01", last_verified: "2026-01-01" }),
  ];

  const { content, admitted, rendered, shed, excluded } = renderMemoryIndex(notes, NOW);

  const expected = [
    "# Soma Memory Index",
    "",
    "## Procedural",
    "- restart-gateway — how to restart the gateway · principal, verified 10d ago",
    "",
    "## Semantic",
    "- old-assistant-fact — Gateway retries thrice before dead-lettering. · assistant, verified 71d ago",
    "- prefers-colon — Use a colon instead of an em-dash. · principal, verified 1d ago",
    "",
  ].join("\n");

  expect(content).toBe(expected);
  expect(admitted).toBe(3);
  expect(rendered).toBe(3);
  expect(shed).toBe(0);
  expect(excluded).toBe(2);
});

// --- budget ------------------------------------------------------------------

test("line budget sheds the lowest-score notes first", () => {
  // 205 admitted semantic notes; resurface_count = rank so scores are strictly ordered.
  const notes = Array.from({ length: 205 }, (_, i) =>
    note({
      id: `note-${String(i + 1).padStart(3, "0")}`,
      body: `fact ${i + 1}`,
      trust: "assistant",
      resurface_count: i + 1, // 1..205 — all ≥2 except note-001; note-001 admitted via nothing? see below
      last_verified: "2026-07-10",
      created: "2026-07-10", // <7d grace so even note-001 (resurface 1) is admitted
    }),
  );

  const { content, admitted, rendered, shed } = renderMemoryIndex(notes, NOW);
  expect(admitted).toBe(205);
  expect(rendered).toBe(200);
  expect(shed).toBe(5);
  // the five lowest resurface_count (=lowest score) are shed
  for (const i of [1, 2, 3, 4, 5]) {
    expect(content).not.toContain(`note-${String(i).padStart(3, "0")} `);
  }
  expect(content).toContain("note-006 ");
  expect(content).toContain("note-205 ");
});

test("min-1-per-section guarantees a low-scoring section keeps a line under budget pressure", () => {
  const procedurals = Array.from({ length: 205 }, (_, i) =>
    note({
      id: `proc-${String(i + 1).padStart(3, "0")}`,
      type: "procedural",
      body: `step ${i + 1}`,
      trust: "principal",
      resurface_count: i + 10, // all high-scoring
      last_verified: "2026-07-10",
    }),
  );
  const lowSemantic = note({
    id: "lonely-semantic",
    type: "semantic",
    body: "the one semantic pointer",
    trust: "principal",
    resurface_count: 0, // score 0 — would lose to every procedural
    created: "2026-07-10",
  });

  const { content, rendered } = renderMemoryIndex([...procedurals, lowSemantic], NOW);
  expect(rendered).toBe(200);
  // even though 205 procedurals outscore it, the semantic section keeps its one line
  expect(content).toContain("lonely-semantic");
  expect(content).toContain("## Semantic");
});

test("byte budget holds with the shed footer included (never exceeds 25KB)", () => {
  // Long ids + max-length descriptors so ~200 lines would blow past 25KB — the
  // byte ceiling must bind before the line ceiling, and the appended shed footer
  // must NOT push the final content over MAX_INDEX_BYTES.
  const notes = Array.from({ length: 300 }, (_, i) =>
    note({
      id: `procedural-note-with-a-deliberately-long-slug-${String(i + 1).padStart(4, "0")}`,
      type: "procedural",
      body: "x".repeat(120), // truncated to the 80-char descriptor cap, still a long line
      trust: "principal",
      resurface_count: i + 2,
      last_verified: "2026-07-10",
    }),
  );

  const { content, rendered, shed } = renderMemoryIndex(notes, NOW);
  expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(25_000);
  expect(shed).toBeGreaterThan(0); // budget bound → footer present
  expect(content).toContain("earned a line but were shed");
  expect(rendered).toBeLessThan(300);
});

test("empty corpus renders a placeholder, not a bare header", () => {
  const { content, admitted, rendered } = renderMemoryIndex([], NOW);
  expect(admitted).toBe(0);
  expect(rendered).toBe(0);
  expect(content).toContain("_No notes have earned an index line yet._");
});

// --- rebuild + CLI -----------------------------------------------------------

test("rebuildMemoryIndex writes memory/INDEX.md and returns counts", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, note({ id: "earned", body: "b", trust: "principal", resurface_count: 3, last_verified: "2026-07-10" }));
    await seed(somaHome, note({ id: "quar", body: "x", trust: "quarantined", resurface_count: 9 }));

    const result = await rebuildMemoryIndex({ somaHome, now: NOW });

    expect(result.path).toBe(memoryIndexPath(somaHome));
    expect(result.rendered).toBe(1);
    expect(result.excluded).toBe(1);
    const onDisk = await readFile(result.path, "utf8");
    expect(onDisk).toBe(result.content);
    expect(onDisk).toContain("- earned —");
    expect(onDisk).not.toContain("quar");
  });
});

test("rebuildMemoryIndex is deterministic — same tree + same now → identical bytes", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, note({ id: "a", body: "aa", trust: "principal", resurface_count: 4, last_verified: "2026-07-01" }));
    await seed(somaHome, note({ id: "b", type: "procedural", body: "bb", trust: "principal", resurface_count: 2, last_verified: "2026-07-05" }));
    const first = await rebuildMemoryIndex({ somaHome, now: NOW });
    const second = await rebuildMemoryIndex({ somaHome, now: NOW });
    expect(second.content).toBe(first.content);
  });
});

test("runMemoryCli reindex reports the rebuild summary", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, note({ id: "earned", body: "b", trust: "principal", resurface_count: 3, last_verified: "2026-07-10" }));
    const out = await runMemoryCli(parseMemoryArgs(["memory", "reindex", "--soma-home", somaHome]));
    expect(out).toContain("Soma memory reindex");
    expect(out).toContain("rendered: 1 line(s)");
  });
});
