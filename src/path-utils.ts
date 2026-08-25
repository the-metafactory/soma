import { statSync } from "node:fs";
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
 * `ARC_INVOCATION_CWD` before that `cd`.
 *
 * **One expression, two callers**, and deliberately so. `soma export --out`
 * learned this in [#315](https://github.com/the-metafactory/soma/issues/315);
 * `soma graph close`'s probe base never did, so under an arc install every
 * declared probe resolved against the install tree and a close receipt named a
 * checkout the operator had never opened
 * ([#662](https://github.com/the-metafactory/soma/issues/662)). Two `??`
 * expressions of one rule is the shape #579 already cost this module once.
 *
 * **What this value actually states, and what it does not.** arc's generator
 * writes `export ARC_INVOCATION_CWD="${ARC_INVOCATION_CWD:-$(pwd)}"` — the `:-`
 * deliberately preserves an outer value so that nested arc CLIs agree on one
 * directory. So it names where the **outermost** arc caller stood, not where
 * *this* process was invoked. An arc-launched tool that starts in one repo,
 * `cd`s to another and runs `soma graph close` there gets the first repo's tree:
 * #662 one level up. That is a real residual limit, and it is sharper than it
 * looks, because for the three ungated probes this same value is the containment
 * boundary — so under nesting a probe may be confined to a tree that is not the
 * one being closed. Detection still holds (the receipt names the directory and
 * its HEAD, so a substituted tree is visible rather than silent); prevention does
 * not. Fixing it needs a way for the caller to state the tree per invocation,
 * which is a feature and tracked separately.
 *
 * **Only an absolute, existing directory is trusted.** A relative or empty value
 * would resolve against `process.cwd()` — the very directory the shim moved —
 * producing a third location that is neither the caller's nor the install tree's.
 * A value naming something that is not a directory is not a statement of where
 * anyone stood either, and under an arc install the base used to be pinned while
 * this makes it environment-settable, so it gets a floor rather than the benefit
 * of the doubt (#662 review m2). Note what the floor does *not* do: `/` is an
 * existing directory and still passes, exactly as `cd / && soma graph close`
 * always could. This closes a new way in, not an old one.
 *
 * @param env Environment to read. Injected so a test can state the launcher's
 *   half of the contract without mutating the process's own.
 */
export function invocationCwd(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const declared = env.ARC_INVOCATION_CWD;
  if (declared !== undefined && isAbsolute(declared) && isDirectory(declared)) return resolve(declared);
  return resolve(process.cwd());
}

/** Best-effort: an unreadable or missing path is simply not a directory we will resolve against. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
