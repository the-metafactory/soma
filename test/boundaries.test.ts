import { cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ComponentManifest } from "../src/components";
import { BASELINE_PATH, VIOLATIONS_PATH, checkBoundaries, formatReport, repositoryBaseRevision } from "../scripts/check-boundaries";
import { fixtureManifest, publicMemoryManifest } from "./fixtures/boundaries/manifest";
import { withTempHome } from "./fixtures/temp-home";

const repoRoot = resolve(import.meta.dir, "..");
const fixture = (name: string): string => join(import.meta.dir, "fixtures", "boundaries", name);
const check = (name: string, manifest: ComponentManifest = fixtureManifest) =>
  checkBoundaries({ root: fixture(name), manifest });

function commitFixture(root: string): string {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git("init");
  git("add", ".");
  git(
    "-c", "user.name=Boundary Test",
    "-c", "user.email=boundaries@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${join(root, "no-hooks")}`,
    "commit", "-m", "Fixture base",
  );
  return git("rev-parse", "HEAD").trim();
}

describe("component boundaries on the repository", () => {
  test(
    "the committed violation list and closure baseline match the tree",
    () => {
      const report = checkBoundaries({
        root: repoRoot,
        baseRevision: repositoryBaseRevision(repoRoot),
      });
      if (!report.ok) throw new Error(formatReport(report));
      expect(report.ok).toBe(true);
    },
    { timeout: 30_000 },
  );
});

