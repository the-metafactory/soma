import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { recallMemory, serializeMemoryNote, type SomaMemoryNote } from "../src/index";
import { memoryNotePath, type WritableType } from "../src/memory-write";
import { parseMemoryArgs, runMemoryCli } from "../src/cli/memory";

const NOW = new Date("2026-07-11T10:00:00.000Z");

async function withTempSoma<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-recall-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Seed a note file directly (bypassing the write governance) for precise control
 * over the retrieval-relevant fields the write path derives from a clock/trigger. */
async function seed(somaHome: string, overrides: Partial<SomaMemoryNote> & { id: string; body: string }): Promise<void> {
  const note: SomaMemoryNote = {
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
  const path = memoryNotePath(somaHome, note.type as WritableType, note.id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeMemoryNote(note), "utf8");
}

test("term-scored whole-file match with a verification banner whose age derives from injected now", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, {
      id: "prefers-colon-over-emdash",
      body: "Andreas reads em-dashes as an AI tell; use a colon instead.",
      source_of_truth: "CONTEXT.md",
    });

    const result = await recallMemory({ somaHome, query: "em-dashes colon", now: NOW });

    expect(result.terms).toEqual(["dashes", "colon"]);
    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(match.id).toBe("prefers-colon-over-emdash");
    expect(match.via).toBe("match");
    expect(match.score).toBe(2);
    // whole-file retrieval: the complete body, not a snippet
    expect(match.note.body).toBe("Andreas reads em-dashes as an AI tell; use a colon instead.");
    // 2026-07-01 → 2026-07-11 = 10 days
    expect(match.ageDays).toBe(10);
    expect(match.banner).toBe("⚠ 10d old · principal · conversation · verify against CONTEXT.md");
    expect(match.quarantined).toBe(false);
  });
});

test("superseded notes are never returned (valid_until set)", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, { id: "active-fact", body: "widget tolerance is 5mm" });
    await seed(somaHome, { id: "old-fact", body: "widget tolerance is 3mm", valid_until: "2026-07-05" });

    const result = await recallMemory({ somaHome, query: "widget tolerance", now: NOW });

    expect(result.matches.map((m) => m.id)).toEqual(["active-fact"]);
  });
});

test("quarantined notes carry the untrusted-content warning", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, {
      id: "imported-claim",
      body: "the vault endpoint rotates keys hourly",
      trust: "quarantined",
      provenance: "tool:web",
    });

    const result = await recallMemory({ somaHome, query: "vault endpoint keys", now: NOW });

    expect(result.matches).toHaveLength(1);
    const [match] = result.matches;
    expect(match.quarantined).toBe(true);
    expect(match.banner).toBe("⚠ QUARANTINED (untrusted) · 10d old · quarantined · tool:web · verify against no recorded source");
  });
});

test("term scoring ranks by distinct matches then frequency; limit caps the primary set", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, { id: "note-three-terms", body: "alpha beta gamma appear together" });
    await seed(somaHome, { id: "note-two-terms", body: "alpha beta only here" });
    await seed(somaHome, { id: "note-one-term-freq", body: "alpha alpha alpha repeated" });
    await seed(somaHome, { id: "note-one-term", body: "alpha once" });
    await seed(somaHome, { id: "note-nomatch", body: "delta epsilon" });

    const result = await recallMemory({ somaHome, query: "alpha beta gamma", now: NOW, limit: 3 });

    // top 3 by (distinct terms desc, freq desc): 3-terms, 2-terms, then the higher-freq 1-term
    expect(result.matches.map((m) => m.id)).toEqual(["note-three-terms", "note-two-terms", "note-one-term-freq"]);
    expect(result.matches.map((m) => m.score)).toEqual([3, 2, 1]);
  });
});

test("1-hop link expansion pulls active linked notes and surfaces superseded/missing link targets", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, {
      id: "hub-note",
      body: "primary match about deployment",
      links: ["context-note", "closed-note", "ghost-note"],
    });
    await seed(somaHome, { id: "context-note", body: "supporting detail with no query terms" });
    await seed(somaHome, { id: "closed-note", body: "old detail", valid_until: "2026-07-02" });
    // ghost-note is never created

    const result = await recallMemory({ somaHome, query: "deployment", now: NOW });

    const hub = result.matches.find((m) => m.id === "hub-note");
    const linked = result.matches.find((m) => m.id === "context-note");
    expect(hub?.via).toBe("match");
    expect(linked?.via).toBe("link");
    expect(linked?.linkedFrom).toBe("hub-note");
    expect(linked?.score).toBe(0);
    // the closed and missing link targets are surfaced, not silently dropped
    expect(result.unresolvedLinks.sort()).toEqual(["closed-note", "ghost-note"]);
  });
});

