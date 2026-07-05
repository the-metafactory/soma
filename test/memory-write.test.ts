import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  MemoryNoteError,
  parseMemoryNote,
  somaMemoryEventsPath,
  verifyMemoryNote,
  writeMemoryNote,
  type SomaMemoryNote,
  type SomaMemoryWriteOptions,
} from "../src/index";
// Path/dedup/governance helpers are module-private (not public index API) — import direct.
import {
  MEMORY_DEDUP_JACCARD_THRESHOLD,
  collectDurableNotes,
  findDuplicateCandidates,
  memoryNotePath,
  resolveMutationGovernance,
  writeNotesAtomically,
  type AtomicNoteWrite,
} from "../src/memory-write";
import { parseMemoryArgs } from "../src/cli/memory";

const NOW = new Date("2026-07-03T10:00:00.000Z");
const LATER = new Date("2026-08-01T12:00:00.000Z");

async function withTempSoma<T>(fn: (somaHome: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soma-memwrite-"));
  const somaHome = join(dir, ".soma");
  try {
    return await fn(somaHome);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createOpts(somaHome: string, overrides: Partial<SomaMemoryWriteOptions> = {}): SomaMemoryWriteOptions {
  return {
    somaHome,
    now: NOW,
    mode: "create",
    trigger: "principal-correction",
    principalAuthority: true, // most tests exercise the principal path; the gate itself is tested separately
    id: "prefers-colon-over-emdash",
    type: "semantic",
    body: "Andreas reads em-dashes as an AI tell; use a colon or comma instead.",
    ...overrides,
  };
}

async function readNote(path: string): Promise<SomaMemoryNote> {
  return parseMemoryNote(await readFile(path, "utf8"));
}

async function countEvents(somaHome: string): Promise<number> {
  const content = await readFile(somaMemoryEventsPath(somaHome), "utf8").catch(() => "");
  return content.trim() === "" ? 0 : content.trim().split("\n").length;
}

/**
 * Force the next event append to fail: replace events.jsonl with a *directory*
 * so `appendFile` throws EISDIR (works even as root, unlike a chmod trick). Used
 * to prove the write→event rollback path.
 */
async function breakEvents(somaHome: string): Promise<void> {
  const path = somaMemoryEventsPath(somaHome);
  await rm(path, { force: true });
  await mkdir(path, { recursive: true });
}

test("create writes a semantic note with principal trust derived from the trigger", async () => {
  await withTempSoma(async (somaHome) => {
    const result = await writeMemoryNote(createOpts(somaHome));

    expect(result.mode).toBe("create");
    expect(result.path).toBe(memoryNotePath(somaHome, "semantic", "prefers-colon-over-emdash"));

    const note = await readNote(result.path);
    expect(note.id).toBe("prefers-colon-over-emdash");
    expect(note.type).toBe("semantic");
    expect(note.trust).toBe("principal");
    expect(note.provenance).toBe("conversation");
    expect(note.created).toBe("2026-07-03");
    expect(note.last_verified).toBe("2026-07-03");
    expect(note.valid_until).toBeNull();
    expect(note.resurface_count).toBe(0);
    expect(await countEvents(somaHome)).toBe(1);
  });
});

test("trust is derived from the trigger — no --trust flag can override it", async () => {
  await withTempSoma(async (somaHome) => {
    const principal = await writeMemoryNote(createOpts(somaHome, { id: "a" }));
    const imported = await writeMemoryNote(
      createOpts(somaHome, { id: "b", trigger: "import", body: "totally different imported fact about zeta", provenance: "tool:scraper" }),
    );
    const consolidated = await writeMemoryNote(
      createOpts(somaHome, { id: "c", trigger: "consolidation", consolidationAuthority: true, body: "consolidated abstraction over gamma delta epsilon" }),
    );

    expect(principal.note.trust).toBe("principal");
    expect(imported.note.trust).toBe("quarantined");
    expect(imported.note.provenance).toBe("tool:scraper");
    expect(consolidated.note.trust).toBe("assistant");
    expect(consolidated.note.provenance).toBe("consolidation");
  });
});

test("principal-correction without explicit authority is refused (no incidental principal trust)", async () => {
  await withTempSoma(async (somaHome) => {
    await expect(
      writeMemoryNote(createOpts(somaHome, { principalAuthority: false })),
    ).rejects.toThrow(/requires --principal-authority/);
    // The same write WITH authority succeeds and mints principal trust.
    const ok = await writeMemoryNote(createOpts(somaHome, { principalAuthority: true }));
    expect(ok.note.trust).toBe("principal");
  });
});

test("import needs no authority; consolidation needs consolidation-authority", async () => {
  await withTempSoma(async (somaHome) => {
    // import is the only trigger a bare caller can use — it lands quarantined.
    const imported = await writeMemoryNote(createOpts(somaHome, { id: "i", trigger: "import", principalAuthority: false, body: "imported fact alpha beta gamma" }));
    expect(imported.note.trust).toBe("quarantined");

    // consolidation without its authority is refused (can't self-select assistant trust).
    await expect(
      writeMemoryNote(createOpts(somaHome, { id: "c", trigger: "consolidation", principalAuthority: false, body: "consolidated fact delta epsilon" })),
    ).rejects.toThrow(/requires consolidation authority/);

    // With the capability it mints assistant trust.
    const consolidated = await writeMemoryNote(createOpts(somaHome, { id: "c", trigger: "consolidation", consolidationAuthority: true, body: "consolidated fact delta epsilon" }));
    expect(consolidated.note.trust).toBe("assistant");
  });
});

test("resolveMutationGovernance: a mint refusal and its audit-meta come from the SAME call (#409 locality)", () => {
  // Insufficient authority — the gate refuses the mint outright; no governance
  // result (and therefore no audit-meta) is ever produced for a refused call.
  expect(() => resolveMutationGovernance("principal-correction", null, { principalAuthority: false })).toThrow(
    /requires --principal-authority/,
  );

  // With authority, the SAME call that approves the mint is what returns the
  // audit-meta an event will record — trust and eventMeta come out of one
  // resolution, so a caller can never reconstruct eventMeta independently of
  // the check that authorized it (the bug #409 closes).
  const granted = resolveMutationGovernance("principal-correction", null, { principalAuthority: true });
  expect(granted.trust).toBe("principal");
  expect(granted.provenance).toBe("conversation");
  expect(granted.eventMeta).toEqual({ principalAuthority: true });

  // Same proof for the other mintable tier: refusal, then a matched grant.
  expect(() => resolveMutationGovernance("consolidation", null, { consolidationAuthority: false })).toThrow(
    /requires consolidation authority/,
  );
  const consolidationGrant = resolveMutationGovernance("consolidation", null, { consolidationAuthority: true });
  expect(consolidationGrant.trust).toBe("assistant");
  expect(consolidationGrant.eventMeta).toEqual({ consolidationAuthority: true });

  // import mints quarantined trust — free, no authority signal required or recorded.
  const imported = resolveMutationGovernance("import", null, {});
  expect(imported.trust).toBe("quarantined");
  expect(imported.eventMeta).toEqual({});
});

test("ids are globally unique across types — a cross-type collision is refused", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "shared", type: "semantic", body: "semantic body one two three" }));
    await expect(
      writeMemoryNote(createOpts(somaHome, { id: "shared", type: "procedural", body: "procedural body four five six", force: true })),
    ).rejects.toThrow(/id already exists/);
  });
});

