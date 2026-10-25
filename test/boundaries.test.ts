import { cp, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { components, type ComponentManifest } from "../src/components";
import {
  type BoundaryReport,
  BASELINE_PATH,
  CLOSURE_STEP,
  VIOLATIONS_PATH,
  checkBoundaries,
  collectSpecifiers,
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

function reachableFrom(report: BoundaryReport, seed: string): Set<string> {
  const reachable = new Set<string>();
  const pending = [seed];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const edge of report.edges) if (edge.from === file) pending.push(edge.to);
  }
  return reachable;
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
  test("substrates public entries reject internals and preserve its unit boundary", async () => {
    expect(components.substrates.publicEntries).toEqual([
      "src/substrates/index.ts",
      "src/substrates/types.ts",
      "src/substrates/runtime-artifact.ts",
      "src/substrates/adapters/session-env.ts",
      "src/substrates/skill-content-slug.ts",
      "src/substrates/skill-content-normalizer.ts",
      "src/substrates/skill-content-noise.ts",
      "src/substrates/adapters/pi-dev/skill-projection.ts",
    ]);
    await withRepoFixture("soma-boundaries-substrates-", async (root) => {
      const baseline = checkBoundaries({ root });
      const internals = baseline.files.filter((file) => file.startsWith("src/substrates/") && !components.substrates.publicEntries!.includes(file));
      const importer = join(root, "src/cli/substrates-entry-fixture.ts");
      await writeFile(importer, internals.map((file) => `import "../${file.slice(4)}";`).join("\n"));
      const denied = checkBoundaries({ root, updateBaseline: true });
      expect(denied.ok).toBe(false);
      for (const file of internals) {
        expect(denied.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/substrates-entry-fixture.ts", to: file, rule: "public-entry",
        }));
      }
      await writeFile(importer, components.substrates.publicEntries!
        .map((entry) => `import "../${entry.slice(4)}";\n`).join(""));
      const allowed = checkBoundaries({ root, updateBaseline: true });
      if (!allowed.ok) throw new Error(formatReport(allowed));
      expect(allowed.ok).toBe(true);
      expect(allowed.files.some((file) => /^src\/(adapters|experimental)\//u.test(file))).toBe(false);
      expect(allowed.edges.filter((edge) => edge.from === "src/substrates/index.ts")
        .every((edge) => edge.to.startsWith("src/substrates/"))).toBe(true);
      const unitImporter = join(root, "src/substrates/adapters/codex/unit-fixture.ts");
      await writeFile(unitImporter, 'import "../pi-dev/adapter";\n');
      const unit = checkBoundaries({ root, updateBaseline: true });
      expect(unit.ok).toBe(false);
      expect(unit.newViolations).toContainEqual(expect.objectContaining({
        from: "src/substrates/adapters/codex/unit-fixture.ts",
        to: "src/substrates/adapters/pi-dev/adapter.ts", rule: "unit",
      }));
    });
  }, { timeout: 30_000 });
  test("execution public entry rejects every internal and has no outward violations", async () => {
    await withRepoFixture("soma-boundaries-execution-", async (root) => {
      const importer = join(root, "src/cli/execution-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/execution")))
        .filter((name) => name.endsWith(".ts") && name !== "index.ts" && name !== "algorithm-loop-executor.ts");
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../execution/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/execution-entry-fixture.ts",
          to: `src/execution/${name}`,
          toComponent: "execution",
          rule: "public-entry",
        }));
      }
      await writeFile(importer, 'import "../execution/index";\n');
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.violations.filter((v) => v.fromComponent === "execution")).toEqual([]);
    });
    expect(components.execution.files).toEqual(["src/execution/**"]);
    expect(components.execution.publicEntries).toEqual(["src/execution/index.ts"]);
  }, { timeout: 30_000 });

  test("algorithm's graph dependency is type-only despite its static barrel closure", async () => {
    const source = await Bun.file(join(repoRoot, "src/algorithm/algorithm.ts")).text();
    const edges = collectSpecifiers("algorithm.ts", source).filter(({ specifier }) => specifier.includes("graph/"));
    expect(edges).toEqual([{ specifier: "../graph/index", kind: "type-import" }]);
    // The closure check intentionally includes type edges. Bun must still erase
    // this contract import so pure algorithm calls do not evaluate the backends.
    const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    expect(collectSpecifiers("algorithm.js", emitted).filter(({ specifier }) => specifier.includes("graph/"))).toEqual([]);
  });

  test("graph public entry rejects every internal and has no outward violations", async () => {
    expect(components.graph.files).toEqual(["src/graph/**"]);
    expect(components.graph.publicEntries).toEqual(["src/graph/index.ts"]);
    await withRepoFixture("soma-boundaries-graph-", async (root) => {
      const importer = join(root, "src/cli/graph-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/graph")))
        .filter((name) => name.endsWith(".ts") && name !== "index.ts");
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../graph/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/graph-entry-fixture.ts",
          to: `src/graph/${name}`,
          toComponent: "graph",
          rule: "public-entry",
        }));
      }
      await writeFile(importer, 'import "../graph/index";\n');
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.violations.filter((v) => v.fromComponent === "graph")).toEqual([]);
    });
  }, { timeout: 30_000 });

  test("substrates files live in src/substrates/, and it has no outward violations", () => {
    expect(components.substrates.files).toEqual(["src/substrates/**"]);
    const report = checkBoundaries({ root: repoRoot });
    if (!report.ok) throw new Error(formatReport(report));
    const outward = report.violations
      .filter((v) => v.fromComponent === "substrates")
      .map((v) => `${v.from} -> ${v.to}`);
    expect(outward).toEqual([]);
  }, { timeout: 30_000 });

  test("router public entry rejects every internal and has no outward violations", async () => {
    expect(components.router.files).toEqual(["src/router/**"]);
    expect(components.router.publicEntries).toEqual(["src/router/index.ts"]);
    await withRepoFixture("soma-boundaries-router-", async (root) => {
      const importer = join(root, "src/cli/router-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/router")))
        .filter((name) => name.endsWith(".ts") && name !== "index.ts");
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../router/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/router-entry-fixture.ts",
          to: `src/router/${name}`,
          toComponent: "router",
          rule: "public-entry",
        }));
      }
      await writeFile(importer, 'import "../router/index";\n');
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.violations.filter((v) => v.fromComponent === "router")).toEqual([]);
    });
  }, { timeout: 30_000 });

  test("migrate public entries reject every internal and have no outward violations", async () => {
    expect(components.migrate.files).toEqual(["src/migrate/**"]);
    expect(components.migrate.publicEntries).toEqual(["src/migrate/index.ts", "src/migrate/types.ts"]);
    await withRepoFixture("soma-boundaries-migrate-entry-", async (root) => {
      const importer = join(root, "src/cli/migrate-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/migrate")))
        .filter((name) => name.endsWith(".ts") && name !== "index.ts" && name !== "types.ts");
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../migrate/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/migrate-entry-fixture.ts",
          to: `src/migrate/${name}`,
          toComponent: "migrate",
          rule: "public-entry",
        }));
      }
      await writeFile(importer, 'import "../migrate/index";\nimport "../migrate/types";\n');
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.violations.filter((v) => v.fromComponent === "migrate")).toEqual([]);
    });
  }, { timeout: 30_000 });

  test("flows public entries reject every internal and have no outward violations", async () => {
    expect(components.flows.files).toEqual(["src/flows/**"]);
    expect(components.flows.publicEntries).toEqual(["src/flows/index.ts", "src/flows/types.ts"]);
    await withRepoFixture("soma-boundaries-flows-entry-", async (root) => {
      const importer = join(root, "src/cli/flows-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/flows"), { recursive: true }))
        .filter((name) => name.endsWith(".ts") && name !== "index.ts" && name !== "types.ts");
      expect(internals).toContain("goal-kinds/registry.ts");
      await writeFile(importer, internals.map((name) => `import "../flows/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/flows-entry-fixture.ts",
          to: `src/flows/${name}`,
          toComponent: "flows",
          rule: "public-entry",
        }));
      }
      await writeFile(importer, 'import "../flows/index";\nimport "../flows/types";\n');
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.violations.filter((v) => v.fromComponent === "flows")).toEqual([]);
    });
  }, { timeout: 30_000 });

  test("algorithm public entries reject internals and keep classify unbarrelled", async () => {
    expect(components.algorithm.files).toEqual(["src/algorithm/**"]);
    expect(components.algorithm.publicEntries).toContain("src/algorithm/index.ts");
    await withRepoFixture("soma-boundaries-algorithm-", async (root) => {
      const importer = join(root, "src/cli/algorithm-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/algorithm")))
        .filter((name) => name.endsWith(".ts") && !components.algorithm.publicEntries!.includes(`src/algorithm/${name}`));
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../algorithm/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/algorithm-entry-fixture.ts",
          to: `src/algorithm/${name}`,
          rule: "public-entry",
        }));
      }
      await writeFile(importer, components.algorithm.publicEntries!
        .map((entry) => `import "../algorithm/${entry.split("/").pop()!.slice(0, -3)}";\n`).join(""));
      const report = checkBoundaries({ root, updateBaseline: true });
      if (!report.ok) throw new Error(formatReport(report));
      expect(report.violations.filter((v) => v.fromComponent === "algorithm")).toEqual([]);
      const directEntries = report.edges
        .filter((edge) => edge.from === "src/cli/algorithm.ts" && edge.to.startsWith("src/algorithm/"))
        .map((edge) => edge.to);
      expect([...components.algorithm.publicEntries!].sort()).toEqual(
        [...new Set(["src/algorithm/index.ts", ...directEntries])].sort(),
      );
      const reachable = reachableFrom(report, "src/cli/algorithm.ts");
      expect(reachable.has("src/algorithm/index.ts")).toBe(false);
    });
  }, { timeout: 30_000 });

  test("core's shared types entry reaches no other component", () => {
    expect(components.core.publicEntries).toEqual(["src/core/index.ts", "src/core/types.ts", "src/core/dir-lock.ts"]);
    const report = checkBoundaries({ root: repoRoot });
    expect([...reachableFrom(report, "src/core/types.ts")].filter((file) => !file.startsWith("src/core/"))).toEqual([]);
  });

  test("skill migration keeps its leaf closure and rejects the substrates barrel's growth", async () => {
    const report = checkBoundaries({ root: repoRoot });
    const reachable = reachableFrom(report, "src/migrate/claude-skills-migrator.ts");
    expect(reachable.has("src/substrates/index.ts")).toBe(false);
    expect(reachable.has("src/substrates/install-spec-registry.ts")).toBe(false);
    expect(report.closures.migrate).toBeLessThanOrEqual(11_000);

    await withRepoFixture("soma-boundaries-migrate-", async (root) => {
      await writeFile(join(root, "src/migrate/barrel-fixture.ts"), 'import "../substrates/index";\n');
      const grown = checkBoundaries({ root });
      expect(grown.ok).toBe(false);
      expect(grown.closureGrowth).toContainEqual({
        component: "migrate",
        baseline: (await Bun.file(join(repoRoot, BASELINE_PATH)).json()).migrate,
        actual: grown.closures.migrate,
      });
    });
  });

  test("bootstrap and session lookup entries keep their runtime closures off the substrates barrel", async () => {
    const report = checkBoundaries({ root: repoRoot });
    // Use emitted JS: type-only contracts belong to the static closure above.
    const edges = await Promise.all(report.files.filter((file) => file.endsWith(".ts")).map(async (file) => {
      const emitted = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(join(repoRoot, file)).text());
      return [file, collectSpecifiers(file, emitted)] as const;
    }));
    const specifiers = new Map(edges);
    const runtimeEdges = report.edges.filter((edge) =>
      specifiers.get(edge.from)?.some((entry) => {
        const target = resolve(repoRoot, dirname(edge.from), entry.specifier);
        return [target, `${target}.ts`, `${target}.mjs`, `${target}/index.ts`].includes(join(repoRoot, edge.to));
      }));
    for (const consumer of ["src/flows/run-ledger.ts", "src/flows/algorithm-vsa-sync.ts", "src/cli/algorithm.ts"]) {
      expect(report.edges.filter((edge) => edge.from === consumer && edge.to.startsWith("src/substrates/"))
        .map((edge) => edge.to)).toEqual(["src/substrates/adapters/session-env.ts"]);
    }
    // cli/algorithm also reaches installation through lifecycle; only its
    // session lookup dependency is expected to have a leaf runtime closure.
    for (const seed of ["src/cli-launcher.ts", "src/substrates/adapters/session-env.ts", "src/flows/run-ledger.ts", "src/flows/algorithm-vsa-sync.ts"]) {
      const reachable = reachableFrom({ ...report, edges: runtimeEdges }, seed);
      expect(reachable.size).toBeGreaterThan(1);
      expect(reachable.has("src/substrates/index.ts")).toBe(false);
      expect(reachable.has("src/substrates/install-spec-registry.ts")).toBe(false);
      expect(reachable.has("src/substrates/adapters/claude-code/projection-self-repair.ts")).toBe(false);
    }
  });


  test.each([
    "src/algorithm/algorithm.ts",
    "src/substrates/adapters/claude-code/session-digest.ts",
    "src/substrates/adapters/codex/session-digest.ts",
  ])("%s reaches only home's dependency-light entries", (entry) => {
    const report = checkBoundaries({ root: repoRoot });
    const reachable = reachableFrom(report, entry);
    const homeFiles = [...reachable].filter((file) => file.startsWith("src/home/"));
    expect(homeFiles.length).toBeGreaterThan(0);
    for (const file of homeFiles) {
      expect([
        "src/home/types.ts",
        "src/home/communication-contract.ts",
        "src/home/lifecycle-registry.ts",
      ]).toContain(file);
    }
  });

  test("another component may import home's public entries, but no home internal", async () => {
    expect(components.home.files).toEqual(["src/home/**"]);
    expect(components.home.publicEntries).toEqual([
      "src/home/index.ts",
      "src/home/types.ts",
      "src/home/communication-contract.ts",
      "src/home/lifecycle-registry.ts",
    ]);
    await withRepoFixture("soma-boundaries-home-", async (root) => {
      const importer = join(root, "src/cli/home-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/home")))
        .filter((name) => name.endsWith(".ts") && !components.home.publicEntries!.includes(`src/home/${name}`));
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../home/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/home-entry-fixture.ts",
          to: `src/home/${name}`,
          fromComponent: "cli",
          toComponent: "home",
          rule: "public-entry",
        }));
      }
      await writeFile(importer, [
        'import { loadSomaHome } from "../home/index";',
        'import type { ProjectionInput } from "../home/types";',
        'import { requireReferenceCode } from "../home/communication-contract";',
        'import { registerSessionEndTranscriptHandler } from "../home/lifecycle-registry";',
      ].join("\n"));
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.violations.filter((v) => v.fromComponent === "home")).toEqual([]);
    });
  }, { timeout: 30_000 });

  test("policy public entries exclude internals and keep the hook closure unbarrelled", async () => {
    expect(components.policy.files).toEqual(["src/policy/**"]);
    expect(components.policy.publicEntries).toEqual([
      "src/policy/index.ts",
      "src/policy/types.ts",
      "src/policy/behavior-policy.ts",
      "src/policy/self-healing-doctrine.ts",
      "src/policy/private-roots.ts",
      "src/policy/projection-private-roots.ts",
      "src/policy/policy.ts",
      "src/policy/policy-path-guard.ts",
      "src/policy/policy-targets.ts",
      "src/policy/policy-audit.ts",
      "src/policy/inbound-security.ts",
      "src/policy/runtime-policy.ts",
      "src/policy/tool-policy-guard.ts",
    ]);
    await withRepoFixture("soma-boundaries-policy-", async (root) => {
      const importer = join(root, "src/cli/policy-entry-fixture.ts");
      const internals = (await readdir(join(root, "src/policy")))
        .filter((name) => name.endsWith(".ts") && !components.policy.publicEntries!.includes(`src/policy/${name}`));
      expect(internals.length).toBeGreaterThan(0);
      await writeFile(importer, internals.map((name) => `import "../policy/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/policy-entry-fixture.ts",
          to: `src/policy/${name}`,
          rule: "public-entry",
        }));
      }
      await writeFile(importer, components.policy.publicEntries!
        .map((entry) => `import "../policy/${entry.split("/").pop()!.slice(0, -3)}";\n`).join(""));
      const report = checkBoundaries({ root, updateBaseline: true });
      if (!report.ok) throw new Error(formatReport(report));
      expect(report.violations.filter((v) => v.fromComponent === "policy")).toEqual([]);
      const reachable = reachableFrom(report, "src/cli/policy.ts");
      expect(reachable.has("src/policy/index.ts")).toBe(false);
    });
  }, { timeout: 30_000 });

  test("another component may import tools' five public entries, but no tools internal", async () => {
    expect(components.tools.publicEntries).toEqual([
      "src/tools/index.ts",
      "src/tools/inference/index.ts",
      "src/tools/learning/index.ts",
      "src/tools/relationship/index.ts",
      "src/tools/wisdom/index.ts",
    ]);
    await withRepoFixture("soma-boundaries-tools-", async (root) => {
      const importer = join(root, "src/cli/tools-entry-fixture.ts");
      const internals = [
        "inference/backends/claude-code.ts",
        "inference/types.ts",
        "learning/pattern-synthesis.ts",
        "learning/types.ts",
        "relationship/reflect.ts",
        "wisdom/frame.ts",
      ];
      await writeFile(importer, internals.map((name) => `import "../tools/${name.slice(0, -3)}";\n`).join(""));
      const internal = checkBoundaries({ root, updateBaseline: true });
      expect(internal.ok).toBe(false);
      for (const name of internals) {
        expect(internal.newViolations).toContainEqual(expect.objectContaining({
          from: "src/cli/tools-entry-fixture.ts",
          to: `src/tools/${name}`,
          fromComponent: "cli",
          toComponent: "tools",
          rule: "public-entry",
        }));
      }

      await writeFile(importer, [
        'import { createAutoInferenceBackend } from "../tools/index";',
        'import { inference } from "../tools/inference";',
        'import { addOpinion } from "../tools/learning";',
        'import { reflectRelationship } from "../tools/relationship";',
        'import { listFrames } from "../tools/wisdom";',
      ].join("\n"));
      const publicEntry = checkBoundaries({ root, updateBaseline: true });
      if (!publicEntry.ok) throw new Error(formatReport(publicEntry));
      expect(publicEntry.ok).toBe(true);
      expect(publicEntry.violations.filter((violation) =>
        violation.fromComponent === "tools"))
        .toEqual([]);
    });
  }, { timeout: 30_000 });

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
        violation.fromComponent === "vsa"))
        .toEqual([]);
    });
  }, { timeout: 30_000 });


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
  test("a Git rename preserves an existing exception without admitting new debt", async () => {
    await withTempHome(async (root) => {
      await cp(fixture("known-violation"), root, { recursive: true });
      const baseRevision = commitFixture(root);
      await rename(join(root, "src/memory.ts"), join(root, "src/memory-relocated.ts"));
      await Bun.write(join(root, VIOLATIONS_PATH), JSON.stringify(["src/memory-relocated.ts -> src/writeback.ts"]));
      execFileSync("git", ["add", "."], { cwd: root });
      const manifest: ComponentManifest = { ...fixtureManifest, memory: { ...fixtureManifest.memory, files: ["src/memory-relocated"] } };
      const report = checkBoundaries({ root, manifest, baseRevision });
      if (!report.ok) throw new Error(formatReport(report));
      expect(report.addedEntries).toEqual([]);

      await cp(join(root, "src/writeback.ts"), join(root, "src/extra.ts"));
      await Bun.write(join(root, "src/memory-relocated.ts"), 'import "./writeback";\nimport "./extra";\n');
      await Bun.write(join(root, VIOLATIONS_PATH), JSON.stringify([
        "src/memory-relocated.ts -> src/extra.ts", "src/memory-relocated.ts -> src/writeback.ts",
      ]));
      const extra = checkBoundaries({ root, baseRevision, manifest: {
        ...manifest, flows: { ...manifest.flows, files: [...manifest.flows.files, "src/extra"] },
      } });
      expect(extra.ok).toBe(false);
      expect(extra.addedEntries).toContain("src/memory-relocated.ts -> src/extra.ts");
    }, "soma-boundaries-rename-");
  });
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
    const manifest: ComponentManifest = { ...fixtureManifest, core: { files: [], mayImport: [] } };
    const report = check("clean", manifest);
    expect(report.ok).toBe(false);
    expect(report.unmatched).toEqual(["src/paths.ts", "src/types.ts"]);
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

  test("test/<component>/ may import its own component, and only public entries elsewhere", () => {
    const report = check("test-dir", publicMemoryManifest);
    expect(report.ok).toBe(false);
    expect(report.newViolations.map((violation) => [violation.key, violation.rule])).toEqual([
      ["test/flows/helper.ts -> src/memory-internal.ts", "test-public-entry"],
    ]);
  });

  test("a file that is not a declared public entry may not re-export", () => {
    const report = check("barrel-internal", publicMemoryManifest);
    expect(report.ok).toBe(false);
    expect(report.newViolations.map((violation) => [violation.key, violation.rule])).toEqual([
      ["src/memory-internal.ts -> src/memory.ts", "barrel"],
    ]);
    expect(report.errors.join("\n")).toContain("only a declared public entry of memory may re-export");
  });

  test("a public entry may not re-export another component's file", () => {
    const report = check("barrel-cross", publicMemoryManifest);
    expect(report.ok).toBe(false);
    expect(report.newViolations.map((violation) => [violation.key, violation.rule])).toEqual([
      ["src/memory.ts -> src/paths.ts", "barrel"],
    ]);
    expect(report.errors.join("\n")).toContain("a public entry may re-export only its own component, not core");
  });

  test("a public entry may re-export a file of its own component, type-only included", async () => {
    await withTempHome(async (root) => {
      await cp(fixture("barrel-cross"), root, { recursive: true });
      await writeFile(join(root, "src/memory.ts"), [
        'import { homeDir } from "./paths";',
        "export const memoryDir = `${homeDir}/memory`;",
        'export { internalDir } from "./memory-internal";',
        'export type * from "./memory-internal";',
        "",
      ].join("\n"));
      const report = checkBoundaries({ root, manifest: publicMemoryManifest, updateBaseline: true });
      if (!report.ok) throw new Error(formatReport(report));
      expect(report.violations).toEqual([]);

      await writeFile(join(root, "src/memory-internal.ts"), 'export const internalDir = "internal";\nexport type { Note } from "./types";\n');
      const typeOnly = checkBoundaries({ root, manifest: publicMemoryManifest, updateBaseline: true });
      expect(typeOnly.newViolations.map((violation) => [violation.key, violation.rule])).toEqual([
        ["src/memory-internal.ts -> src/types.ts", "barrel"],
      ]);
    }, "soma-boundaries-barrel-");
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
      const ceilings = { core: 500, memory: 500, flows: 500, substrates: 500 };
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
