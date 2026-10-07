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
console.log(JSON.stringify({ names, explicitNames, customNames, rootErrors, emptyNames, vsaAction: vsa.action, algorithm }));