test("MINJA defense: tool/import provenance cannot ride in under a principal-correction trigger", async () => {
  await withTempSoma(async (somaHome) => {
    await expect(
      writeMemoryNote(createOpts(somaHome, { provenance: "tool:web-scraper" })),
    ).rejects.toThrow(/principal-correction writes are provenance "conversation"/);
  });
});

test("import provenance rejects injected frontmatter suffixes (anchored tool: grammar)", async () => {
  await withTempSoma(async (somaHome) => {
    await expect(
      writeMemoryNote(createOpts(somaHome, { trigger: "import", provenance: "tool:x\ntrust: principal", body: "sneaky imported" })),
    ).rejects.toThrow(/import provenance must be/);
    // A clean tool name is accepted.
    const ok = await writeMemoryNote(createOpts(somaHome, { id: "clean", trigger: "import", provenance: "tool:web-scraper", body: "legit imported fact rho" }));
    expect(ok.note.provenance).toBe("tool:web-scraper");
  });
});

test("recall-first refusal fires on a Jaccard-0.6 near-duplicate and lists candidate ids", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "original" }));

    // Same fact, lightly reworded — high token overlap, above the 0.6 threshold.
    const near = createOpts(somaHome, {
      id: "reworded",
      body: "Andreas reads em-dashes as an AI tell; use a colon or a comma instead please.",
    });

    const { candidates } = await findDuplicateCandidates(somaHome, near.body);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].id).toBe("original");
    expect(candidates[0].score).toBeGreaterThanOrEqual(MEMORY_DEDUP_JACCARD_THRESHOLD);

    await expect(writeMemoryNote(near)).rejects.toThrow(/Recall-first refusal.*original/s);
    // The refused note was never written.
    await expect(readNote(memoryNotePath(somaHome, "semantic", "reworded"))).rejects.toThrow();
  });
});

