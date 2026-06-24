import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runVsaCli } from "../src/cli-vsa";
import { bootstrapSomaHome, scaffoldVsa } from "../src/index";

async function withSomaHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-cli-vsa-"));
  try {
    await bootstrapSomaHome({ homeDir });
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("soma vsa (no action) prints usage", async () => {
  const result = await runVsaCli([]);
  expect(result.exitCode).toBe(0);
  expect(result.text).toContain("Usage: soma vsa");
});

test("soma vsa list returns 'No VSAs' on empty home", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await runVsaCli(["list", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("No VSAs found");
  });
});

test("AC-3: soma vsa list prints table with slug/phase/progress/updated", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "alpha", goal: "G", effort: "E1" });
    await scaffoldVsa({ homeDir, slug: "bravo", goal: "G", effort: "E2" });
    const result = await runVsaCli(["list", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("SLUG");
    expect(result.text).toContain("PHASE");
    expect(result.text).toContain("PROGRESS");
    expect(result.text).toContain("UPDATED");
    expect(result.text).toContain("alpha");
    expect(result.text).toContain("bravo");
  });
});

test("AC-4: soma vsa show prints VSA contents", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "ship", goal: "Ship feature", effort: "E1" });
    const result = await runVsaCli(["show", "ship", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("Ship feature");
    expect(result.text).toContain("## Goal");
  });
});

test("soma vsa show exits 1 for missing slug", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await runVsaCli(["show", "nonexistent", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("not found");
  });
});

test("AC-5: soma vsa active exits 1 when unset, 0 with slug when set", async () => {
  await withSomaHome(async (homeDir) => {
    const before = await runVsaCli(["active", "--home-dir", homeDir]);
    expect(before.exitCode).toBe(1);
    expect(before.text).toContain("no active VSA");

    await scaffoldVsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    await runVsaCli(["use", "demo", "--home-dir", homeDir]);

    const after = await runVsaCli(["active", "--home-dir", homeDir]);
    expect(after.exitCode).toBe(0);
    expect(after.text.trim()).toBe("demo");
  });
});

test("AC-6: soma vsa use rejects non-existent slugs", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await runVsaCli(["use", "ghost", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("not found");
  });
});

test("soma vsa use --dry-run does not mutate active.json", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    const dry = await runVsaCli(["use", "demo", "--dry-run", "--home-dir", homeDir]);
    expect(dry.exitCode).toBe(0);
    expect(dry.text).toContain("[dry-run]");
    // active.json still does not exist
    const active = await runVsaCli(["active", "--home-dir", homeDir]);
    expect(active.exitCode).toBe(1);
  });
});

test("AC-7: soma vsa scaffold requires slug/effort/goal", async () => {
  await withSomaHome(async (homeDir) => {
    const today = new Date().toISOString().slice(0, 10);
    expect((await runVsaCli(["scaffold", "--home-dir", homeDir])).exitCode).toBe(1);
    expect(
      (await runVsaCli(["scaffold", "--slug", "x", "--home-dir", homeDir])).exitCode,
    ).toBe(1);
    expect(
      (await runVsaCli(["scaffold", "--slug", "x", "--effort", "E1", "--home-dir", homeDir])).exitCode,
    ).toBe(1);
    const ok = await runVsaCli(["scaffold", "--slug", "x", "--effort", "E1", "--goal", "G", "--home-dir", homeDir]);
    expect(ok.exitCode).toBe(0);
    expect(ok.text).toContain(`Scaffolded ${today}-x (E1)`);
  });
});

test("soma vsa scaffold uses date-prefixed slugs and does not double-prefix", async () => {
  await withSomaHome(async (homeDir) => {
    const today = new Date().toISOString().slice(0, 10);
    const derived = await runVsaCli([
      "scaffold",
      "--slug",
      "roesti-soc-tabletop",
      "--effort",
      "E1",
      "--goal",
      "Run the tabletop",
      "--home-dir",
      homeDir,
    ]);
    expect(derived.exitCode).toBe(0);
    expect(derived.text).toContain(`Scaffolded ${today}-roesti-soc-tabletop`);
    await expect(readFile(join(homeDir, ".soma", "isa", `${today}-roesti-soc-tabletop.md`), "utf8")).resolves.toContain(
      "Run the tabletop",
    );

    const alreadyDated = await runVsaCli([
      "scaffold",
      "--slug",
      "2026-05-30-roesti-soc-tabletop",
      "--effort",
      "E1",
      "--goal",
      "Run the tabletop again",
      "--home-dir",
      homeDir,
    ]);
    expect(alreadyDated.exitCode).toBe(0);
    expect(alreadyDated.text).toContain("Scaffolded 2026-05-30-roesti-soc-tabletop");
    expect(alreadyDated.text).not.toContain(`${today}-2026-05-30-roesti-soc-tabletop`);
  });
});

