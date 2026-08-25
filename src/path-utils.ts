import { isAbsolute, relative, resolve } from "node:path";

export function isInsidePath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The directory the operator ran soma *from* — which is not always
 * `process.cwd()`.
 *
 * An arc-generated launcher shim `cd`s into the install tree before `exec`, so
 * inside the process `process.cwd()` is soma's own checkout rather than the
 * caller's directory. The shim exports the caller's directory as
 * `ARC_INVOCATION_CWD` before that `cd`, and it is the only value left that
 * still knows where the operator actually stood.
 *
 * **One expression, two callers**, and deliberately so. `soma export --out`
 * learned this in [#315](https://github.com/the-metafactory/soma/issues/315);
 * `soma graph close`'s probe base never did, so under an arc install every
 * declared probe resolved against the install tree and a close receipt named a
 * checkout the operator had never opened
 * ([#662](https://github.com/the-metafactory/soma/issues/662)) — including a
 * `git cat-file` that reported an artifact "absent" while it sat in the tree the
 * close was run from. Two `??` expressions of one rule is the shape #579 already
 * cost this module once, so the rule lives here and both callers read it.
 *
 * **Only an absolute value is trusted.** A relative or empty `ARC_INVOCATION_CWD`
 * would resolve against `process.cwd()` — the very directory the shim moved —
 * producing a third location that is neither the caller's nor the install tree's.
 * Falling back is the honest answer: the variable is a launcher's statement of
 * where it was called from, and a relative one is not one.
 *
 * @param env Environment to read. Injected so a test can state the launcher's
 *   half of the contract without mutating the process's own.
 */
export function invocationCwd(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const declared = env.ARC_INVOCATION_CWD;
  if (declared !== undefined && isAbsolute(declared)) return resolve(declared);
  return resolve(process.cwd());
}
