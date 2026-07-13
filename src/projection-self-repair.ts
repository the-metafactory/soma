import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { isInsidePath } from "./path-utils";

/**
 * Deterministic (no-LLM, no-network) self-repair for projected substrate
 * artifacts (soma#460). Portable core: it operates on an explicit list of
 * artifact descriptors so it holds no substrate knowledge — each substrate
 * adapter supplies its own descriptors (see
 * `adapters/claude-code/projection-self-repair.ts`).
 *
 * Two passes, both confined to the substrate home:
 *
 * 1. exec-bit restore — a projected script the substrate execs directly via
 *    its shebang silently breaks if it loses its exec bit (a Write recreates a
 *    file 0644). Re-add the execute bit. CONTAINMENT-GUARDED: an artifact whose
 *    real path escapes the substrate home (e.g. a symlink pointing outside) is
 *    refused, never chmod'd.
 * 2. drift report — flag an artifact whose on-disk bytes no longer match a
 *    fresh projection, by checksum. Reported only; nothing is rewritten here.
 *
 * A healthy projection produces an empty result (no healed/drifted/skipped, no
 * findings).
 */

/** A projected artifact the self-repair pass can heal (exec bit) and drift-check. */
export interface ProjectedArtifact {
  /** Absolute path of the projected file under the substrate home. */
  path: string;
  /**
   * True when the substrate execs the file directly via its shebang (a script
   * registered as a command), so a lost exec bit silently breaks it. False for
   * bun-invoked hooks, whose exec bit the runtime ignores.
   */
  directExec: boolean;
  /**
   * Fresh in-memory projection of the file's expected bytes, when the artifact is a
   * pure function of its projection inputs. Present ⇒ eligible for drift
   * detection; absent ⇒ exec-bit repair only.
   */
  expected?: string;
}

export type ProjectionRepairFindingKind = "exec-bit-restored" | "content-drift" | "containment-skip";

export interface ProjectionRepairFinding {
  kind: ProjectionRepairFindingKind;
  severity: "info" | "warning";
  path: string;
  message: string;
}

export interface ProjectionRepairResult {
  /** Paths whose exec bit was restored (files modified). */
  healed: string[];
  /** Paths whose on-disk bytes drifted from the fresh projection (reported, not changed). */
  drifted: string[];
  /** Paths refused because they resolve outside the substrate home (never touched). */
  skipped: string[];
  findings: ProjectionRepairFinding[];
}

const OWNER_EXEC = 0o100;
const ALL_EXEC = 0o111;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function repairProjectedArtifacts(input: {
  substrateHome: string;
  artifacts: readonly ProjectedArtifact[];
}): Promise<ProjectionRepairResult> {
  const result: ProjectionRepairResult = { healed: [], drifted: [], skipped: [], findings: [] };
  if (input.artifacts.length === 0) return result;

  // Containment root: the REAL path of the substrate home (symlinks resolved on
  // both sides so the isInsidePath check compares real inodes, not link names).
  // A home that does not resolve (never installed) means there is nothing to
  // repair.
  let root: string;
  try {
    root = await realpath(input.substrateHome);
  } catch {
    return result;
  }

  for (const artifact of input.artifacts) {
    let real: string;
    try {
      real = await realpath(artifact.path);
    } catch {
      // Missing artifact (ENOENT) — a not-installed/removed projection is the
      // doctor's concern, not self-repair's. Skip silently.
      continue;
    }
    // Refuse anything that resolves outside the substrate home. realpath has
    // already followed every symlink, so a link inside the home pointing out is
    // caught here BEFORE any chmod could touch the escaped target.
    if (!isInsidePath(real, root)) {
      result.skipped.push(artifact.path);
      result.findings.push({
        kind: "containment-skip",
        severity: "warning",
        path: artifact.path,
        message: `Projected artifact resolves outside the substrate home; refused: ${artifact.path}.`,
      });
      continue;
    }

    if (artifact.directExec) {
      // Operate on an opened HANDLE (fstat + fchmod), not the pathname, so the
      // mode change binds to the inode we open here rather than re-resolving the
      // path at chmod time. O_NOFOLLOW refuses a final-component symlink
      // substituted after the realpath check. This NARROWS the check→mutate race
      // (it does not fully close it — a parent-component swap between realpath and
      // open would need per-component openat(2), out of scope for a single-user
      // substrate home); the realpath containment check above is the primary guard.
      let handle;
      try {
        handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        // Vanished or replaced by a symlink between realpath and open — refuse.
        continue;
      }
      try {
        const info = await handle.stat();
        if ((info.mode & OWNER_EXEC) === 0) {
          await handle.chmod(info.mode | ALL_EXEC);
          result.healed.push(artifact.path);
          result.findings.push({
            kind: "exec-bit-restored",
            severity: "info",
            path: artifact.path,
            message: `Restored the exec bit on a direct-exec projected script: ${artifact.path}.`,
          });
        }
      } finally {
        await handle.close();
      }
    }

    if (artifact.expected !== undefined) {
      const onDisk = await readFile(real, "utf8");
      if (sha256(onDisk) !== sha256(artifact.expected)) {
        result.drifted.push(artifact.path);
        result.findings.push({
          kind: "content-drift",
          severity: "warning",
          path: artifact.path,
          message: `Projected artifact drifted from its fresh projection: ${artifact.path}. Run \`soma reproject\` to restore.`,
        });
      }
    }
  }

  return result;
}