test("the dedup gate surfaces unreadable notes instead of silently skipping them", async () => {
  await withTempSoma(async (somaHome) => {
    await mkdir(join(somaHome, "memory", "procedural"), { recursive: true });
    await writeFile(join(somaHome, "memory", "procedural", "corrupt.md"), "this is not a valid note", "utf8");

    const { unreadable } = await findDuplicateCandidates(somaHome, "some new body abc def");
    expect(unreadable.length).toBe(1);
    expect(unreadable[0]).toContain("corrupt.md");

    // The create still succeeds but records the blind spot in its event metadata.
    const result = await writeMemoryNote(createOpts(somaHome, { id: "fresh", body: "unrelated fresh body ghi jkl" }));
    expect(result.event.metadata?.dedupUnreadable).toBe(1);
  });
});

test("#408: a symlinked note in the durable corpus is never followed by collectDurableNotes (the closed no-check gap)", async () => {
  await withTempSoma(async (somaHome) => {
    // A note OUTSIDE the memory tree entirely, reachable only through a
    // symlink planted inside `semantic/`. Before #408, `collectDurableNotes`
    // had NO symlink guard at all (unlike consolidate's episodic walk in the
    // same pass) and would have read straight through it.
    const outside = join(somaHome, "..", "outside-secrets.md");
    await writeFile(
      outside,
      "---\nid: outside-secret\ntype: semantic\ncreated: 2026-01-01\nlast_verified: 2026-01-01\nvalid_until: null\nprovenance: conversation\ntrust: principal\nsource_of_truth: null\nproject: null\nlinks: []\nresurface_count: 0\n---\na secret note that must never surface from outside the memory root",
      "utf8",
    );
    await mkdir(join(somaHome, "memory", "semantic"), { recursive: true });
    await symlink(outside, join(somaHome, "memory", "semantic", "leak.md"));
    await writeMemoryNote(createOpts(somaHome, { id: "real-note", body: "a genuine durable note kept in the corpus" }));

    const { notes, unreadable } = await collectDurableNotes(somaHome);

    // Only the real note is visible; the symlinked one is silently invisible —
    // never read, never counted as a note, never reported as an unreadable
    // blind spot either (matching consolidate's silent-skip stance for
    // episodic notes, now applied symmetrically to the durable corpus).
    expect(notes.map((n) => n.note.id)).toEqual(["real-note"]);
    expect(unreadable).toEqual([]);

    // The dedup gate (this function's own caller) never sees the outside
    // content as a candidate either.
    const { candidates } = await findDuplicateCandidates(somaHome, "a secret note that must never surface from outside the memory root");
    expect(candidates).toEqual([]);
  });
});

test("--force overrides the recall-first refusal", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "original" }));
    const forced = await writeMemoryNote(
      createOpts(somaHome, { id: "reworded", body: "Andreas reads em-dashes as an AI tell; use a colon or a comma instead please.", force: true }),
    );
    expect(forced.note.id).toBe("reworded");
    expect(await countEvents(somaHome)).toBe(2);
  });
});

