import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { comparePaths, toPosixRelative, walkFiles as walk } from "../src/fs-walk";

/**
 * Regression guard for orienteer node #612: bundled skill content must survive
 * `bun build --compile`.
 *
 * `defaultSomaRepoPath()` is `resolve(import.meta.dirname, "..")`. Inside a
 * compiled binary that is Bun's virtual `/$bunfs` root, which holds no real
 * files — so reading `src/skills` from it found nothing, and the readers were
 * built to swallow exactly that: `listBundledSkills()` returned `[]`, the
 * bundled-skill install copied nothing, and the VSA installer took its
 * `no-source` branch. These APIs could report success without writing content.
 * This proves a skill-reader defect, not successful compiled CLI installation:
 * the current CLI fails earlier while staging its source-based runtime.
 *
 * The helper binary below isolates bundled-skill APIs and compares their output
 * with the checkout byte for byte. It does not stand in for the shipped CLI.
 * We separately compile src/cli.ts, exercise Algorithm import, and run the
 * failing install command: immutable runtime staging still needs a real source
 * tree before it reaches the repaired skill readers. That separate limitation
 * must not be described as a successful compiled CLI install.
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
      `const rootErrors: Record<string, string | null> = {};`,
      `for (const label of ["missing-repo", "missing-skills", "not-directory"]) {`,
      `  const repo = join(work, label);`,
      `  for (const action of ["list", "install"]) {`,
      `    const key = label + ":" + action;`,
      `    try {`,
      `      if (action === "list") await listBundledSkills(repo);`,
      `      else await installBundledSkillsIntoHome({ somaHome: join(work, label + "-home"), somaRepoPath: repo });`,
      `      rootErrors[key] = null;`,
      `    } catch (error) { rootErrors[key] = (error as NodeJS.ErrnoException).code ?? String(error); }`,
      `  }`,
      `}`,
      `const emptyNames = await listBundledSkills(join(work, "empty-repo"));`,
      `await installBundledSkillsIntoHome({ somaHome: join(work, "home") });`,
      `await installBundledSkillsIntoHome({ somaHome: join(work, "explicit-home"), somaRepoPath });`,
      `await installBundledSkillsIntoHome({ somaHome: join(work, "custom-home"), somaRepoPath: customRepo });`,
      `const vsa = await installVsaSkill({ somaHome: join(work, "home") });`,
      `await installVsaSkill({ somaHome: join(work, "explicit-home"), somaRepoPath });`,
      `let algorithm = "ok";`,
      `try { await importAlgorithm({ paiAlgorithmDir: join(work, "pai"), somaHome: join(work, "algorithm-home") }); }`,
      `catch (error) { algorithm = String(error); }`,
      `console.log(JSON.stringify({ names, explicitNames, customNames, rootErrors, emptyNames, vsaAction: vsa.action, algorithm }));`,
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
  cliBinary = join(workRoot, "soma");
  const cliBuild = spawnSync(process.execPath, ["build", "--compile", join(REPO_ROOT, "src", "cli.ts"), "--outfile", cliBinary], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (cliBuild.status !== 0) throw new Error(`CLI bun build --compile failed:\n${cliBuild.stdout}\n${cliBuild.stderr}`);
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
  const { report, work } = compiledProbe;

  expect(report.customNames).toEqual(["fixture-skill"]);
  const installed = tree(join(work, "custom-home", "skills"));
  const expected = tree(join(work, "custom-repo", "src", "skills"));
  expect([...installed.keys()]).toEqual([...expected.keys()]);
  for (const [path, bytes] of expected) {
    expect({ path, same: installed.get(path)?.equals(bytes) }).toEqual({ path, same: true });
  }
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
  const disk = [...tree(SKILLS_ROOT, true)].filter(([path]) => path.includes("/"));
  expect(Object.keys(BUNDLED_SKILL_FILES).sort()).toEqual(disk.map(([path]) => path));
  // A text import decodes UTF-8, so a non-UTF-8 asset (or a BOM) would ship altered. Fail here instead.
  for (const [path, bytes] of disk) {
    expect({ path, same: Buffer.from(BUNDLED_SKILL_FILES[path] ?? "", "utf8").equals(bytes) }).toEqual({ path, same: true });
  }
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

test("default repo path consumers stay inventoried for compiled coverage", () => {
  const consumers = walk(join(REPO_ROOT, "src"))
    .filter((path) => path.endsWith(".ts") && !path.endsWith("repo-path.ts"))
    .filter((path) => readFileSync(path, "utf8").includes("defaultSomaRepoPath"))
    .map((path) => toPosixRelative(REPO_ROOT, path))
    .sort();
  // The helper exercises bundled-skill-source and VSA; the real CLI import
  // exercises algorithm-importer (which no longer uses the default repo path).
  // home-projection reaches embedded VSA; install's staging failure is above.
  // Adapter/doctor consumers use the path as hook configuration metadata.
  // A new consumer must be assessed instead of trusting the repo-path comment.
  expect(consumers).toEqual([
    "src/adapters/codex/adapter.ts",
    "src/adapters/content-compare-doctor.ts",
    "src/adapters/grok/adapter.ts",
    "src/bundled-skill-source.ts",
    "src/home-projection.ts",
    "src/install.ts",
    "src/vsa-skill-installer.ts",
  ]);
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
