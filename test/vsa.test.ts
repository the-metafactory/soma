import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  bootstrapSomaHome,
  checkCompleteness,
  getActiveVsa,
  getCriteria,
  getGoal,
  listAvailableTiers,
  listVsas,
  readVsa,
  recordVsaDecision,
  scaffoldVsa,
  setActiveVsa,
  writeVsa,
  somaMemoryEventsPath,
} from "../src/index";
// Path helpers are intentionally internal (#34 Sage round-2 finding) —
// tests import them directly from the implementation module.
import { activeStatePath, vsaPath } from "../src/vsa";
import { parseVsa, serializeVsa } from "../src/vsa-parse";

async function withSomaHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-vsa-lib-"));
  try {
    await bootstrapSomaHome({ homeDir });
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function readEvents(homeDir: string): Promise<{ kind: string; metadata?: Record<string, unknown> }[]> {
  const path = somaMemoryEventsPath(join(homeDir, ".soma"));
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as { kind: string; metadata?: Record<string, unknown> });
}

test("AC-1: library exports the seven core functions", () => {
  expect(typeof readVsa).toBe("function");
  expect(typeof writeVsa).toBe("function");
  expect(typeof listVsas).toBe("function");
  expect(typeof scaffoldVsa).toBe("function");
  expect(typeof checkCompleteness).toBe("function");
  expect(typeof setActiveVsa).toBe("function");
  expect(typeof getActiveVsa).toBe("function");
});

test("AC-7 Anti: reconcileVsa is NOT exported from the library", () => {
  // Import the namespace object and assert reconcileVsa is absent
  // (it lives in deferred issue #35 only).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lib = require("../src/vsa") as Record<string, unknown>;
  expect(lib.reconcileVsa).toBeUndefined();
});

test("scaffoldVsa produces an VSA that passes checkCompleteness at the same tier", async () => {
  await withSomaHome(async (homeDir) => {
    for (const tier of listAvailableTiers()) {
      const slug = `scaffold-${tier.toLowerCase()}`;
      await scaffoldVsa({
        homeDir,
        slug,
        goal: `Demo goal for ${tier}`,
        effort: tier,
        timestamp: "2026-05-17T00:00:00.000Z",
        initialCriteria: [{ id: "C1", text: "Demo criterion", status: "open" }],
      });
      const report = await checkCompleteness(slug, { homeDir });
      expect(report.passed).toBe(true);
      expect(report.tier).toBe(tier);
      expect(report.gaps).toHaveLength(0);
    }
  });
});

test("readVsa returns parsed VerificationStateArtifact with sourcePath", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "demo", goal: "Test goal", effort: "E1" });
    const isa = await readVsa("demo", { homeDir });
    expect(isa.slug).toBe("demo");
    expect(getGoal(isa)).toBe("Test goal");
    expect(isa.sourcePath).toContain("/isa/demo.md");
  });
});

test("writeVsa returns changed=false when content is byte-equivalent", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "demo", goal: "Test goal", effort: "E1" });
    const isa = await readVsa("demo", { homeDir });
    const result = await writeVsa("demo", isa, { homeDir });
    expect(result.changed).toBe(false);
  });
});

test("writeVsa returns changed=true after structural mutation", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "demo", goal: "Test goal", effort: "E1" });
    const isa = await readVsa("demo", { homeDir });
    const mutated = {
      ...isa,
      sections: [...isa.sections, { name: "Extra", content: "extra body" }],
    };
    const result = await writeVsa("demo", mutated, { homeDir });
    expect(result.changed).toBe(true);
  });
});

test("AC-6: writeVsa serializes to semantic-equivalent content on round-trip", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({
      homeDir,
      slug: "rtrip",
      goal: "Round-trip goal",
      effort: "E2",
      initialCriteria: [
        { id: "C1", text: "First", status: "passed", verification: "evidence" },
        { id: "C2", text: "Second", status: "open" },
      ],
    });
    const original = await readFile(join(homeDir, ".soma", "isa", "rtrip.md"), "utf8");
    const reparsed = parseVsa(original);
    const reserialized = serializeVsa(reparsed);
    // Same identity: raw input WeakMap hit
    expect(reserialized).toBe(original);
    // After parse → access → serialize, derived fields match
    const isa = await readVsa("rtrip", { homeDir });
    expect(getCriteria(isa)).toHaveLength(2);
    expect(getCriteria(isa)[0]?.status).toBe("passed");
  });
});

test("listVsas surfaces per-file read errors with slug/path context", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "good", goal: "G", effort: "E1" });
    // Plant an unreadable .md file by removing read permission.
    const { writeFile: wf, chmod: ch } = await import("node:fs/promises");
    const unreadable = join(homeDir, ".soma", "isa", "unreadable.md");
    await wf(unreadable, "---\ntask: x\neffort: E1\nphase: observe\n---\n\n## Goal\n\nx\n", "utf8");
    await ch(unreadable, 0o000);
    try {
      await expect(listVsas({ homeDir })).rejects.toThrow(/unreadable/);
    } finally {
      // Restore so afterAll cleanup can rm the file
      await ch(unreadable, 0o644).catch(() => undefined);
    }
  });
});