test("an exact-body duplicate is refused as an exact match", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "original" }));
    const { candidates } = await findDuplicateCandidates(somaHome, createOpts(somaHome).body);
    expect(candidates[0].exact).toBe(true);
    expect(candidates[0].score).toBe(1);
  });
});

test("a superseded note does not trigger the refusal gate (only active notes count)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "original" }));
    await writeMemoryNote(createOpts(somaHome, { mode: "supersede", id: "v2", targetId: "original", body: "reworded body about epsilon zeta" }));

    // The original is now closed; a note overlapping IT must not be refused.
    const { candidates } = await findDuplicateCandidates(somaHome, createOpts(somaHome).body);
    expect(candidates.find((c) => c.id === "original")).toBeUndefined();
  });
});

test("merge delta-appends an Update block and bumps last_verified without a new file", async () => {
  await withTempSoma(async (somaHome) => {
    const created = await writeMemoryNote(createOpts(somaHome, { id: "note" }));
    const merged = await writeMemoryNote({
      somaHome,
      now: LATER,
      mode: "merge",
      trigger: "principal-correction",
      principalAuthority: true,
      targetId: "note",
      body: "Also applies to en-dashes.",
    });

    expect(merged.path).toBe(created.path);
    const note = await readNote(merged.path);
    expect(note.body).toContain("**Update (2026-08-01):** Also applies to en-dashes.");
    expect(note.last_verified).toBe("2026-08-01");
    expect(note.created).toBe("2026-07-03"); // created is preserved
    expect(await countEvents(somaHome)).toBe(2); // one create, one merge
  });
});

test("merging into a principal-trust note requires the principal-authority escalation", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "principal-note" })); // trust principal

    // Lower-trust content (import) can't inject at all — the trust-rank gate.
    await expect(
      writeMemoryNote({ somaHome, mode: "merge", trigger: "import", targetId: "principal-note", body: "sneaky injected text", now: LATER }),
    ).rejects.toThrow(/Cannot mutate principal-trust note/);

    // A principal-correction merge WITHOUT authority is refused by the escalation gate.
    await expect(
      writeMemoryNote({ somaHome, mode: "merge", trigger: "principal-correction", targetId: "principal-note", body: "no authority", now: LATER }),
    ).rejects.toThrow(/requires --principal-authority/);

    // With the escalation it goes through.
    const ok = await writeMemoryNote({
      somaHome,
      mode: "merge",
      trigger: "principal-correction",
      principalAuthority: true,
      targetId: "principal-note",
      body: "legit correction",
      now: LATER,
    });
    expect(ok.note.body).toContain("legit correction");
  });
});

test("a lower-trust merge cannot inject into a higher-trust note (import into assistant)", async () => {
  await withTempSoma(async (somaHome) => {
    // assistant-trust note via consolidation trigger.
    await writeMemoryNote(createOpts(somaHome, { id: "assistant-note", trigger: "consolidation", consolidationAuthority: true, body: "assistant fact iota kappa" }));
    await expect(
      writeMemoryNote({ somaHome, mode: "merge", trigger: "import", targetId: "assistant-note", body: "imported injection", now: LATER }),
    ).rejects.toThrow(/Cannot mutate assistant-trust note .* with quarantined-trust content/);
  });
});

test("superseding (closing) a principal-trust note requires the escalation", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "trusted" }));
    await expect(
      writeMemoryNote(createOpts(somaHome, {
        mode: "supersede",
        id: "replacement",
        targetId: "trusted",
        trigger: "import",
        principalAuthority: false,
        body: "replacement via import trigger phi chi",
      })),
    ).rejects.toThrow(/Cannot mutate principal-trust note/);
  });
});

test("a malformed note file still blocks a cross-type id collision (presence, not parse)", async () => {
  await withTempSoma(async (somaHome) => {
    // Hand-write a corrupt semantic/dup.md (not parseable).
    await mkdir(join(somaHome, "memory", "semantic"), { recursive: true });
    await writeFile(join(somaHome, "memory", "semantic", "dup.md"), "not a valid note", "utf8");
    await expect(
      writeMemoryNote(createOpts(somaHome, { id: "dup", type: "procedural", body: "would collide omega", force: true })),
    ).rejects.toThrow(/id already exists/);
  });
});

