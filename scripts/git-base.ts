/**
 * The Git base a ratchet check compares against. CI sets
 * `SOMA_BOUNDARIES_BASE_REF` to the PR's target commit (or the previous head
 * on a push); locally the branch is compared with its fork point.
 */
import { execFileSync } from "node:child_process";

/** CI supplies the exact base commit; locally compare the branch with its fork point. */
export function repositoryBaseRevision(root: string): string {
  return process.env.SOMA_BOUNDARIES_BASE_REF ?? execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** A repo file's JSON at the Git base, or null when the base has no such file (first landing). */
export function readJsonAtBase(root: string, path: string): unknown {
  try {
    const text = execFileSync("git", ["show", `${repositoryBaseRevision(root)}:${path}`], { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof Error && /does not exist|exists on disk, but not in/.test(error.message)) return null;
    throw error;
  }
}