test("listVsas surfaces real filesystem errors (not silent empty list)", async () => {
  // Replace the isa dir with a regular file → readdir throws ENOTDIR. Must
  // propagate, not silently return [].
  const homeDir = await mkdtemp(join(tmpdir(), "soma-vsa-list-err-"));
  try {
    await bootstrapSomaHome({ homeDir });
    const { rm: rmf, writeFile: wf } = await import("node:fs/promises");
    await rmf(join(homeDir, ".soma", "isa"), { recursive: true, force: true });
    await wf(join(homeDir, ".soma", "isa"), "not a directory", "utf8");
    await expect(listVsas({ homeDir })).rejects.toThrow();
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("listVsas returns [] for missing isa dir (ENOENT only)", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-vsa-noenoent-"));
  try {
    // Don't bootstrap — isa dir doesn't exist at all
    const entries = await listVsas({ homeDir });
    expect(entries).toEqual([]);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("listVsas returns entries sorted by updated desc, ignoring INDEX.md", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({
      homeDir, slug: "alpha", goal: "G", effort: "E1", timestamp: "2026-05-01T00:00:00.000Z",
    });
    await scaffoldVsa({
      homeDir, slug: "bravo", goal: "G", effort: "E1", timestamp: "2026-05-17T00:00:00.000Z",
    });
    const entries = await listVsas({ homeDir });
    expect(entries.map((e) => e.slug)).toEqual(["bravo", "alpha"]);
    expect(entries[0]?.phase).toBe("observe");
  });
});

test("AC-4: setActiveVsa writes active.json atomically and returns previous", async () => {
  await withSomaHome(async (homeDir) => {
    expect(await getActiveVsa({ homeDir })).toBeNull();
    const first = await setActiveVsa("demo", { homeDir, runId: "run-1", timestamp: "2026-05-17T00:00:00.000Z" });
    expect(first.previousSlug).toBeNull();
    expect(first.state.activeSlug).toBe("demo");
    expect(first.state.runId).toBe("run-1");

    const stateOnDisk = JSON.parse(await readFile(activeStatePath(join(homeDir, ".soma")), "utf8"));
    expect(stateOnDisk.activeSlug).toBe("demo");

    const second = await setActiveVsa("other", { homeDir, timestamp: "2026-05-17T01:00:00.000Z" });
    expect(second.previousSlug).toBe("demo");

    const cleared = await setActiveVsa(null, { homeDir, timestamp: "2026-05-17T02:00:00.000Z" });
    expect(cleared.previousSlug).toBe("other");
    expect(cleared.state.activeSlug).toBeNull();
  });
});

test("getActiveVsa returns null for missing or malformed active.json", async () => {
  await withSomaHome(async (homeDir) => {
    expect(await getActiveVsa({ homeDir })).toBeNull();
    // Write malformed content
    const path = activeStatePath(join(homeDir, ".soma"));
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(homeDir, ".soma", "memory", "STATE"), { recursive: true });
    await wf(path, "not json", "utf8");
    expect(await getActiveVsa({ homeDir })).toBeNull();
    // Write valid JSON but wrong shape
    await wf(path, JSON.stringify({ foo: "bar" }), "utf8");
    expect(await getActiveVsa({ homeDir })).toBeNull();
  });
});

test("AC-5: every mutation appends a structured event to events.jsonl", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "ev", goal: "G", effort: "E1" });
    const isa = await readVsa("ev", { homeDir });
    await writeVsa("ev", { ...isa, sections: [...isa.sections, { name: "Extra", content: "x" }] }, { homeDir });
    await setActiveVsa("ev", { homeDir });
    await recordVsaDecision("ev", "Test decision", { homeDir });

    const events = await readEvents(homeDir);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("isa.scaffold");
    expect(kinds).toContain("isa.write");
    expect(kinds).toContain("isa.active_changed");
  });
});

test("scaffoldVsa rejects invalid slug / empty goal / unknown tier", async () => {
  await withSomaHome(async (homeDir) => {
    await expect(scaffoldVsa({ homeDir, slug: "Bad Slug", goal: "g", effort: "E1" })).rejects.toThrow("Invalid VSA slug");
    await expect(scaffoldVsa({ homeDir, slug: "good", goal: "   ", effort: "E1" })).rejects.toThrow("non-empty goal");
    await expect(
      scaffoldVsa({ homeDir, slug: "good", goal: "g", effort: "E9" as unknown as "E1" }),
    ).rejects.toThrow("Invalid effort tier");
  });
});

test("writeVsa rejects unsafe slugs", async () => {
  await withSomaHome(async (homeDir) => {
    const sample = await scaffoldVsa({ homeDir, slug: "ok", goal: "g", effort: "E1" });
    expect(() => vsaPath(join(homeDir, ".soma"), "../etc/passwd")).toThrow("Invalid VSA slug");
    expect(() => vsaPath(join(homeDir, ".soma"), "Bad Slug")).toThrow("Invalid VSA slug");
    void sample;
  });
});

test("checkCompleteness reports gaps for tier-required sections that are missing", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "incomplete", goal: "G", effort: "E3" });
    // Manually remove the Vision section to introduce a gap. (Serialize drops
    // empty sections, so on round-trip an empty section becomes "missing".)
    const isa = await readVsa("incomplete", { homeDir });
    const cleared = { ...isa, sections: isa.sections.filter((s) => s.name !== "Vision") };
    await writeVsa("incomplete", cleared, { homeDir });
    const report = await checkCompleteness("incomplete", { homeDir });
    expect(report.passed).toBe(false);
    expect(report.gaps.some((g) => g.section === "Vision" && g.reason === "missing")).toBe(true);
  });
});

test("recordVsaDecision appends to Decisions section and updates timestamp", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "dec", goal: "G", effort: "E4", timestamp: "2026-05-17T00:00:00.000Z" });
    await recordVsaDecision("dec", "Chose path A", { homeDir, timestamp: "2026-05-17T10:00:00.000Z" });
    const isa = await readVsa("dec", { homeDir });
    expect(isa.frontmatter.updated).toBe("2026-05-17T10:00:00.000Z");
    const decisions = isa.sections.find((s) => s.name === "Decisions");
    expect(decisions?.content).toContain("Chose path A");
  });
});
