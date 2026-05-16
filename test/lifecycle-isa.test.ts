import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  bootstrapSomaHome,
  readIsa,
  runSomaLifecycleIsaUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  scaffoldIsa,
  setActiveIsa,
  somaMemoryEventsPath,
} from "../src/index";

async function withSomaHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-lc-isa-"));
  try {
    await bootstrapSomaHome({ homeDir });
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function readEvents(homeDir: string): Promise<{ kind: string; metadata?: Record<string, unknown>; summary?: string }[]> {
  const raw = await readFile(somaMemoryEventsPath(join(homeDir, ".soma")), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { kind: string; metadata?: Record<string, unknown>; summary?: string });
}

test("AC-1: session-start surfaces activeIsa when slug is set, null when not", async () => {
  await withSomaHome(async (homeDir) => {
    const before = await runSomaLifecycleSessionStart({ homeDir });
    expect(before.activeIsa).toBeNull();

    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    await setActiveIsa("demo", { homeDir });

    const after = await runSomaLifecycleSessionStart({ homeDir });
    expect(after.activeIsa).toEqual({ slug: "demo", phase: "observe" });
  });
});

test("AC-2: isa_updated appends decisions/changelog/verification to active ISA", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E4", timestamp: "2026-05-17T00:00:00.000Z" });
    await setActiveIsa("demo", { homeDir });

    const result = await runSomaLifecycleIsaUpdated(
      {
        decisions: [{ text: "Chose A over B" }],
        changelogEntries: [{ text: "Refuted by test failure" }],
        verificationEntries: [{ text: "C1 passed" }],
      },
      { homeDir, timestamp: "2026-05-17T01:00:00.000Z" },
    );
    expect(result.event).toBe("isa_updated");
    // Round-1 fix: batched into single write per payload, not one per entry.
    expect((result.writes ?? []).length).toBe(1);

    const isa = await readIsa("demo", { homeDir });
    expect(isa.sections.find((s) => s.name === "Decisions")?.content).toContain("Chose A over B");
    expect(isa.sections.find((s) => s.name === "Changelog")?.content).toContain("Refuted by test failure");
    expect(isa.sections.find((s) => s.name === "Verification")?.content).toContain("C1 passed");
  });
});

test("AC-3: isa_updated appends — never modifies existing lines (ID-stability lite)", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E4" });
    await setActiveIsa("demo", { homeDir });
    await runSomaLifecycleIsaUpdated({ decisions: [{ text: "First" }] }, { homeDir });
    await runSomaLifecycleIsaUpdated({ decisions: [{ text: "Second" }] }, { homeDir });
    const isa = await readIsa("demo", { homeDir });
    const decisions = isa.sections.find((s) => s.name === "Decisions")?.content ?? "";
    expect(decisions.indexOf("First")).toBeLessThan(decisions.indexOf("Second"));
  });
});

test("AC-4: session-end emits tier-gate-unmet warning but returns normally", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E4" });
    await setActiveIsa("demo", { homeDir });
    // E4 scaffolded ISAs pass by default (placeholders fill gaps); strip a
    // required section to force a gap.
    const isa = await readIsa("demo", { homeDir });
    const stripped = { ...isa, sections: isa.sections.filter((s) => s.name !== "Vision") };
    const { writeIsa } = await import("../src/index");
    await writeIsa("demo", stripped, { homeDir });

    const result = await runSomaLifecycleSessionEnd({ homeDir, timestamp: "2026-05-17T02:00:00.000Z" });
    expect(result.event).toBe("session_end");

    const events = await readEvents(homeDir);
    const warning = events.find((e) => e.kind === "lifecycle.tier-gate-unmet");
    expect(warning).toBeDefined();
    expect(warning?.summary).toContain("demo");
  });
});

test("AC-2 round-1: malformed entry in payload rejects entire write (atomic)", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E4" });
    await setActiveIsa("demo", { homeDir });
    // First write something so we have known state
    await runSomaLifecycleIsaUpdated({ decisions: [{ text: "First" }] }, { homeDir });
    const before = (await readIsa("demo", { homeDir })).sections.find((s) => s.name === "Decisions")?.content ?? "";

    // Now send a payload with an empty later entry — must throw and leave no partial writes
    await expect(
      runSomaLifecycleIsaUpdated(
        {
          decisions: [{ text: "Good entry" }],
          changelogEntries: [{ text: "   " }],
        },
        { homeDir },
      ),
    ).rejects.toThrow(/empty text/);

    const after = (await readIsa("demo", { homeDir })).sections.find((s) => s.name === "Decisions")?.content ?? "";
    expect(after).toBe(before); // unchanged
  });
});

test("writeback: each isa_updated emits exactly one events.jsonl record with full payload", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E4" });
    await setActiveIsa("demo", { homeDir });
    await runSomaLifecycleIsaUpdated(
      {
        decisions: [{ text: "A" }, { text: "B" }],
        changelogEntries: [{ text: "C" }],
      },
      { homeDir },
    );
    const events = await readEvents(homeDir);
    const updates = events.filter((e) => e.kind === "lifecycle.isa_updated");
    expect(updates).toHaveLength(1);
    const md = updates[0]?.metadata as { decisions: { text: string }[]; changelogEntries: { text: string }[] };
    expect(md.decisions.map((d) => d.text)).toEqual(["A", "B"]);
    expect(md.changelogEntries.map((d) => d.text)).toEqual(["C"]);
  });
});

