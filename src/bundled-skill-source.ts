import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isEnoent } from "./fs-errors";
import { defaultSomaRepoPath } from "./repo-path";

/**
 * The one reader for skill content bundled under `src/skills` (orienteer node #612).
 *
 * For Soma's OWN repo (no path given, or `defaultSomaRepoPath()`) content comes
 * from `bundled-skill-files.generated.ts`, which bun inlines at bundle time.
 * Reading `<defaultSomaRepoPath()>/src/skills` instead breaks under
 * `bun build --compile`: `import.meta.dirname` resolves into the virtual
 * `/$bunfs` root, which holds no files, and every caller treats a missing tree
 * as "no skills" — so a compiled `soma install` wrote no skill content and
 * reported success. Source and compiled runs take the same path here, so the
 * suite exercises what the binary ships.
 *
 * Any OTHER repo path (test fixtures, a staged runtime copy) is read from disk.
 */

const SKILLS_SUBPATH = "src/skills";

/**
 * One file of a bundled skill. `path` is posix and relative to the skill dir.
 * Embedded text is a string; disk files retain their original bytes.
 */
export interface BundledSkillFile {
  path: string;
  content: string | Buffer;
}

const byPath = (a: BundledSkillFile, b: BundledSkillFile): number => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function readsEmbeddedTree(somaRepoPath: string | undefined): boolean {
  return somaRepoPath === undefined || resolve(somaRepoPath) === defaultSomaRepoPath();
}

async function embeddedFiles(): Promise<Readonly<Record<string, string>>> {
  // Dynamic on purpose: src/index.ts re-exports this module's consumers and the
  // hook hot paths load that barrel, so a static import would read all of the
  // skill text on every hook invocation. `bun build --compile` still inlines it.
  return (await import("./bundled-skill-files.generated")).BUNDLED_SKILL_FILES;
}

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

/** Directory names of the bundled skills, sorted. `[]` when the repo ships none. */
export async function bundledSkillNames(somaRepoPath?: string): Promise<string[]> {
  if (readsEmbeddedTree(somaRepoPath)) {
    const names = new Set(Object.keys(await embeddedFiles()).map((path) => path.slice(0, path.indexOf("/"))));
    return [...names].sort();
  }
  const root = join(resolve(somaRepoPath ?? ""), SKILLS_SUBPATH);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every file of bundled skill `name`, sorted by path, or `undefined` when the
 * repo does not ship that skill.
 */
export async function readBundledSkill(name: string, somaRepoPath?: string): Promise<BundledSkillFile[] | undefined> {
  if (readsEmbeddedTree(somaRepoPath)) {
    const prefix = `${name}/`;
    const files = Object.entries(await embeddedFiles())
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => ({ path: path.slice(prefix.length), content }))
      .sort(byPath);
    return files.length > 0 ? files : undefined;
  }
  const skillDir = join(resolve(somaRepoPath ?? ""), SKILLS_SUBPATH, name);
  const files: BundledSkillFile[] = [];
  try {
    for await (const absPath of walkFiles(skillDir)) {
      files.push({ path: relative(skillDir, absPath).split(sep).join("/"), content: await readFile(absPath) });
    }
  } catch (error) {
    if (isEnoent(error) && files.length === 0) return undefined;
    throw error;
  }
  return files.sort(byPath);
}

/** One text file of a bundled skill; throws when the skill or the file is absent. */
export async function readBundledSkillFile(name: string, path: string, somaRepoPath?: string): Promise<string> {
  if (readsEmbeddedTree(somaRepoPath)) {
    const content = (await embeddedFiles())[`${name}/${path}`];
    if (content !== undefined) return content;
  } else {
    try {
      return await readFile(join(resolve(somaRepoPath ?? ""), SKILLS_SUBPATH, name, path), "utf8");
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  throw new Error(`Bundled skill file not found: ${SKILLS_SUBPATH}/${name}/${path}`);
}
