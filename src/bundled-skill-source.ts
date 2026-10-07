import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isEnoent } from "./fs-errors";
import { comparePaths, toPosixRelative, walkFilesAsync } from "./fs-walk";
import { defaultSomaRepoPath } from "./repo-path";

/**
 * The one reader for skill content bundled under `src/skills` (orienteer node #612).
 *
 * For Soma's OWN repo (no path given, or `defaultSomaRepoPath()`) content comes
 * from `bundled-skill-files.generated.ts`, which bun inlines at bundle time.
 * Reading `<defaultSomaRepoPath()>/src/skills` instead breaks under
 * `bun build --compile`: `import.meta.dirname` resolves into the virtual
 * `/$bunfs` root, which holds no files, and every caller treats a missing tree
 * as "no skills", letting the skill APIs succeed without writing content.
 * Source and compiled runs take the same path here. The CLI's separate
 * source-runtime staging requirement is covered in repo-path-compile.test.ts;
 * embedded skills alone do not make compiled CLI installation work.
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

const byPath = (a: BundledSkillFile, b: BundledSkillFile): number => comparePaths(a.path, b.path);

function readsEmbeddedTree(somaRepoPath?: string): boolean {
  return somaRepoPath === undefined || resolve(somaRepoPath) === defaultSomaRepoPath();
}

function diskSkillsRoot(somaRepoPath = defaultSomaRepoPath()): string {
  return join(resolve(somaRepoPath), SKILLS_SUBPATH);
}

async function embeddedFiles(): Promise<Readonly<Record<string, string>>> {
  // Dynamic on purpose: src/index.ts re-exports this module's consumers and the
  // hook hot paths load that barrel, so a static import would read all of the
  // skill text on every hook invocation. `bun build --compile` still inlines it.
  return (await import("./bundled-skill-files.generated")).BUNDLED_SKILL_FILES;
}

/** Sorted skill names; an empty tree returns `[]`, but an invalid explicit root throws. */
export async function bundledSkillNames(somaRepoPath?: string): Promise<string[]> {
  if (readsEmbeddedTree(somaRepoPath)) {
    const names = new Set(Object.keys(await embeddedFiles()).map((path) => path.slice(0, path.indexOf("/"))));
    return [...names].sort();
  }
  const entries = await readdir(diskSkillsRoot(somaRepoPath), { withFileTypes: true });
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
  const skillDir = join(diskSkillsRoot(somaRepoPath), name);
  const files: BundledSkillFile[] = [];
  try {
    for await (const absPath of walkFilesAsync(skillDir)) {
      files.push({ path: toPosixRelative(skillDir, absPath), content: await readFile(absPath) });
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
      return await readFile(join(diskSkillsRoot(somaRepoPath), name, path), "utf8");
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  throw new Error(`Bundled skill file not found: ${SKILLS_SUBPATH}/${name}/${path}`);
}
