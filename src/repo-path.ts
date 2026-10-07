import { resolve } from "node:path";

/**
 * The Soma checkout this module was loaded from. Inside a `bun build --compile`
 * binary it resolves into the virtual `/$bunfs` root, which holds no real files,
 * so bundled skill readers use embedded content via src/bundled-skill-source.ts
 * instead (orienteer node #612). This is not a compiled runtime source locator:
 * install's immutable runtime staging still requires a real source tree and
 * fails loudly when passed this virtual path. See test/repo-path-compile.test.ts.
 */
export function defaultSomaRepoPath(): string {
  return resolve(import.meta.dirname, "..");
}
