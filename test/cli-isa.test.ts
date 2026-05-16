import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runIsaCli } from "../src/cli-isa";
import { bootstrapSomaHome, scaffoldIsa } from "../src/index";

async function withSomaHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-cli-isa-"));
  try {
    await bootstrapSomaHome({ homeDir });
    return await fn(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("soma isa (no action) prints usage", async () => {
  const result = await runIsaCli([]);
  expect(result.exitCode).toBe(0);
  expect(result.text).toContain("Usage: soma isa");
});

test("soma isa list returns 'No ISAs' on empty home", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await runIsaCli(["list", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("No ISAs found");
  });
});

test("AC-3: soma isa list prints table with slug/phase/progress/updated", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "alpha", goal: "G", effort: "E1" });
    await scaffoldIsa({ homeDir, slug: "bravo", goal: "G", effort: "E2" });
    const result = await runIsaCli(["list", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("SLUG");
    expect(result.text).toContain("PHASE");
    expect(result.text).toContain("PROGRESS");
    expect(result.text).toContain("UPDATED");
    expect(result.text).toContain("alpha");
    expect(result.text).toContain("bravo");
  });
});

test("AC-4: soma isa show prints ISA contents", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "ship", goal: "Ship feature", effort: "E1" });
    const result = await runIsaCli(["show", "ship", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("Ship feature");
    expect(result.text).toContain("## Goal");
  });
});

test("soma isa show exits 1 for missing slug", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await runIsaCli(["show", "nonexistent", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("not found");
  });
});

test("AC-5: soma isa active exits 1 when unset, 0 with slug when set", async () => {
  await withSomaHome(async (homeDir) => {
    const before = await runIsaCli(["active", "--home-dir", homeDir]);
    expect(before.exitCode).toBe(1);
    expect(before.text).toContain("no active ISA");

    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    await runIsaCli(["use", "demo", "--home-dir", homeDir]);

    const after = await runIsaCli(["active", "--home-dir", homeDir]);
    expect(after.exitCode).toBe(0);
    expect(after.text.trim()).toBe("demo");
  });
});

test("AC-6: soma isa use rejects non-existent slugs", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await runIsaCli(["use", "ghost", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("not found");
  });
});

test("soma isa use --dry-run does not mutate active.json", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    const dry = await runIsaCli(["use", "demo", "--dry-run", "--home-dir", homeDir]);
    expect(dry.exitCode).toBe(0);
    expect(dry.text).toContain("[dry-run]");
    // active.json still does not exist
    const active = await runIsaCli(["active", "--home-dir", homeDir]);
    expect(active.exitCode).toBe(1);
  });
});

test("AC-7: soma isa scaffold requires slug/effort/goal", async () => {
  await withSomaHome(async (homeDir) => {
    expect((await runIsaCli(["scaffold", "--home-dir", homeDir])).exitCode).toBe(1);
    expect(
      (await runIsaCli(["scaffold", "--slug", "x", "--home-dir", homeDir])).exitCode,
    ).toBe(1);
    expect(
      (await runIsaCli(["scaffold", "--slug", "x", "--effort", "E1", "--home-dir", homeDir])).exitCode,
    ).toBe(1);
    const ok = await runIsaCli(["scaffold", "--slug", "x", "--effort", "E1", "--goal", "G", "--home-dir", homeDir]);
    expect(ok.exitCode).toBe(0);
    expect(ok.text).toContain("Scaffolded x (E1)");
  });
});

test("AC-7: soma isa scaffold refuses overwrite without --force", async () => {
  await withSomaHome(async (homeDir) => {
    await runIsaCli(["scaffold", "--slug", "demo", "--effort", "E1", "--goal", "G", "--home-dir", homeDir]);
    const dup = await runIsaCli(["scaffold", "--slug", "demo", "--effort", "E1", "--goal", "G2", "--home-dir", homeDir]);
    expect(dup.exitCode).toBe(1);
    expect(dup.text).toContain("already exists");
    const forced = await runIsaCli(["scaffold", "--slug", "demo", "--effort", "E1", "--goal", "G2", "--force", "--home-dir", homeDir]);
    expect(forced.exitCode).toBe(0);
  });
});