test("AC-5: all three hooks are no-ops when no active ISA is set", async () => {
  await withSomaHome(async (homeDir) => {
    const start = await runSomaLifecycleSessionStart({ homeDir });
    expect(start.activeIsa).toBeNull();

    const updated = await runSomaLifecycleIsaUpdated({ decisions: [{ text: "x" }] }, { homeDir });
    expect(updated.event).toBe("isa_updated");
    expect((updated.writes ?? []).length).toBe(0);

    const end = await runSomaLifecycleSessionEnd({ homeDir });
    expect(end.event).toBe("session_end");

    const events = await readEvents(homeDir);
    expect(events.some((e) => e.kind === "lifecycle.isa_updated.no_active")).toBe(true);
    expect(events.some((e) => e.kind === "lifecycle.tier-gate-unmet")).toBe(false);
  });
});

test("AC-6: integration — scaffold → use → isa_updated → on-disk Decisions changed", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "demo", goal: "Ship it", effort: "E4" });
    await setActiveIsa("demo", { homeDir });
    await runSomaLifecycleIsaUpdated(
      { decisions: [{ text: "Committed to ship today", phase: "execute" }] },
      { homeDir, timestamp: "2026-05-17T12:00:00.000Z" },
    );
    const onDisk = await readFile(join(homeDir, ".soma", "isa", "demo.md"), "utf8");
    expect(onDisk).toContain("## Decisions");
    expect(onDisk).toContain("Committed to ship today");
    expect(onDisk).toContain("[execute]");
  });
});

test("Sage round-2 Security: payload.slug mismatching active slug is refused", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "active-one", goal: "G", effort: "E1" });
    await scaffoldIsa({ homeDir, slug: "explicit-target", goal: "G", effort: "E1" });
    await setActiveIsa("active-one", { homeDir });

    await expect(
      runSomaLifecycleIsaUpdated(
        { slug: "explicit-target", decisions: [{ text: "Cross-scope write" }] },
        { homeDir },
      ),
    ).rejects.toThrow(/does not match active slug/);

    // Neither ISA mutated
    const targeted = await readIsa("explicit-target", { homeDir });
    expect(targeted.sections.find((s) => s.name === "Decisions")?.content ?? "").not.toContain("Cross-scope write");
    const active = await readIsa("active-one", { homeDir });
    expect(active.sections.find((s) => s.name === "Decisions")?.content ?? "").not.toContain("Cross-scope write");
  });
});

test("payload.slug matching active slug is allowed", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "only-one", goal: "G", effort: "E1" });
    await setActiveIsa("only-one", { homeDir });
    await runSomaLifecycleIsaUpdated(
      { slug: "only-one", decisions: [{ text: "Matched explicit slug" }] },
      { homeDir },
    );
    const isa = await readIsa("only-one", { homeDir });
    expect(isa.sections.find((s) => s.name === "Decisions")?.content).toContain("Matched explicit slug");
  });
});

test("payload.slug allowed when no active slug is set", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "no-active-target", goal: "G", effort: "E1" });
    // setActiveIsa(null) intentionally never called — active.json missing
    await runSomaLifecycleIsaUpdated(
      { slug: "no-active-target", decisions: [{ text: "Elected target" }] },
      { homeDir },
    );
    const isa = await readIsa("no-active-target", { homeDir });
    expect(isa.sections.find((s) => s.name === "Decisions")?.content).toContain("Elected target");
  });
});

test("failed isa_updated emits .failed event, not success", async () => {
  await withSomaHome(async (homeDir) => {
    // Set active to a slug whose file doesn't exist — applyIsaUpdate readIsa will ENOENT
    await scaffoldIsa({ homeDir, slug: "ghost", goal: "G", effort: "E1" });
    await setActiveIsa("ghost", { homeDir });
    // Remove the file so readIsa fails
    await rm(join(homeDir, ".soma", "isa", "ghost.md"));

    await expect(
      runSomaLifecycleIsaUpdated({ decisions: [{ text: "doomed" }] }, { homeDir }),
    ).rejects.toThrow();

    const events = await readEvents(homeDir);
    expect(events.some((e) => e.kind === "lifecycle.isa_updated.failed")).toBe(true);
    expect(events.some((e) => e.kind === "lifecycle.isa_updated")).toBe(false);
  });
});

test("session-start tolerates active slug pointing at missing ISA (no crash)", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "ghost", goal: "G", effort: "E1" });
    await setActiveIsa("ghost", { homeDir });
    // Delete the ISA file out from under active state
    await rm(join(homeDir, ".soma", "isa", "ghost.md"));
    const result = await runSomaLifecycleSessionStart({ homeDir });
    expect(result.event).toBe("session_start");
    expect(result.activeIsa).toBeNull();
  });
});
