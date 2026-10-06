import { resolve } from "node:path";

/**
 * The Soma checkout this module was loaded from. Inside a `bun build --compile`
 * binary it resolves into the virtual `/$bunfs` root, which holds no real files,
 * so never read repo CONTENT through it — bundled skills are embedded and read
 * via src/bundled-skill-source.ts instead (orienteer node #612).
 */
export function defaultSomaRepoPath(): string {
  return resolve(import.meta.dirname, "..");
}
