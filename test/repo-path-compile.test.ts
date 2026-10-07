import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/**
 * Regression guard for orienteer node #612: bundled skill content must survive
 * `bun build --compile`.
 *
 * `defaultSomaRepoPath()` is `resolve(import.meta.dirname, "..")`. Inside a
 * compiled binary that is Bun's virtual `/$bunfs` root, which holds no real
 * files — so reading `src/skills` from it found nothing, and the readers were
 * built to swallow exactly that: `listBundledSkills()` returned `[]`, the
 * bundled-skill install copied nothing, and the VSA installer took its
 * `no-source` branch. `soma install … --apply` reported success with zero skill
 * content written. Unlike the version.ts break (d0fe14e), nothing failed loudly.
 *
 * So this test does the one thing a source-mode test cannot: it compiles a probe
 * the same way the real CLI is compiled, runs every bundled-skill reader inside
 * it, and holds the result to the source checkout byte for byte.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const SKILLS_ROOT = join(REPO_ROOT, "src", "skills");

interface ProbeReport {
  names: string[];
  explicitNames: string[];
  customNames: string[];
  missingNames: string[];
  vsaAction: string;
  algorithm: string;
}

let workRoot = "";
let binary = "";

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** Every file under `root`, keyed by its posix path relative to `root`. */
function tree(root: string): Map<string, Buffer> {
  return new Map(
    walk(root)
      .map((path) => [relative(root, path).split(sep).join("/"), readFileSync(path)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function sourceSkillNames(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Run the probe (compiled binary or `bun <entry>`) against a fresh work dir. */
function runProbe(command: string, args: string[], label: string): { report: ProbeReport; work: string } {
  const work = join(workRoot, label);
  mkdirSync(join(work, "pai"), { recursive: true });
  // The Algorithm importer needs a PAI source; its bundled half is what's under test.
  writeFileSync(join(work, "pai", "v6.3.0.md"), "# Algorithm probe source\n");
  // An explicit override must still read disk, even when the caller is compiled.
  const customSkill = join(work, "custom-repo", "src", "skills", "fixture-skill");
  mkdirSync(join(customSkill, "references"), { recursive: true });
  writeFileSync(join(customSkill, "SKILL.md"), "# Custom skill\n");
  writeFileSync(join(customSkill, "references", "fixture.md"), "Custom reference\n");
  const result = spawnSync(command, [...args, work], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`${label} probe exited ${String(result.status)}:\n${result.stdout}\n${result.stderr}`);
  }
  const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
  return { report: JSON.parse(lastLine) as ProbeReport, work };
}

beforeAll(() => {
  // Outside the checkout (soma#696): the entry and the ~60MB binary never land in the repo.
  workRoot = mkdtempSync(join(tmpdir(), "soma-repo-path-compile-"));
  const entry = join(workRoot, "probe.ts");
  const src = (module: string) => JSON.stringify(join(REPO_ROOT, "src", module));
  writeFileSync(
    entry,
    [
      `import { join } from "node:path";`,
      `import { importAlgorithm } from ${src("algorithm-importer")};`,
      `import { installBundledSkillsIntoHome, listBundledSkills } from ${src("bundled-skills")};`,
      `import { installVsaSkill } from ${src("vsa-skill-installer")};`,
      `import { defaultSomaRepoPath } from ${src("repo-path")};`,
      `const work = process.argv[2] ?? "";`,
      `const names = await listBundledSkills();`,
      `const somaRepoPath = defaultSomaRepoPath();`,
      `const explicitNames = await listBundledSkills(somaRepoPath);`,
      `const customRepo = join(work, "custom-repo");`,
      `const customNames = await listBundledSkills(customRepo);`,
      `const missingNames = await listBundledSkills(join(work, "missing-repo"));`,
      `await installBundledSkillsIntoHome({ somaHome: join(work, "home") });`,
      `await installBundledSkillsIntoHome({ somaHome: join(work, "explicit-home"), somaRepoPath });`,
      `await installBundledSkillsIntoHome({ somaHome: join(work, "custom-home"), somaRepoPath: customRepo });`,
      `const vsa = await installVsaSkill({ somaHome: join(work, "home") });`,
      `await installVsaSkill({ somaHome: join(work, "explicit-home"), somaRepoPath });`,
      `let algorithm = "ok";`,
      `try { await importAlgorithm({ paiAlgorithmDir: join(work, "pai"), somaHome: join(work, "algorithm-home") }); }`,
      `catch (error) { algorithm = String(error); }`,
      `console.log(JSON.stringify({ names, explicitNames, customNames, missingNames, vsaAction: vsa.action, algorithm }));`,
      "",
    ].join("\n"),
  );
  binary = join(workRoot, "probe-bin");
  // process.execPath, not `bun` from PATH: the bun running this suite is the one under test.
  const build = spawnSync(process.execPath, ["build", "--compile", entry, "--outfile", binary], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (build.status !== 0) throw new Error(`bun build --compile failed:\n${build.stdout}\n${build.stderr}`);
}, 180_000);

afterAll(() => {
  if (workRoot !== "") rmSync(workRoot, { recursive: true, force: true });
});

test("a compiled binary lists the same bundled skills as the source checkout", () => {
  const compiled = runProbe(binary, [], "compiled").report;
  const source = runProbe(process.execPath, [join(workRoot, "probe.ts")], "source").report;

  expect(sourceSkillNames().length).toBeGreaterThan(0);
  expect(source.names).toEqual(sourceSkillNames());
  expect(compiled.names).toEqual(source.names);
  expect(source.explicitNames).toEqual(source.names);
  expect(compiled.explicitNames).toEqual(source.names);
}, 120_000);

test("a compiled binary installs every bundled skill file byte-identical to src/skills", () => {
  const { report, work } = runProbe(binary, [], "compiled-install");

  // The silent branch this node exists to close: no source found, success reported.
  expect(report.vsaAction).not.toBe("no-source");
  expect(report.algorithm).toBe("ok");

  const installed = tree(join(work, "home", "skills"));
  const explicit = tree(join(work, "explicit-home", "skills"));
  const expected = tree(SKILLS_ROOT);
  expect([...installed.keys()]).toEqual([...expected.keys()]);
  expect([...explicit.keys()]).toEqual([...expected.keys()]);
  for (const [path, bytes] of expected) {
    expect({ path, same: installed.get(path)?.equals(bytes) }).toEqual({ path, same: true });
    expect({ path, same: explicit.get(path)?.equals(bytes) }).toEqual({ path, same: true });
  }

  // The importer's bundled half (SKILL.md + RunAlgorithm.md) came from the binary too.
  const algorithmSkill = join(work, "algorithm-home", "skills", "the-algorithm", "SKILL.md");
  const sourceSkill = readFileSync(join(SKILLS_ROOT, "the-algorithm", "SKILL.md"), "utf8");
  expect(readFileSync(algorithmSkill, "utf8")).toBe(`${sourceSkill.trimEnd()}\n`);
}, 120_000);

test("a compiled binary honors custom repository paths instead of falling back to its embedded skills", () => {
  const { report, work } = runProbe(binary, [], "compiled-custom");

  expect(report.customNames).toEqual(["fixture-skill"]);
  expect(report.missingNames).toEqual([]);
  const installed = tree(join(work, "custom-home", "skills"));
  const expected = tree(join(work, "custom-repo", "src", "skills"));
  expect([...installed.keys()]).toEqual([...expected.keys()]);
  for (const [path, bytes] of expected) {
    expect({ path, same: installed.get(path)?.equals(bytes) }).toEqual({ path, same: true });
  }
}, 120_000);

test("the embedded skill module is current: same files, same bytes as src/skills", async () => {
  const { BUNDLED_SKILL_FILES_MODULE, renderBundledSkillFilesModule } = await import("../scripts/generate-bundled-skill-files");
  // Stale after adding, removing or renaming a skill file: `bun run generate-bundled-skill-files`.
  expect(readFileSync(BUNDLED_SKILL_FILES_MODULE, "utf8")).toBe(renderBundledSkillFilesModule());

  const { BUNDLED_SKILL_FILES } = await import("../src/bundled-skill-files.generated");
  const disk = [...tree(SKILLS_ROOT)].filter(([path]) => path.includes("/"));
  expect(Object.keys(BUNDLED_SKILL_FILES).sort()).toEqual(disk.map(([path]) => path));
  // A text import decodes UTF-8, so a non-UTF-8 asset (or a BOM) would ship altered. Fail here instead.
  for (const [path, bytes] of disk) {
    expect({ path, same: Buffer.from(BUNDLED_SKILL_FILES[path] ?? "", "utf8").equals(bytes) }).toEqual({ path, same: true });
  }
});

test("only bundled-skill-source.ts loads the embedded skill text, and only dynamically", () => {
  // A static import anywhere would put ~550K of skill text on every invocation
  // that loads src/index.ts, hook hot paths included.
  const loaders = walk(join(REPO_ROOT, "src"))
    .filter((path) => /\.(?:ts|mts|mjs|js)$/u.test(path) && !path.endsWith(".generated.ts"))
    .filter((path) => readFileSync(path, "utf8").includes("bundled-skill-files.generated"))
    .map((path) => relative(REPO_ROOT, path).split(sep).join("/"));
  expect(loaders).toEqual(["src/bundled-skill-source.ts"]);

  const source = readFileSync(join(REPO_ROOT, "src", "bundled-skill-source.ts"), "utf8");
  expect(source).toMatch(/await import\("\.\/bundled-skill-files\.generated"\)/u);
  expect(source).not.toMatch(/\bfrom\s*["']\.\/bundled-skill-files\.generated["']/u);
});