test("merge into a superseded note is refused", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "old" }));
    await writeMemoryNote(createOpts(somaHome, { mode: "supersede", id: "new", targetId: "old", body: "different body kappa lambda mu" }));

    await expect(
      writeMemoryNote({ somaHome, mode: "merge", trigger: "principal-correction", targetId: "old", body: "x", now: NOW }),
    ).rejects.toThrow(/Cannot merge into superseded note old/);
  });
});

test("supersede closes the old note, cross-links, and mints the new one in one event", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "old-recipe" }));
    const result = await writeMemoryNote(
      createOpts(somaHome, { mode: "supersede", id: "new-recipe", targetId: "old-recipe", body: "the corrected recipe about pi rho sigma", now: LATER }),
    );

    expect(result.supersededId).toBe("old-recipe");
    const closed = await readNote(memoryNotePath(somaHome, "semantic", "old-recipe"));
    const fresh = await readNote(result.path);

    expect(closed.valid_until).toBe("2026-08-01");
    expect(closed.links).toContain("new-recipe");
    expect(fresh.valid_until).toBeNull();
    expect(fresh.links).toContain("old-recipe");
    expect(await countEvents(somaHome)).toBe(2); // create + supersede (one mutation → one event)
  });
});

test("superseding an assistant note with a principal replacement logs BOTH authorities", async () => {
  await withTempSoma(async (somaHome) => {
    // assistant note (needs consolidation authority to mint).
    await writeMemoryNote(createOpts(somaHome, { id: "asst", trigger: "consolidation", consolidationAuthority: true, body: "assistant fact to be replaced" }));
    // Replace it with a principal note — closing the assistant needs consolidation
    // authority, minting the principal needs principal authority: both required.
    const result = await writeMemoryNote(
      createOpts(somaHome, {
        mode: "supersede",
        id: "principal-repl",
        targetId: "asst",
        trigger: "principal-correction",
        principalAuthority: true,
        consolidationAuthority: true,
        body: "the principal correction body chi psi",
        now: LATER,
      }),
    );
    // The journal proves both escalations were present.
    expect(result.event.metadata?.principalAuthority).toBe(true);
    expect(result.event.metadata?.consolidationAuthority).toBe(true);
  });
});

test("a note cannot supersede itself", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "self" }));
    await expect(
      writeMemoryNote(createOpts(somaHome, { mode: "supersede", id: "self", targetId: "self", body: "x" })),
    ).rejects.toThrow(/cannot supersede itself/);
  });
});

test("verify bumps last_verified and increments resurface_count with one event", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "note" })); // principal
    const result = await verifyMemoryNote({ somaHome, id: "note", principalAuthority: true, now: LATER });

    expect(result.note.last_verified).toBe("2026-08-01");
    expect(result.note.resurface_count).toBe(1);

    const persisted = await readNote(result.path);
    expect(persisted.resurface_count).toBe(1);
    expect(await countEvents(somaHome)).toBe(2); // create + verify

    const again = await verifyMemoryNote({ somaHome, id: "note", principalAuthority: true, now: LATER });
    expect(again.note.resurface_count).toBe(2);
  });
});

test("verifying a principal note needs authority; a quarantined note does not", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "trusted" })); // principal
    await expect(verifyMemoryNote({ somaHome, id: "trusted", now: LATER })).rejects.toThrow(/requires --principal-authority/);

    await writeMemoryNote(createOpts(somaHome, { id: "imported", trigger: "import", principalAuthority: false, body: "imported fact mu nu xi" }));
    const ok = await verifyMemoryNote({ somaHome, id: "imported", now: LATER }); // no authority needed
    expect(ok.note.resurface_count).toBe(1);
  });
});

test("verify on a missing id throws a typed error", async () => {
  await withTempSoma(async (somaHome) => {
    await expect(verifyMemoryNote({ somaHome, id: "ghost" })).rejects.toThrow(MemoryNoteError);
  });
});

