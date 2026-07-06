import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { defaultSomaHome } from "./paths";
import { defaultSomaRepoPath } from "./repo-path";
import { VSA_SKILL_NAME } from "./vsa-skill-installer";

const SKILLS_SUBPATH = "src/skills";

async function* walkFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

/** Directory names of the skills bundled in the repo under `src/skills`, sorted. */
export async function listBundledSkills(somaRepoPath = defaultSomaRepoPath()): Promise<string[]> {
  const root = join(resolve(somaRepoPath), SKILLS_SUBPATH);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export interface InstallBundledSkillsOptions {
  somaRepoPath?: string;
  homeDir?: string;
  somaHome?: string;
}

/**
 * Copy every bundled skill (`src/skills/<name>`) EXCEPT VSA into
 * `<somaHome>/skills/<name>`, so they enter the Soma catalog (SKILLS.md) and
 * `profile.skills`, and therefore project to every substrate through the
 * generic portable-skill loop (`projectableSkills`).
 *
 * VSA is excluded here: it has a dedicated versioned, drift-tracking installer
 * (`installVsaSkillProjection`) and is filtered out of `projectableSkills`, so
 * copying it here would be redundant and could fight that installer's baseline.
 *
 * Source files are copied verbatim (byte-identical) and overwritten on every
 * run, so the operation is idempotent. User-added files under a skill dir that
 * are not in the bundled source are left untouched. Returns the written paths.
 */
export async function installBundledSkillsIntoHome(options: InstallBundledSkillsOptions = {}): Promise<string[]> {
  const somaRepoPath = resolve(options.somaRepoPath ?? defaultSomaRepoPath());
  const somaHome = defaultSomaHome({ homeDir: options.homeDir, somaHome: options.somaHome });
  const written: string[] = [];
  for (const name of await listBundledSkills(somaRepoPath)) {
    if (name === VSA_SKILL_NAME) continue;
    const sourceDir = join(somaRepoPath, SKILLS_SUBPATH, name);
    const destDir = join(somaHome, "skills", name);
    for await (const absSource of walkFiles(sourceDir)) {
      const dest = join(destDir, relative(sourceDir, absSource));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, await readFile(absSource));
      written.push(dest);
    }
  }
  return written;
}
