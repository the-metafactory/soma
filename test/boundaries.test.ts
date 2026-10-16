import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { components, type ComponentManifest } from "../src/components";
import {
  BASELINE_PATH,
  CLOSURE_STEP,
  VIOLATIONS_PATH,
  checkBoundaries,
  closureCeiling,
  formatReport,
} from "../scripts/check-boundaries";
import { repositoryBaseRevision } from "../scripts/git-base";
import { fixtureManifest, publicMemoryManifest } from "./fixtures/boundaries/manifest";
import { withTempHome } from "./fixtures/temp-home";

const repoRoot = resolve(import.meta.dir, "..");
const fixture = (name: string): string => join(import.meta.dir, "fixtures", "boundaries", name);
const check = (name: string, manifest: ComponentManifest = fixtureManifest) =>
  checkBoundaries({ root: fixture(name), manifest });

async function withRepoFixture<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
  return withTempHome(async (root) => {
    await cp(join(repoRoot, "src"), join(root, "src"), { recursive: true });
    await cp(join(repoRoot, "scripts/boundaries"), join(root, "scripts/boundaries"), { recursive: true });
    await mkdir(join(root, "src/cli"), { recursive: true });
    return fn(root);
  }, prefix);
}

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
  test("another component may import vsa's runtime and types entries, but no vsa internal", async () => {
    expect(components.vsa.publicEntries).toEqual(["src/vsa/index.ts", "src/vsa/types.ts"]);
    await withRepoFixture("soma-boundaries-vsa-", async (root) => {
      const importer = join(root, "src/cli/vsa-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/vsa")))
        .filter((name) => name.endsWith(".ts") && name !== "index.ts" && name !== "types.ts");
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../vsa/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/vsa-entry-fixture.ts",
          to: `src/vsa/${name}`,
          fromComponent: "cli",
          toComponent: "vsa",
          rule: "public-entry",
        }));
      }

      await writeFile(importer, [
        'import { parseVsa } from "../vsa/index";',
        'import type { VerificationStateArtifact } from "../vsa/types";',
      ].join("\n"));
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.ok).toBe(true);
      expect(publicEntry.violations.filter((violation) =>
        violation.fromComponent === "vsa" && violation.toComponent !== "legacy"))
        .toEqual([]);
    });
  }, { timeout: 30_000 });

  test.each(["memory", "vsa"] as const)("shared types reach only %s's types entry, even transitively", (component) => {
    expect(components[component].publicEntries).toEqual([`src/${component}/index.ts`, `src/${component}/types.ts`]);
    const report = checkBoundaries({ root: repoRoot });
    const reachable = new Set<string>();
    const pending = ["src/types.ts"];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (reachable.has(file)) continue;
      reachable.add(file);
      for (const edge of report.edges) {
        if (edge.from === file) pending.push(edge.to);
      }
    }
    expect([...reachable].filter((file) => file.startsWith(`src/${component}/`)))
      .toEqual([`src/${component}/types.ts`]);
  });

  test("another component may import memory's runtime and types entries, but no memory internal", async () => {
    await withRepoFixture("soma-boundaries-memory-", async (root) => {
      const importer = join(root, "src/cli/memory-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/memory")))
        .filter((name) => name.endsWith(".ts") && name !== "index.ts" && name !== "types.ts");
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../memory/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/memory-entry-fixture.ts",
          to: `src/memory/${name}`,
          fromComponent: "cli",
          toComponent: "memory",
          rule: "public-entry",
        }));
      }

      await writeFile(importer, [
        'import { parseMemoryNote } from "../memory/index";',
        'import { SOMA_MEMORY_NOTE_TYPES, type SomaMemoryNote } from "../memory/types";',
      ].join("\n"));
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.ok).toBe(true);
      expect(new Set(publicEntry.edges
        .filter((edge) => edge.from === "src/types.ts" && edge.to.startsWith("src/memory/"))
        .map((edge) => edge.to)))
        .toEqual(new Set(["src/memory/types.ts"]));
    });
  }, { timeout: 30_000 });

  test("another component may import events' public entry, but not its value or type implementation files", async () => {
    await withRepoFixture("soma-boundaries-events-", async (root) => {
      const importer = join(root, "src/cli/events-entry-fixture.ts");
      for (const [declaration, target] of [
        ['import { appendSomaMemoryEvent } from "../events/event-journal";\n', "src/events/event-journal.ts"],
        ['import type { SomaMemoryEvent } from "../events/types";\n', "src/events/types.ts"],
      ]) {
        await writeFile(importer, declaration);
        const internal = checkBoundaries({ root, updateBaseline: true });
        expect(internal.ok).toBe(false);
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/events-entry-fixture.ts",
          to: target,
          fromComponent: "cli",
          toComponent: "events",
          rule: "public-entry",
        }));
      }

      await writeFile(importer, 'import { appendSomaMemoryEvent, type SomaMemoryEvent } from "../events/index";\n');
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.ok).toBe(true);
    });
  }, { timeout: 30_000 });

  test("another component may import core's public entry, but not a core implementation file", async () => {
    await withRepoFixture("soma-boundaries-core-", async (root) => {
      const importer = join(root, "src/cli/core-entry-fixture.ts");
      await writeFile(importer, 'import { createPaths } from "../core/paths";\n');
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      expect(internal.newViolations).toContainEqual(expect.objectContaining({
        from: "src/cli/core-entry-fixture.ts",
        to: "src/core/paths.ts",
        fromComponent: "cli",
        toComponent: "core",
        rule: "public-entry",
      }));

      await writeFile(importer, 'import { createPaths } from "../core/index";\n');
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.ok).toBe(true);
    });
  }, { timeout: 30_000 });

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
        "closure of memory grew past its ceiling: 4 -> 5 lines (+1); run with --update-baseline if intended",
      );

      const updated = checkBoundaries({ root, manifest: fixtureManifest, updateBaseline: true });
      expect(updated.ok).toBe(true);
      expect(updated.baselineUpdated).toBe(true);
      expect(await Bun.file(join(root, BASELINE_PATH)).json()).toMatchObject({ memory: closureCeiling(5) });

      expect(checkBoundaries({ root, manifest: fixtureManifest }).ok).toBe(true);
    }, "soma-boundaries-");
  });

  test("a closure under its ceiling passes silently; one that shrank below its ceiling's step is reported", async () => {
    await withTempHome(async (root) => {
      await cp(fixture("clean"), root, { recursive: true });
      const ceilings = { core: 500, memory: 500, flows: 500, substrates: 500, legacy: 500 };
      await Bun.write(join(root, BASELINE_PATH), JSON.stringify(ceilings));
      const quiet = checkBoundaries({ root, manifest: fixtureManifest });
      expect(quiet.ok).toBe(true);
      expect(quiet.closureShrink).toEqual([]);

      await Bun.write(join(root, BASELINE_PATH), JSON.stringify({ ...ceilings, memory: 2000 }));
      const report = checkBoundaries({ root, manifest: fixtureManifest });
      expect(report.ok).toBe(true);
      expect(report.closureShrink).toEqual([{ component: "memory", baseline: 2000, actual: 4 }]);
      expect(report.notes.join("\n")).toContain("closure of memory shrank: 4 lines under a ceiling of 2000; --update-baseline lowers it to 500");
    }, "soma-boundaries-");
  });

  test("ceilings add 5% headroom in steps of 500 lines, so small growth leaves the baseline alone", () => {
    expect(closureCeiling(1)).toBe(CLOSURE_STEP);
    expect(closureCeiling(4594)).toBe(5000);
    expect(closureCeiling(4761)).toBe(5000);
    expect(closureCeiling(4762)).toBe(5500);
    expect(closureCeiling(70198)).toBe(74000);
    // A PR that adds a few hundred lines to a 4,594-line closure stays under 5,000.
    expect(4594 + 300).toBeLessThanOrEqual(closureCeiling(4594));
  });
});