test("a mis-filed note (frontmatter id != filename) is refused, not silently retargeted", async () => {
  await withTempSoma(async (somaHome) => {
    // Write a valid note, then rename its FILE so the path stem no longer matches
    // its frontmatter id.
    const created = await writeMemoryNote(createOpts(somaHome, { id: "correct-id", body: "body for misfile test" }));
    const raw = await readFile(created.path, "utf8");
    await writeFile(join(somaHome, "memory", "semantic", "wrong-name.md"), raw, "utf8");
    await expect(verifyMemoryNote({ somaHome, id: "wrong-name", principalAuthority: true, now: LATER })).rejects.toThrow(/mismatched frontmatter/);
  });
});

test("verifying a superseded (closed) note is refused", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "old" }));
    await writeMemoryNote(createOpts(somaHome, { mode: "supersede", id: "new", targetId: "old", body: "replacement body upsilon phi" }));
    await expect(verifyMemoryNote({ somaHome, id: "old", principalAuthority: true, now: LATER })).rejects.toThrow(/Cannot verify superseded note/);
  });
});

test("verifying an assistant note needs consolidation-authority", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "asst", trigger: "consolidation", consolidationAuthority: true, body: "assistant fact for verify pi rho" }));
    await expect(verifyMemoryNote({ somaHome, id: "asst", now: LATER })).rejects.toThrow(/requires consolidation authority/);
    const ok = await verifyMemoryNote({ somaHome, id: "asst", consolidationAuthority: true, now: LATER });
    expect(ok.note.resurface_count).toBe(1);
  });
});

test("merge rejects a --provenance flag (merge preserves the target's provenance)", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "note" }));
    await expect(
      writeMemoryNote({ somaHome, mode: "merge", trigger: "principal-correction", principalAuthority: true, targetId: "note", body: "x", provenance: "tool:web", now: LATER }),
    ).rejects.toThrow(/--provenance is not valid with --merge/);
  });
});

test("a symlink note path is refused rather than followed out of the tree", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "real", body: "real body sigma tau" }));
    // Plant a symlink at procedural/evil.md → outside the memory tree.
    const outside = join(somaHome, "..", "outside-target.md");
    await writeFile(outside, "---\nnot: a note\n", "utf8");
    await mkdir(join(somaHome, "memory", "procedural"), { recursive: true });
    await symlink(outside, join(somaHome, "memory", "procedural", "evil.md"));

    await expect(verifyMemoryNote({ somaHome, id: "evil", now: LATER })).rejects.toThrow(/is a symlink/);
  });
});

test("a symlinked parent directory can't redirect a write out of the tree", async () => {
  await withTempSoma(async (somaHome) => {
    // Point memory/semantic at a dir OUTSIDE the memory tree.
    const outsideDir = join(somaHome, "..", "escape-dir");
    await mkdir(outsideDir, { recursive: true });
    await mkdir(join(somaHome, "memory"), { recursive: true });
    await symlink(outsideDir, join(somaHome, "memory", "semantic"));

    await expect(
      writeMemoryNote(createOpts(somaHome, { id: "victim", type: "semantic", body: "would escape via parent symlink" })),
    ).rejects.toThrow(/resolves outside the memory tree/);
  });
});

test("CLI rejects the consolidation trigger (SDK-only) and merge --id/--type", () => {
  expect(() => parseMemoryArgs(["memory", "write", "--trigger", "consolidation", "--body", "x", "--id", "a", "--type", "semantic"])).toThrow(
    /consolidation is an internal .* SDK path/,
  );
  expect(() => parseMemoryArgs(["memory", "write", "--trigger", "principal-correction", "--merge", "t", "--body", "x", "--id", "a"])).toThrow(
    /--merge takes neither --id nor --type/,
  );
});

test("verify CLI rejects a conflicting positional id and --id", () => {
  expect(() => parseMemoryArgs(["memory", "verify", "old", "--id", "new"])).toThrow(/two different ids/);
  // Matching positional + --id is fine.
  const parsed = parseMemoryArgs(["memory", "verify", "same", "--id", "same"]);
  expect(parsed.action).toBe("verify");
});