test("AC-8: soma isa check exits 0 when complete, 1 with gap report when not", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "ok", goal: "G", effort: "E1" });
    const ok = await runIsaCli(["check", "ok", "--home-dir", homeDir]);
    expect(ok.exitCode).toBe(0);
    expect(ok.text).toContain("passed");

    // Write an incomplete E4 ISA by hand (no scaffold) to test the gap path
    await scaffoldIsa({ homeDir, slug: "bad", goal: "G", effort: "E4" });
    // Strip required sections
    const isaPath = join(homeDir, ".soma", "isa", "bad.md");
    const raw = await readFile(isaPath, "utf8");
    const trimmed = raw.replace(/## Vision[\s\S]*?(?=##)/, "");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(isaPath, trimmed, "utf8");
    const bad = await runIsaCli(["check", "bad", "--home-dir", homeDir]);
    expect(bad.exitCode).toBe(1);
    expect(bad.text).toContain("incomplete");
    expect(bad.text).toContain("Vision");
  });
});

test("AC-1: unknown action exits 2 (system error)", async () => {
  const result = await runIsaCli(["nonexistent-action"]);
  expect(result.exitCode).toBe(2);
  expect(result.text).toContain("Unknown soma isa action");
});

test("AC-2: dry-run is honored on use and scaffold and archive", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "demo", goal: "G", effort: "E1" });
    expect((await runIsaCli(["use", "demo", "--dry-run", "--home-dir", homeDir])).text).toContain("[dry-run]");
    expect((await runIsaCli(["scaffold", "--slug", "new", "--effort", "E1", "--goal", "G", "--dry-run", "--home-dir", homeDir])).text).toContain("[dry-run]");
    expect((await runIsaCli(["archive", "demo", "--dry-run", "--home-dir", homeDir])).text).toContain("[dry-run]");
    // archive --dry-run did NOT remove demo
    const list = await runIsaCli(["list", "--home-dir", homeDir]);
    expect(list.text).toContain("demo");
  });
});

test("soma isa archive moves the ISA to .archived/", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "old", goal: "G", effort: "E1" });
    const result = await runIsaCli(["archive", "old", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain(".archived/old.md");
    const archived = await readFile(join(homeDir, ".soma", "isa", ".archived", "old.md"), "utf8");
    expect(archived).toContain("## Goal");
  });
});

test("archive clears active state when archiving the active ISA", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "current", goal: "G", effort: "E1" });
    await runIsaCli(["use", "current", "--home-dir", homeDir]);
    const before = await runIsaCli(["active", "--home-dir", homeDir]);
    expect(before.text.trim()).toBe("current");

    const archived = await runIsaCli(["archive", "current", "--home-dir", homeDir]);
    expect(archived.exitCode).toBe(0);
    expect(archived.text).toContain("active state cleared");

    const after = await runIsaCli(["active", "--home-dir", homeDir]);
    expect(after.exitCode).toBe(1);
    expect(after.text).toContain("no active ISA");
  });
});

test("list --active-only narrows to the active ISA only", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "first", goal: "G", effort: "E1" });
    await scaffoldIsa({ homeDir, slug: "second", goal: "G", effort: "E1" });
    // No active set → empty
    const before = await runIsaCli(["list", "--active-only", "--home-dir", homeDir]);
    expect(before.exitCode).toBe(0);
    expect(before.text).toContain("No ISAs");
    // Set second active → only second appears
    await runIsaCli(["use", "second", "--home-dir", homeDir]);
    const after = await runIsaCli(["list", "--active-only", "--home-dir", homeDir]);
    expect(after.exitCode).toBe(0);
    expect(after.text).toContain("second");
    expect(after.text).not.toContain("first");
  });
});

test("soma isa list --phase filters by phase", async () => {
  await withSomaHome(async (homeDir) => {
    await scaffoldIsa({ homeDir, slug: "a", goal: "G", effort: "E1" });
    const result = await runIsaCli(["list", "--phase", "execute", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("No ISAs found");
  });
});

test("rejects unknown flag", async () => {
  await withSomaHome(async (homeDir) => {
    const result = await runIsaCli(["list", "--bogus", "--home-dir", homeDir]);
    expect(result.exitCode).toBe(2);
    expect(result.text).toContain("Unknown flag");
  });
});
