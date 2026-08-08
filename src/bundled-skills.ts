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
 * run, so the operation is idempotent. Principal-added files under a skill dir
 * that are not in the bundled source are left untouched. Returns both the
 * written paths and `names` (every `src/skills/*` dir, VSA included) so the
 * caller can scope the portable-skill loop without re-scanning `src/skills`.
 */
/**
 * The capability table is the one bundled file an adopter was previously
 * expected to EDIT, and soma#574 moves that role to a sibling
 * `capabilities.local.md` the install never touches. Anyone whose rows are
 * still in the bundled copy would otherwise lose them the first time this
 * install overwrites it.
 *
 * So the prior content is copied aside — to `capabilities.pre-upgrade.md`,
 * which NOTHING reads — before the overwrite. Deliberately not into the
 * overlay (Sage review): the overlay is read first and wins, so promoting an
 * older bundled table there would reinstate whatever it contained, including
 * the PAI-era rows this change exists to replace. An upgrade cannot tell an
 * adopter's edits from last release's defaults, and guessing wrong in that
 * direction silently undoes the upgrade for every existing install.
 *
 * A backup answers the real risk — irreversible loss — without touching
 * precedence. Promoting anything from it is the principal's call, which is the
 * only place the "is this mine or last release's?" question can actually be
 * answered.
 *
 * Skipped when the content already matches the incoming bundle, and never
 * overwrites an existing backup.
 */
async function backupCustomisedCapabilityTable(destDir: string, sourceFile: string): Promise<string | undefined> {
  const bundled = join(destDir, "references", "capabilities.md");
  const backup = join(destDir, "references", "capabilities.pre-upgrade.md");

  const [existing, incoming] = await Promise.all([
    readFile(bundled, "utf8").catch(() => undefined),
    readFile(sourceFile, "utf8").catch(() => undefined),
  ]);
  if (existing === undefined || incoming === undefined || existing === incoming) return undefined;

  const backupExists = await readFile(backup, "utf8").then(() => true).catch(() => false);
  if (backupExists) return undefined;

  await writeFile(
    backup,
    "<!--\n"
      + "  Saved by `soma install` before overwriting capabilities.md (soma#574).\n"
      + "  NOTHING reads this file. It exists so an upgrade cannot destroy rows you\n"
      + "  added to the bundled table back when that was where rows went.\n"
      + "\n"
      + "  To keep any of them, copy those rows into `capabilities.local.md` — that\n"
      + "  file is yours, install never touches it, and it is read BEFORE the bundled\n"
      + "  table so your row wins on a name collision. Copy only what you added:\n"
      + "  everything else here is a previous release's defaults, and reinstating\n"
      + "  those would undo the upgrade.\n"
      + "-->\n\n"
      + existing,
    "utf8",
  );
  return backup;
}

export async function installBundledSkillsIntoHome(
  options: InstallBundledSkillsOptions = {},
): Promise<{ names: string[]; written: string[] }> {
  const somaRepoPath = resolve(options.somaRepoPath ?? defaultSomaRepoPath());
  const somaHome = defaultSomaHome({ homeDir: options.homeDir, somaHome: options.somaHome });
  const names = await listBundledSkills(somaRepoPath);
  const written: string[] = [];
  for (const name of names) {
    if (name === VSA_SKILL_NAME) continue;
    const sourceDir = join(somaRepoPath, SKILLS_SUBPATH, name);
    const destDir = join(somaHome, "skills", name);
    if (name === "the-algorithm") {
      const backup = await backupCustomisedCapabilityTable(
        destDir,
        join(sourceDir, "references", "capabilities.md"),
      );
      if (backup !== undefined) written.push(backup);
    }
    for await (const absSource of walkFiles(sourceDir)) {
      const dest = join(destDir, relative(sourceDir, absSource));
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, await readFile(absSource));
      written.push(dest);
    }
  }
  return { names, written };
}