test("AC-7: soma vsa scaffold refuses overwrite without --force", async () => {
  await withSomaHome(async (homeDir) => {
    await runVsaCli(["scaffold", "--slug", "demo", "--effort", "E1", "--goal", "G", "--home-dir", homeDir]);
    const dup = await runVsaCli(["scaffold", "--slug", "demo", "--effort", "E1", "--goal", "G2", "--home-dir", homeDir]);
    expect(dup.exitCode).toBe(1);
    expect(dup.text).toContain("already exists");
    const forced = await runVsaCli(["scaffold", "--slug", "demo", "--effort", "E1", "--goal", "G2", "--force", "--home-dir", homeDir]);
    expect(forced.exitCode).toBe(0);
  });
});

test("AC-8: soma vsa check exits 0 when complete, 1 with gap report when not", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "ok", goal: "G", effort: "E1" });
    const ok = await runVsaCli(["check", "ok", "--home-dir", homeDir]);
    expect(ok.exitCode).toBe(0);
    expect(ok.text).toContain("passed");

    // Write an incomplete E4 VSA by hand (no scaffold) to test the gap path
    await scaffoldVsa({ homeDir, slug: "bad", goal: "G", effort: "E4" });
    // Strip required sections
    const vsaPath = join(homeDir, ".soma", "isa", "bad.md");
    const raw = await readFile(vsaPath, "utf8");
    const trimmed = raw.replace(/## Vision[\s\S]*?(?=##)/, "");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(vsaPath, trimmed, "utf8");
    const bad = await runVsaCli(["check", "bad", "--home-dir", homeDir]);
    expect(bad.exitCode).toBe(1);
    expect(bad.text).toContain("incomplete");
    expect(bad.text).toContain("Vision");
  });
});

test("AC-1: unknown action exits 2 (system error)", async () => {
  const result = await runVsaCli(["nonexistent-action"]);
  expect(result.exitCode).toBe(2);
  expect(result.text).toContain("Unknown soma vsa action");
});

test("AC-2: dry-run is honored on use and scaffold and archive", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    expect((await runVsaCli(["use", "demo", "--dry-run", "--home-dir", homeDir])).text).toContain("[dry-run]");
    expect((await runVsaCli(["scaffold", "--slug", "new", "--effort", "E1", "--goal", "G", "--dry-run", "--home-dir", homeDir])).text).toContain("[dry-run]");
    expect((await runVsaCli(["archive", "demo", "--dry-run", "--home-dir", homeDir])).text).toContain("[dry-run]");
    // archive --dry-run did NOT remove demo
    const list = await runVsaCli(["list", "--home-dir", homeDir]);
    expect(list.text).toContain("demo");
  });
});

test("soma vsa archive moves the VSA to .archived/", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "old", goal: "G", effort: "E1" });
    const result = await runVsaCli(["archive", "old", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain(".archived/old.md");
    const archived = await readFile(join(homeDir, ".soma", "isa", ".archived", "old.md"), "utf8");
    expect(archived).toContain("## Goal");
  });
});

test("archive clears active state when archiving the active VSA", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "current", goal: "G", effort: "E1" });
    await runVsaCli(["use", "current", "--home-dir", homeDir]);
    const before = await runVsaCli(["active", "--home-dir", homeDir]);
    expect(before.text.trim()).toBe("current");

    const archived = await runVsaCli(["archive", "current", "--home-dir", homeDir]);
    expect(archived.exitCode).toBe(0);
    expect(archived.text).toContain("active state cleared");

    const after = await runVsaCli(["active", "--home-dir", homeDir]);
    expect(after.exitCode).toBe(1);
    expect(after.text).toContain("no active VSA");
  });
});

test("list --active-only narrows to the active VSA only", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "first", goal: "G", effort: "E1" });
    await scaffoldVsa({ homeDir, slug: "second", goal: "G", effort: "E1" });
    // No active set → empty
    const before = await runVsaCli(["list", "--active-only", "--home-dir", homeDir]);
    expect(before.exitCode).toBe(0);
    expect(before.text).toContain("No VSAs");
    // Set second active → only second appears
    await runVsaCli(["use", "second", "--home-dir", homeDir]);
    const after = await runVsaCli(["list", "--active-only", "--home-dir", homeDir]);
    expect(after.exitCode).toBe(0);
    expect(after.text).toContain("second");
    expect(after.text).not.toContain("first");
  });
});

test("soma vsa list --phase filters by phase", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldVsa({ homeDir, slug: "a", goal: "G", effort: "E1" });
    const result = await runVsaCli(["list", "--phase", "execute", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("No VSAs found");
  });
});

test("rejects unknown flag", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await runVsaCli(["list", "--bogus", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(2);
    expect(result.text).toContain("Unknown flag");
  });
});
