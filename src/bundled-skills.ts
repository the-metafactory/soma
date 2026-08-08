import { createHash } from "node:crypto";
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
 * Skipped only when there is nothing new to save: the home copy already matches
 * the incoming bundle, or some existing backup already holds exactly this
 * content. Otherwise a NUMBERED sibling is written and no backup is ever
 * overwritten.
 *
 * Saving more than once matters (Sage review). Skipping whenever any backup existed
 * made the promise false from the second upgrade onward: an adopter who kept
 * editing `capabilities.md` — not yet having learned that rows moved — had
 * those later edits overwritten with nothing kept, which is the silent loss
 * this function exists to prevent.
 */
async function backupCustomisedCapabilityTable(destDir: string, sourceFile: string): Promise<string | undefined> {
  const references = join(destDir, "references");
  const bundled = join(references, "capabilities.md");

  const [existing, incoming] = await Promise.all([
    readFile(bundled, "utf8").catch(() => undefined),
    readFile(sourceFile, "utf8").catch(() => undefined),
  ]);
  if (existing === undefined || incoming === undefined || existing === incoming) return undefined;

  // Build the payload FIRST, then compare stored backups against it exactly
  // (Sage review). Matching on `endsWith(existing)` treated any backup merely
  // ending with this table as already-saved, and then skipped the save — losing
  // the table this exists to keep. An exact comparison has no such edge.
  const payload = "<!--\n"
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
    + existing;

  // Named by a short hash of the content, so an unchanged table lands on the
  // same name and costs one stat rather than a walk of every prior backup.
  // Eight hex characters can collide, so the name is a hint and the content is
  // the decision.
  const digest = createHash("sha256").update(existing, "utf8").digest("hex").slice(0, 8);

  let target: string | undefined;
  for (let attempt = 1; target === undefined && attempt < 100; attempt += 1) {
    const candidate = join(
      references,
      attempt === 1 ? `capabilities.pre-upgrade.${digest}.md` : `capabilities.pre-upgrade.${digest}.${attempt}.md`,
    );
    const held = await readFile(candidate, "utf8").catch(() => undefined);
    if (held === undefined) target = candidate;
    else if (held === payload) return undefined;
  }

  // No free slot: refuse rather than write. Falling back to a colliding name
  // would overwrite a backup that may be the only copy of someone's table —
  // failing the install loudly is the lesser harm, and 99 distinct tables
  // colliding on one digest means something is wrong that a silent overwrite
  // would bury.
  if (target === undefined) {
    throw new Error(
      `Cannot back up ${bundled}: every candidate name for digest ${digest} is taken. `
        + `Move or remove some capabilities.pre-upgrade.${digest}*.md files and re-run.`,
    );
  }

  await writeFile(target, payload, "utf8");

  return target;
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