test("a future last_verified clamps the banner age to 0d", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, { id: "fresh-note", body: "recently verified widget", last_verified: "2026-08-01" });

    const result = await recallMemory({ somaHome, query: "widget", now: NOW });

    expect(result.matches[0].ageDays).toBe(0);
    expect(result.matches[0].banner).toBe("⚠ 0d old · principal · conversation · verify against no recorded source");
  });
});

test("a query of only sub-3-char tokens matches nothing (no terms scored)", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, { id: "some-note", body: "a bc de fg" });

    const result = await recallMemory({ somaHome, query: "a bc de", now: NOW });

    expect(result.terms).toEqual([]);
    expect(result.matches).toEqual([]);
  });
});

test("an unreadable corpus file is surfaced, never silently dropped", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, { id: "good-note", body: "alpha content" });
    const badPath = memoryNotePath(somaHome, "semantic", "broken-note");
    await mkdir(dirname(badPath), { recursive: true });
    await writeFile(badPath, "this is not a valid note frontmatter", "utf8");

    const result = await recallMemory({ somaHome, query: "alpha", now: NOW });

    expect(result.matches.map((m) => m.id)).toEqual(["good-note"]);
    expect(result.unreadable).toEqual([badPath]);
  });
});

test("recall matches across semantic and procedural dirs", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, { id: "semantic-fact", type: "semantic", body: "gateway retries thrice" });
    await seed(somaHome, { id: "procedural-step", type: "procedural", body: "gateway restart procedure" });

    const result = await recallMemory({ somaHome, query: "gateway", now: NOW });

    expect(result.matches.map((m) => m.id).sort()).toEqual(["procedural-step", "semantic-fact"]);
  });
});

test("recallMemory rejects a non-positive or non-integer limit at the API boundary", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, { id: "note", body: "alpha content" });
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      await expect(recallMemory({ somaHome, query: "alpha", now: NOW, limit: bad })).rejects.toThrow(
        /positive integer/,
      );
    }
  });
});

// --- CLI surface -------------------------------------------------------------

test("parseMemoryArgs accepts recall with a positional query and --limit", () => {
  const parsed = parseMemoryArgs(["memory", "recall", "deployment keys", "--limit", "5"]);
  expect(parsed).toEqual({
    command: "memory",
    action: "recall",
    options: { query: "deployment keys", limit: 5 },
  });
});

test("parseMemoryArgs rejects recall with no query", () => {
  expect(() => parseMemoryArgs(["memory", "recall"])).toThrow(/needs a query/);
});

test("parseMemoryArgs rejects a non-positive --limit on recall", () => {
  expect(() => parseMemoryArgs(["memory", "recall", "q", "--limit", "0"])).toThrow(/positive integer/);
});

test("parseMemoryArgs rejects fractional / non-numeric --limit (strict integer)", () => {
  // Number(...) rejects any spelling that isn't an integer value — the parseInt
  // bug was silently truncating "2.5"→2. Genuine integer spellings like "1e2"
  // (=100) resolve to their true value and are accepted; the point is that a
  // fractional or garbage limit is refused, not narrowed.
  for (const bad of ["2.5", "3.0abc", "abc"]) {
    expect(() => parseMemoryArgs(["memory", "recall", "q", "--limit", bad])).toThrow(/positive integer/);
  }
  // "1e2" is a valid integer (100) under Number — accepted, not truncated to 1.
  expect(parseMemoryArgs(["memory", "recall", "q", "--limit", "1e2"])).toEqual({
    command: "memory",
    action: "recall",
    options: { query: "q", limit: 100 },
  });
  // and the same contract holds for the sibling `search` command (shared parser)
  expect(() => parseMemoryArgs(["memory", "search", "q", "--limit", "2.5"])).toThrow(/positive integer/);
});

test("runMemoryCli strips ANSI/control escapes from note-authored output", async () => {
  await withTempSoma(async (somaHome) => {
    // A quarantined note whose body smuggles a CSI color escape and a BEL.
    await seed(somaHome, {
      id: "malicious-import",
      trust: "quarantined",
      provenance: "tool:web",
      body: "Alert \x1b[31mRED\x1b[0m gateway \x07 done",
    });
    const out = await runMemoryCli(parseMemoryArgs(["memory", "recall", "gateway", "--soma-home", somaHome]));
    // no raw ESC or BEL survives to the terminal
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    // the visible text is preserved (escapes removed, letters kept)
    expect(out).toContain("Alert RED gateway  done");
  });
});

test("runMemoryCli renders a recall result with banner and body", async () => {
  await withTempSoma(async (somaHome) => {
    await seed(somaHome, { id: "cli-note", body: "gateway retries thrice", source_of_truth: "runbook.md" });
    const out = await runMemoryCli(
      parseMemoryArgs(["memory", "recall", "gateway", "--soma-home", somaHome]),
    );
    expect(out).toContain("Soma memory recall");
    expect(out).toContain("━━ cli-note [semantic]");
    expect(out).toContain("verify against runbook.md");
    expect(out).toContain("gateway retries thrice");
  });
});