describe("checkBoundaries on fixture trees", () => {
  test("adding a prohibited import together with its exception fails against the Git base", async () => {
    await withTempHome(async (root) => {
      await cp(fixture("clean"), root, { recursive: true });
      const baseRevision = commitFixture(root);
      await cp(fixture("known-violation"), root, { recursive: true });

      // The edited list and baseline agree with the edited tree. Only the base
      // revision reveals that this exception is new.
      const report = checkBoundaries({ root, manifest: fixtureManifest, baseRevision });
      expect(report.ok).toBe(false);
      expect(report.errors.join("\n")).toContain("added exception");
      expect(report.errors.join("\n")).toContain("src/memory.ts -> src/writeback.ts");
      expect(report.addedEntries).toEqual(["src/memory.ts -> src/writeback.ts"]);
      expect(report.closureGrowth).toEqual([]);
      expect(checkBoundaries({ root, manifest: fixtureManifest, baseRevision, updateBaseline: true }).ok).toBe(false);
    }, "soma-boundaries-git-");
  });

  test("existing base exceptions pass, and fixing an import and removing its exception passes", async () => {
    await withTempHome(async (root) => {
      await cp(fixture("known-violation"), root, { recursive: true });
      const baseRevision = commitFixture(root);
      expect(checkBoundaries({ root, manifest: fixtureManifest, baseRevision }).ok).toBe(true);
      await cp(fixture("clean"), root, { recursive: true });
      const report = checkBoundaries({ root, manifest: fixtureManifest, baseRevision });
      expect(report.ok).toBe(true);
      expect(report.addedEntries).toEqual([]);
      expect(report.staleEntries).toEqual([]);
      expect(report.violations).toEqual([]);
    }, "soma-boundaries-git-");
  });

  test("an unavailable base revision fails closed", async () => {
    await withTempHome(async (root) => {
      await cp(fixture("known-violation"), root, { recursive: true });
      commitFixture(root);
      const report = checkBoundaries({ root, manifest: fixtureManifest, baseRevision: "missing-base" });
      expect(report.ok).toBe(false);
      expect(report.errors.join("\n")).toContain("cannot check exceptions against base missing-base");
    }, "soma-boundaries-git-");
  });

  test.each(["clean", "known-violation"])(
    "a base tree without an exception list only permits debt already in that tree (%s)",
    async (baseFixture) => {
      await withTempHome(async (root) => {
        await cp(fixture(baseFixture), root, { recursive: true });
        await Bun.file(join(root, VIOLATIONS_PATH)).delete();
        const baseRevision = commitFixture(root);
        await cp(fixture("known-violation"), root, { recursive: true });
        const report = checkBoundaries({ root, manifest: fixtureManifest, baseRevision });
        expect(report.ok).toBe(baseFixture === "known-violation");
        expect(report.addedEntries).toEqual(baseFixture === "known-violation" ? [] : ["src/memory.ts -> src/writeback.ts"]);
        expect(report.closureGrowth).toEqual([]);
      }, "soma-boundaries-git-");
    },
  );

  test("a clean tree passes", () => {
    const report = check("clean");
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("a memory file importing a flows file is a new violation naming both files and components", () => {
    const report = check("cross-boundary");
    expect(report.ok).toBe(false);
    expect(report.newViolations).toHaveLength(1);
    const [violation] = report.newViolations;
    expect(violation).toMatchObject({
      from: "src/memory.ts",
      to: "src/writeback.ts",
      fromComponent: "memory",
      toComponent: "flows",
      rule: "direction",
    });
    const error = report.errors.join("\n");
    for (const part of ["src/memory.ts", "src/writeback.ts", "[memory]", "[flows]"]) expect(error).toContain(part);
  });

  test("a listed violation is tolerated", () => {
    const report = check("known-violation");
    expect(report.ok).toBe(true);
    expect(report.violations.map((violation) => violation.key)).toEqual(["src/memory.ts -> src/writeback.ts"]);
  });

  test("a listed violation that no longer exists is a stale entry", () => {
    const report = check("stale-entry");
    expect(report.ok).toBe(false);
    expect(report.staleEntries).toEqual(["src/memory.ts -> src/writeback.ts"]);
    expect(report.errors.join("\n")).toContain("stale entry");
  });

  test("a src file that matches no component fails and is named", () => {
    const manifest: ComponentManifest = { ...fixtureManifest, core: { files: [], mayImport: ["legacy"] } };
    const report = check("clean", manifest);
    expect(report.ok).toBe(false);
    expect(report.unmatched).toEqual(["src/paths.ts"]);
    expect(report.errors.join("\n")).toContain("src/paths.ts belongs to no component");
  });

  test("a src file that matches two components fails and is named", () => {
    const manifest: ComponentManifest = {
      ...fixtureManifest,
      flows: { ...fixtureManifest.flows, files: ["src/writeback", "src/memory"] },
    };
    const report = check("clean", manifest);
    expect(report.ok).toBe(false);
    expect(report.ambiguous).toEqual([{ file: "src/memory.ts", components: ["memory", "flows"] }]);
    expect(report.errors.join("\n")).toContain("src/memory.ts belongs to more than one component");
  });

  test("an exclude rule takes a file out of a component", () => {
    const manifest: ComponentManifest = {
      ...fixtureManifest,
      memory: { ...fixtureManifest.memory, exclude: ["src/memory"] },
    };
    expect(check("clean", manifest).unmatched).toEqual(["src/memory.ts"]);
  });

  test("a type-only import across a disallowed boundary is a violation", () => {
    const report = check("type-only");
    expect(report.ok).toBe(false);
    expect(report.newViolations.map((violation) => [violation.key, violation.message])).toEqual([
      ["src/memory.ts -> src/writeback.ts", expect.stringContaining("(type-import)")],
    ]);
  });

  test("a literal dynamic import across a disallowed boundary is a violation", () => {
    const report = check("dynamic-import");
    expect(report.ok).toBe(false);
    expect(report.newViolations.map((violation) => [violation.key, violation.message])).toEqual([
      ["src/memory.ts -> src/writeback.ts", expect.stringContaining("(dynamic-import)")],
    ]);
  });

  test("importing a non-public file of a component with publicEntries is a violation; its public entry passes", () => {
    const report = check("public-entries", publicMemoryManifest);
    expect(report.ok).toBe(false);
    expect(report.newViolations.map((violation) => [violation.key, violation.rule])).toEqual([
      ["src/writeback.ts -> src/memory-internal.ts", "public-entry"],
    ]);
  });

  test("without publicEntries the same imports pass", () => {
    expect(check("public-entries").ok).toBe(true);
  });

  test("a codex file importing a pi-dev file is a unit violation", () => {
    const report = check("unit");
    expect(report.ok).toBe(false);
    expect(report.newViolations).toHaveLength(1);
    expect(report.newViolations[0]).toMatchObject({
      key: "src/adapters/codex/hooks.ts -> src/adapters/pi-dev/hooks.ts",
      rule: "unit",
      fromComponent: "substrates/codex",
      toComponent: "substrates/pi-dev",
    });
  });

  test("test/<component>/ may import its own component, never src/index.ts, and only public entries elsewhere", () => {
    const report = check("test-dir", publicMemoryManifest);
    expect(report.ok).toBe(false);
    expect(report.newViolations.map((violation) => [violation.key, violation.rule])).toEqual([
      ["test/flows/helper.ts -> src/memory-internal.ts", "test-public-entry"],
      ["test/memory/helper.ts -> src/index.ts", "test-index"],
    ]);
  });

  test("closure growth fails with the delta, and passes after --update-baseline", async () => {
    await withTempHome(async (root) => {
      await cp(fixture("closure-growth"), root, { recursive: true });
      const grown = checkBoundaries({ root, manifest: fixtureManifest });
      expect(grown.ok).toBe(false);
      expect(grown.closureGrowth).toContainEqual({ component: "memory", baseline: 4, actual: 5 });
      expect(grown.errors).toContain(
        "closure of memory grew: 4 -> 5 lines (+1); run with --update-baseline if intended",
      );

      const updated = checkBoundaries({ root, manifest: fixtureManifest, updateBaseline: true });
      expect(updated.ok).toBe(true);
      expect(updated.baselineUpdated).toBe(true);
      expect(await Bun.file(join(root, BASELINE_PATH)).json()).toMatchObject({ memory: 5 });

      expect(checkBoundaries({ root, manifest: fixtureManifest }).ok).toBe(true);
    }, "soma-boundaries-");
  });

  test("a closure that shrinks passes and is reported", async () => {
    await withTempHome(async (root) => {
      await cp(fixture("clean"), root, { recursive: true });
      await Bun.write(join(root, BASELINE_PATH), JSON.stringify({ core: 1, memory: 9, flows: 13, substrates: 7, legacy: 16 }));
      const report = checkBoundaries({ root, manifest: fixtureManifest });
      expect(report.ok).toBe(true);
      expect(report.closureShrink).toEqual([{ component: "memory", baseline: 9, actual: 4 }]);
      expect(report.notes.join("\n")).toContain("closure of memory shrank: 9 -> 4 lines (-5)");
    }, "soma-boundaries-");
  });
});
