import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { comparePaths, toPosixRelative, walkFiles as walk } from "../src/fs-walk";

/** Regression for node #612: compiled skill consumers use embedded content.
 * For the independent runtime-staging limitation, see
 * docs/design-skill-packaging.md §Skills bundled with Soma.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const SKILLS_ROOT = join(REPO_ROOT, "src", "skills");

interface ProbeReport {
  names: string[];
  explicitNames: string[];
  customNames: string[];
  rootErrors: Record<string, string | null>;
  emptyNames: string[];
  vsaAction: string;
  algorithm: string;
  defaultRepoPath: string;
  codexTrustedRepo: string;
  installNames: string[];
  profileSkillNames: string[];
  cleanFindings: { id: string; message: string }[];
  driftFindings: { id: string; message: string }[];
  grokError: { code?: string; path?: string } | null;
  grokSkillPaths: string[];
}

let workRoot = "";
let binary = "";
let cliBinary = "";
let compiledProbe: ReturnType<typeof runProbe>;
let sourceProbe: ReturnType<typeof runProbe>;

/** Every file under `root`, keyed by its posix path relative to `root`. */
function tree(root: string, skipHidden = false): Map<string, Buffer> {
  return new Map(
    walk(root, { skipHidden })
      .map((path) => [toPosixRelative(root, path), readFileSync(path)] as const)
      .sort(([a], [b]) => comparePaths(a, b)),
  );
}

function expectSameTree(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [path, bytes] of expected) {
    expect({ path, same: actual.get(path)?.equals(bytes) }).toEqual({ path, same: true });
  }
}

function sourceSkillNames(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
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
  // Invalid UTF-8 and a BOM must survive a custom repository copy unchanged.
  writeFileSync(join(customSkill, "references", "asset.bin"), Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff, 0x80, 0xc0]));
  // Generator exclusions must not alter explicit repositories' copy contract.
  writeFileSync(join(customSkill, ".metadata"), "Custom hidden file\n");
  mkdirSync(join(work, "missing-skills"), { recursive: true });
  mkdirSync(join(work, "not-directory", "src"), { recursive: true });
  writeFileSync(join(work, "not-directory", "src", "skills"), "not a directory\n");
  mkdirSync(join(work, "empty-repo", "src", "skills"), { recursive: true });
  const result = spawnSync(command, [...args, work], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) {
    throw new Error(`${label} probe exited ${String(result.status)}:\n${result.stdout}\n${result.stderr}`);
  }
  const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
  return { report: JSON.parse(lastLine) as ProbeReport, work };
}