test("episodic writes are refused through the write path (they belong to M5)", async () => {
  await withTempSoma(async (somaHome) => {
    await expect(
      // episodic is a valid note type but not a valid *write* target — the runtime guard refuses it.
      writeMemoryNote(createOpts(somaHome, { type: "episodic" })),
    ).rejects.toThrow(/must be "semantic" or "procedural"/);
  });
});

test("creating a note whose id already exists is refused", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "dup", body: "first body alpha beta" }));
    await expect(
      writeMemoryNote(createOpts(somaHome, { id: "dup", body: "unrelated body chi psi omega", force: true })),
    ).rejects.toThrow(/already exists/);
  });
});

test("a path-traversal id is refused at the write boundary", async () => {
  await withTempSoma(async (somaHome) => {
    await expect(writeMemoryNote(createOpts(somaHome, { id: "../../evil" }))).rejects.toThrow(/not a valid slug/);
    await expect(writeMemoryNote(createOpts(somaHome, { id: "Bad_Id" }))).rejects.toThrow(/not a valid slug/);
  });
});

test("create rolls back the new file when the event append fails (one-event invariant)", async () => {
  await withTempSoma(async (somaHome) => {
    await breakEvents(somaHome);
    await expect(writeMemoryNote(createOpts(somaHome, { id: "note" }))).rejects.toThrow();
    // The file mutation was rolled back — nothing left behind.
    await expect(readNote(memoryNotePath(somaHome, "semantic", "note"))).rejects.toThrow();
  });
});

test("merge rolls back to the prior bytes when the event append fails", async () => {
  await withTempSoma(async (somaHome) => {
    const created = await writeMemoryNote(createOpts(somaHome, { id: "note" }));
    const priorRaw = await readFile(created.path, "utf8");
    await breakEvents(somaHome);

    await expect(
      writeMemoryNote({ somaHome, mode: "merge", trigger: "principal-correction", principalAuthority: true, targetId: "note", body: "delta", now: LATER }),
    ).rejects.toThrow();

    // Restored byte-for-byte: no Update block, no last_verified bump.
    expect(await readFile(created.path, "utf8")).toBe(priorRaw);
  });
});

test("verify rolls back when the event append fails", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "note" }));
    await breakEvents(somaHome);

    await expect(verifyMemoryNote({ somaHome, id: "note", principalAuthority: true, now: LATER })).rejects.toThrow();
    const note = await readNote(memoryNotePath(somaHome, "semantic", "note"));
    expect(note.resurface_count).toBe(0); // the bump was rolled back
  });
});

test("supersede rolls back both sides when the event append fails", async () => {
  await withTempSoma(async (somaHome) => {
    await writeMemoryNote(createOpts(somaHome, { id: "old" }));
    await breakEvents(somaHome);

    await expect(
      writeMemoryNote(createOpts(somaHome, { mode: "supersede", id: "new", targetId: "old", body: "replacement body tau upsilon" })),
    ).rejects.toThrow();

    // Old note reopened (still active), new note never persisted.
    const old = await readNote(memoryNotePath(somaHome, "semantic", "old"));
    expect(old.valid_until).toBeNull();
    expect(old.links).not.toContain("new");
    await expect(readNote(memoryNotePath(somaHome, "semantic", "new"))).rejects.toThrow();
  });
});

// --- #412: one atomicity contract, one error shape for staged note writes ---

