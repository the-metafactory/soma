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
 * still in the bundled copy would lose them the first time this install
 * overwrites it — an irreversible loss of configuration they never agreed to
 * (Sage review).
 *
 * So: before the first overwrite, if the home's copy differs from the bundled
 * source and no overlay exists yet, the existing content becomes the overlay.
 * It is preserved verbatim rather than filtered, because the loader reads the
 * overlay first and a row that duplicates a shipped one simply wins — the same
 * outcome the adopter had. Runs once by construction: afterwards the overlay
 * exists, so the branch is skipped.
 */
async function preserveCapabilityTableAsOverlay(destDir: string, sourceFile: string): Promise<string | undefined> {
  const bundled = join(destDir, "references", "capabilities.md");
  const overlay = join(destDir, "references", "capabilities.local.md");

  const [existing, incoming] = await Promise.all([
    readFile(bundled, "utf8").catch(() => undefined),
    readFile(sourceFile, "utf8").catch(() => undefined),
  ]);
  if (existing === undefined || incoming === undefined || existing === incoming) return undefined;

  const overlayExists = await readFile(overlay, "utf8").then(() => true).catch(() => false);
  if (overlayExists) return undefined;

  await writeFile(
    overlay,
    `<!--
`
      + `  Preserved by \`soma install\` (soma#574): these rows were in the bundled
`
      + `  capabilities.md, which install now overwrites on every run. This file is
`
      + `  yours — install never touches it — and it is read BEFORE the bundled
`
      + `  table, so a row here wins on any name collision.
`
      + `-->

`
      + existing,
    "utf8",
  );
  return overlay;
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
      const preserved = await preserveCapabilityTableAsOverlay(
        destDir,
        join(sourceDir, "references", "capabilities.md"),
      );
      if (preserved !== undefined) written.push(preserved);
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