async function compile(entry: string, outfile: string): Promise<void> {
  const build = Bun.spawn([process.execPath, "build", "--compile", entry, "--outfile", outfile], {
    stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => build.kill(), 120_000);
  try {
    const [status, stdout, stderr] = await Promise.all([
      build.exited, new Response(build.stdout).text(), new Response(build.stderr).text(),
    ]);
    if (status !== 0) throw new Error(`bun build --compile failed (${entry}):\n${stdout}\n${stderr}`);
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  // Outside the checkout (soma#696): the ~60MB binaries never land in the repo.
  workRoot = mkdtempSync(join(tmpdir(), "soma-repo-path-compile-"));
  const entry = join(REPO_ROOT, "test", "fixtures", "repo-path-probe.ts");
  binary = join(workRoot, "probe-bin");
  // process.execPath, not `bun` from PATH: the bun running this suite is the one under test.
  cliBinary = join(workRoot, "soma");
  await Promise.all([
    compile(entry, binary),
    compile(join(REPO_ROOT, "src", "cli.ts"), cliBinary),
  ]);
  compiledProbe = runProbe(binary, [], "compiled");
  sourceProbe = runProbe(process.execPath, [entry], "source");
}, 180_000);

afterAll(() => {
  if (workRoot !== "") rmSync(workRoot, { recursive: true, force: true });
});

test("a compiled binary lists the same bundled skills as the source checkout", () => {
  const compiled = compiledProbe.report;
  const source = sourceProbe.report;

  expect(sourceSkillNames()).toEqual(["Memory", "VSA", "migrate-pai-purpose", "orienteer", "the-algorithm"]);
  expect(source.names).toEqual(sourceSkillNames());
  expect(compiled.names).toEqual(source.names);
  expect(source.explicitNames).toEqual(source.names);
  expect(compiled.explicitNames).toEqual(source.names);
}, 120_000);

test("a compiled binary installs every bundled skill file byte-identical to src/skills", () => {
  const { report, work } = compiledProbe;

  // The silent branch this node exists to close: no source found, success reported.
  expect(report.vsaAction).not.toBe("no-source");
  expect(report.algorithm).toBe("ok");

  const installed = tree(join(work, "home", "skills"));
  const explicit = tree(join(work, "explicit-home", "skills"));
  const expected = tree(SKILLS_ROOT, true);
  expectSameTree(installed, expected);
  expectSameTree(explicit, expected);

  // The importer's bundled half (SKILL.md + RunAlgorithm.md) came from the binary too.
  const algorithmSkill = join(work, "algorithm-home", "skills", "the-algorithm", "SKILL.md");
  const sourceSkill = readFileSync(join(SKILLS_ROOT, "the-algorithm", "SKILL.md"), "utf8");
  expect(readFileSync(algorithmSkill, "utf8")).toBe(`${sourceSkill.trimEnd()}\n`);
}, 120_000);

test("a compiled binary honors custom repository paths instead of falling back to its embedded skills", () => {
  const { report, work } = compiledProbe;

  expect(report.customNames).toEqual(["fixture-skill"]);
  const installed = tree(join(work, "custom-home", "skills"));
  const expected = tree(join(work, "custom-repo", "src", "skills"));
  expectSameTree(installed, expected);
}, 120_000);

test("source and compiled skill APIs reject invalid explicit roots instead of reporting empty success", () => {
  const errors = {
    "missing-repo:list": "ENOENT",
    "missing-repo:install": "ENOENT",
    "missing-skills:list": "ENOENT",
    "missing-skills:install": "ENOENT",
    "not-directory:list": "ENOTDIR",
    "not-directory:install": "ENOTDIR",
  };
  for (const { report } of [sourceProbe, compiledProbe]) {
    expect(report.rootErrors).toEqual(errors);
    expect(report.emptyNames).toEqual([]);
  }
});

test("the embedded skill module is current: same files, same bytes as src/skills", async () => {
  const { BUNDLED_SKILL_FILES_MODULE, renderBundledSkillFilesModule } = await import("../scripts/generate-bundled-skill-files");
  // Stale after adding, removing or renaming a skill file: `bun run generate-bundled-skill-files`.
  expect(readFileSync(BUNDLED_SKILL_FILES_MODULE, "utf8")).toBe(renderBundledSkillFilesModule());

  const { BUNDLED_SKILL_FILES } = await import("../src/bundled-skill-files.generated");
  const disk = new Map([...tree(SKILLS_ROOT, true)].filter(([path]) => path.includes("/")));
  const embedded = new Map(Object.entries(BUNDLED_SKILL_FILES).map(([path, content]) => [path, Buffer.from(content, "utf8")]));
  // A text import decodes UTF-8, so a non-UTF-8 asset (or a BOM) would ship altered. Fail here instead.
  expectSameTree(embedded, disk);
});

test("the skill generator excludes hidden checkout files, hidden directories and symlinks", async () => {
  const { bundledSkillFilePaths, renderBundledSkillFilesModule } = await import("../scripts/generate-bundled-skill-files");
  const root = join(workRoot, "generator-skills");
  const skill = join(root, "fixture");
  mkdirSync(join(skill, ".editor"), { recursive: true });
  mkdirSync(join(root, ".hidden-skill"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# Fixture\n");
  writeFileSync(join(skill, ".DS_Store"), Buffer.from([0xff, 0x80]));
  writeFileSync(join(skill, ".editor", "swap.md"), "ignored\n");
  writeFileSync(join(root, ".hidden-skill", "SKILL.md"), "ignored\n");
  symlinkSync(join(skill, "SKILL.md"), join(skill, "linked.md"));
  expect(bundledSkillFilePaths(root)).toEqual(["fixture/SKILL.md"]);
  expect(renderBundledSkillFilesModule(root)).toContain('import file0 from "./skills/fixture/SKILL.md" with { type: "text" };');
  expect(renderBundledSkillFilesModule(root)).not.toContain("file1");
});

test("the real compiled CLI imports embedded Algorithm skill content", () => {
  const home = join(workRoot, "cli-import");
  const pai = join(home, "pai");
  mkdirSync(pai, { recursive: true });
  writeFileSync(join(pai, "v6.3.0.md"), "# Algorithm CLI source\n");
  const result = spawnSync(cliBinary, ["import", "algorithm", "--apply", "--home-dir", home, "--pai-algorithm-dir", pai], {
    cwd: home,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect({ status: result.status, error: result.error, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: "" });
  for (const path of ["SKILL.md", "Workflows/RunAlgorithm.md"]) {
    const expected = readFileSync(join(SKILLS_ROOT, "the-algorithm", path), "utf8");
    expect(readFileSync(join(home, ".soma", "skills", "the-algorithm", path), "utf8")).toBe(`${expected.trimEnd()}\n`);
  }
}, 120_000);

test("the real compiled CLI install fails loudly at source-runtime staging, before skill installation", () => {
  const home = join(workRoot, "cli-install");
  mkdirSync(home, { recursive: true });
  const result = spawnSync(cliBinary, ["install", "claude-code", "--apply", "--skills", "the-algorithm", "--home-dir", home], {
    cwd: home,
    encoding: "utf8",
    timeout: 60_000,
  });
  // This guards a known limitation, not successful end-to-end installation.
  // Runtime deployment is a separate contract from embedded skill content.
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("stage-cli-runtime-artifact");
  expect(result.stdout).not.toContain("Soma install applied");
}, 120_000);

test("compiled install skill preparation populates all five skills before home projection", () => {
  for (const { report } of [sourceProbe, compiledProbe]) {
    expect(report.installNames).toEqual(sourceSkillNames());
    expect(report.profileSkillNames).toEqual(sourceSkillNames());
  }
  // Compare the production install phase's copies, not a second helper-only install.
  for (const name of sourceSkillNames().filter((name) => name !== "VSA")) {
    expectSameTree(tree(join(compiledProbe.work, "install-phase", ".soma", "skills", name)), tree(join(SKILLS_ROOT, name), true));
  }
  expect(readFileSync(join(compiledProbe.work, "install-phase", ".soma", "skills", "VSA", "SKILL.md"), "utf8")).toContain("name: VSA");
});

test("compiled Codex home projection and doctor use the embedded inventory", () => {
  const projectedSkills = (work: string) => new Map(
    [...tree(join(work, "install-phase", ".codex", "skills"))].filter(([path]) => !path.startsWith("soma/")).map(([path, bytes]) =>
      [path, Buffer.from(bytes.toString("utf8").replaceAll(work, "<work>"))] as const),
  );
  expectSameTree(projectedSkills(compiledProbe.work), projectedSkills(sourceProbe.work));
  // Missing inventory used to suppress portable skill files in both projection and doctor.
  expect([...projectedSkills(compiledProbe.work).keys()]).toContain("orienteer/SKILL.md");
  expect(compiledProbe.report.cleanFindings).toEqual(sourceProbe.report.cleanFindings);
  expect(compiledProbe.report.cleanFindings).toEqual([]);
  for (const { report } of [sourceProbe, compiledProbe]) {
    expect(report.codexTrustedRepo).toBe(report.defaultRepoPath);
  }
  expect(compiledProbe.report.driftFindings.some((finding) => finding.message.includes("skills/Memory/SKILL.md"))).toBe(true);
});

test("compiled Grok home projection fails at its known hook asset boundary", () => {
  expect(sourceProbe.report.grokError).toBeNull();
  expect(sourceProbe.report.grokSkillPaths).toContain("skills/Memory/SKILL.md");
  // This consumer does not read skills through the repo locator; its separate
  // runtime hook-asset reads fail loudly. Do not mistake that for empty success.
  expect(compiledProbe.report.grokError?.code).toBe("ENOENT");
  expect(compiledProbe.report.grokError?.path).toContain("soma-lifecycle.mjs");
});

test("only bundled-skill-source.ts loads the embedded skill text, and only dynamically", () => {
  // A static import anywhere would put ~550K of skill text on every invocation
  // that loads src/index.ts, hook hot paths included.
  const loaders = walk(join(REPO_ROOT, "src"))
    .filter((path) => /\.(?:ts|mts|mjs|js)$/u.test(path) && !path.endsWith(".generated.ts"))
    .filter((path) => readFileSync(path, "utf8").includes("bundled-skill-files.generated"))
    .map((path) => toPosixRelative(REPO_ROOT, path));
  expect(loaders).toEqual(["src/bundled-skill-source.ts"]);

  const source = readFileSync(join(REPO_ROOT, "src", "bundled-skill-source.ts"), "utf8");
  expect(source).toMatch(/await import\("\.\/bundled-skill-files\.generated"\)/u);
  expect(source).not.toMatch(/\bfrom\s*["']\.\/bundled-skill-files\.generated["']/u);
});