function rawNote(overrides: Partial<SomaMemoryNote> & { id: string; body: string }): SomaMemoryNote {
  return {
    type: "semantic",
    created: "2026-07-03",
    last_verified: "2026-07-03",
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

test("writeNotesAtomically: a mid-write failure rolls back every staged write with the SAME error shape as an event-append failure (#412)", async () => {
  await withTempSoma(async (somaHome) => {
    await mkdir(join(somaHome, "memory/semantic"), { recursive: true });
    // Mirrors supersedeNote's own write shape: a "wx" create followed by a "w"
    // overwrite — the exact two-write staging supersede routes through this
    // primitive for.
    const firstPath = memoryNotePath(somaHome, "semantic", "atomic-first");
    const secondPath = memoryNotePath(somaHome, "semantic", "atomic-second");
    const priorRaw = "restored-content-from-rollback\n";
    await writeFile(secondPath, "current-content-before-the-call\n", "utf8");

    const writes: AtomicNoteWrite[] = [
      { path: firstPath, flag: "wx", note: rawNote({ id: "atomic-first", body: "first note body alpha beta" }) },
      {
        path: secondPath,
        flag: "w",
        // An embedded newline in `hook` breaks the round-trip law (memory-note.ts's
        // serializeMemoryNote re-parses and compares) — `writeNoteFile` throws
        // BEFORE any byte of this write hits disk, forcing a mid-write failure
        // deterministically and without needing root-unsafe permission tricks.
        note: rawNote({ id: "atomic-second", body: "second note body gamma delta", hook: "line one\nline two" }),
        priorRaw,
      },
    ];

    let thrown: unknown;
    try {
      await writeNotesAtomically(somaHome, NOW, undefined, "test.atomic-write", writes, {
        summary: "atomic write test",
        artifactPaths: [firstPath, secondPath],
        metadata: {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    // Same shape as the append-failure rollback (`rolled back the file mutation`,
    // a plain Error with `cause`) — NOT the AggregateError supersedeNote used to
    // hand-roll for this exact failure window.
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(error.message).toBe("Soma memory test.atomic-write write failed; rolled back the file mutation.");
    expect(error.cause).toBeDefined();

    // Every staged write was rolled back: the first write's file is gone...
    await expect(readNote(firstPath)).rejects.toThrow();
    // ...and the second write's target was restored to the caller-supplied prior
    // bytes (proving the rollback actually ran, not merely that nothing changed).
    expect(await readFile(secondPath, "utf8")).toBe(priorRaw);
  });
});

test("writeNotesAtomically: a failure on a first CREATE (wx) propagates un-rolled-back and un-wrapped (EEXIST left the target untouched)", async () => {
  await withTempSoma(async (somaHome) => {
    await mkdir(join(somaHome, "memory/semantic"), { recursive: true });
    const firstPath = memoryNotePath(somaHome, "semantic", "atomic-only");
    const writes: AtomicNoteWrite[] = [
      { path: firstPath, flag: "wx", note: rawNote({ id: "atomic-only", body: "body", hook: "line one\nline two" }) },
    ];

    await expect(
      writeNotesAtomically(somaHome, NOW, undefined, "test.atomic-write", writes, {
        summary: "atomic write test",
        artifactPaths: [firstPath],
        metadata: {},
      }),
    ).rejects.toThrow(/malformed frontmatter line/);
  });
});

test("writeNotesAtomically: a failure on a first OVERWRITE (w) rolls back to prior bytes with the shared error shape (#412 review)", async () => {
  await withTempSoma(async (somaHome) => {
    await mkdir(join(somaHome, "memory/semantic"), { recursive: true });
    // A single "w" overwrite (the shape merge/verify route through). An
    // overwrite can truncate its target before failing, so a first-write
    // failure must still restore the caller's prior bytes — NOT propagate raw.
    const onlyPath = memoryNotePath(somaHome, "semantic", "overwrite-only");
    const priorRaw = "trusted-prior-bytes-that-must-survive\n";
    await writeFile(onlyPath, priorRaw, "utf8");
    const writes: AtomicNoteWrite[] = [
      {
        path: onlyPath,
        flag: "w",
        // Embedded newline in `hook` breaks the round-trip law → writeNoteFile
        // throws, deterministically forcing the first-write failure.
        note: rawNote({ id: "overwrite-only", body: "new body that never lands", hook: "line one\nline two" }),
        priorRaw,
      },
    ];

    let thrown: unknown;
    try {
      await writeNotesAtomically(somaHome, NOW, undefined, "test.atomic-write", writes, {
        summary: "atomic write test",
        artifactPaths: [onlyPath],
        metadata: {},
      });
    } catch (error) {
      thrown = error;
    }

    // Wrapped shared shape, not a raw round-trip error nor an AggregateError.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(AggregateError);
    expect((thrown as Error).message).toBe("Soma memory test.atomic-write write failed; rolled back the file mutation.");
    // Prior bytes restored (rollback ran even though it was the first write).
    expect(await readFile(onlyPath, "utf8")).toBe(priorRaw);
  });
});
