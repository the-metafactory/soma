import { bootstrapSomaHome } from "../../src/soma-home";
import { prepareSomaInstallSkillContext } from "../../src/install";
import { SomaInstallExecution } from "../../src/installation-executor";
import { installCodexHomeProjection, buildGrokHomeProjection } from "../../src/home-projection";
import { diagnoseContentCompareDrift } from "../../src/adapters/content-compare-doctor";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importAlgorithm } from "../../src/algorithm-importer";
import { installBundledSkillsIntoHome, listBundledSkills } from "../../src/bundled-skills";
import { installVsaSkill } from "../../src/vsa-skill-installer";
import { defaultSomaRepoPath } from "../../src/repo-path";

// The compile regression runs this fixture both as source and as a binary.
const work = process.argv[2] ?? "";
const names = await listBundledSkills();
const somaRepoPath = defaultSomaRepoPath();
const explicitNames = await listBundledSkills(somaRepoPath);
const customRepo = join(work, "custom-repo");
const customNames = await listBundledSkills(customRepo);
const rootErrors: Record<string, string | null> = {};
for (const label of ["missing-repo", "missing-skills", "not-directory"]) {
  const repo = join(work, label);
  for (const action of ["list", "install"]) {
    const key = `${label}:${action}`;
    try {
      if (action === "list") await listBundledSkills(repo);
      else await installBundledSkillsIntoHome({ somaHome: join(work, `${label}-home`), somaRepoPath: repo });
      rootErrors[key] = null;
    } catch (error) {
      rootErrors[key] = (error as NodeJS.ErrnoException).code ?? String(error);
    }
  }
}
const emptyNames = await listBundledSkills(join(work, "empty-repo"));
await installBundledSkillsIntoHome({ somaHome: join(work, "home") });
await installBundledSkillsIntoHome({ somaHome: join(work, "explicit-home"), somaRepoPath });
await installBundledSkillsIntoHome({ somaHome: join(work, "custom-home"), somaRepoPath: customRepo });
const vsa = await installVsaSkill({ somaHome: join(work, "home") });
await installVsaSkill({ somaHome: join(work, "explicit-home"), somaRepoPath });
let algorithm = "ok";
try {
  await importAlgorithm({ paiAlgorithmDir: join(work, "pai"), somaHome: join(work, "algorithm-home") });
} catch (error) {
  algorithm = String(error);
}
// Execute the production install skill phase independently of source-runtime staging.
const installHomeDir = join(work, "install-phase");
const installedHome = await bootstrapSomaHome({ homeDir: installHomeDir });
const prepared = await prepareSomaInstallSkillContext(new SomaInstallExecution("codex"), installedHome, { homeDir: installHomeDir });
const installNames = prepared.bundledSkillNames;
const profileSkillNames = prepared.projectionContext.profile.skills.map((skill) => skill.name).sort();
const input = { ...prepared.projectionContext, bundledSkillNames: installNames };
const projection = await installCodexHomeProjection(input, { homeDir: installHomeDir });
const doctorOptions = { substrate: "codex" as const, homeDir: installHomeDir, somaHome: installedHome.somaHome };
const cleanFindings = await diagnoseContentCompareDrift(doctorOptions);
const memorySkill = join(projection.rootDir, "skills", "Memory", "SKILL.md");
const originalMemorySkill = await readFile(memorySkill);
await writeFile(memorySkill, "<!-- soma:managed -->\n# stale compiled skill\n");
const driftFindings = await diagnoseContentCompareDrift(doctorOptions);
await writeFile(memorySkill, originalMemorySkill);
const codexTrustedRepo = (JSON.parse(await readFile(join(projection.rootDir, "hooks", "soma-lifecycle.config.json"), "utf8")) as { trustedSomaRepo: string }).trustedSomaRepo;
let grokError: { code?: string; path?: string } | null = null;
let grokSkillPaths: string[] = [];
try {
  const grok = buildGrokHomeProjection(input, { homeDir: installHomeDir });
  grokSkillPaths = grok.bundle.files.filter((file) => file.path.startsWith("skills/")).map((file) => file.path);
} catch (error) {
  const fault = error as NodeJS.ErrnoException;
  grokError = { code: fault.code, path: fault.path };
}
console.log(JSON.stringify({ names, explicitNames, customNames, rootErrors, emptyNames, vsaAction: vsa.action, algorithm,
  installNames, profileSkillNames, cleanFindings, driftFindings, grokError, grokSkillPaths, defaultRepoPath: somaRepoPath, codexTrustedRepo }));
