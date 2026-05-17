/**
 * Bun discovery + pre-flight (soma#73 sage r1).
 *
 * Two callers in the install/adapter surfaces need the same logic:
 *   - `requireBunInPath` — installer pre-flight; throws + remediation
 *     when `env bun` cannot resolve from the substrate's later
 *     spawn environment
 *   - `resolveBunExecutable` — codex adapter; returns an explicit
 *     bun binary path to embed in the hook's runtime config
 *
 * Sage r1: the previous `process.versions.bun` shortcut bypassed the
 * `which bun` check when the installer happened to be running under
 * Bun. That proves nothing about whether `env bun` resolves at hook
 * fire time. Both probes now always invoke `which bun`.
 */
import { spawnSync } from "node:child_process";

/**
 * Locate the bun binary on PATH. Returns the resolved path, or null
 * when bun is unavailable.
 *
 * Always runs `which bun` — running under bun is NOT evidence that
 * a shebang-resolved `env bun` will succeed in the hook's later
 * spawn environment (different PATH, different shell, restricted
 * env via the substrate, etc.).
 */
export function locateBunOnPath(): string | null {
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  if (which.status !== 0) return null;
  const resolved = which.stdout.trim().split("\n")[0];
  return resolved.length > 0 ? resolved : null;
}

/**
 * Installer pre-flight. Throws with remediation when bun is not on
 * PATH; returns silently when it is.
 *
 * `SOMA_BUN_PATH` is accepted as an explicit override for unusual
 * deployments (CI sandboxes, etc.). The hook's shebang is still
 * `#!/usr/bin/env bun`; users with a non-PATH bun must keep the
 * override path resolvable when the hook fires.
 */
export function requireBunInPath(): void {
  if (process.env.SOMA_BUN_PATH) return;
  if (locateBunOnPath() !== null) return;
  throw new Error(
    [
      "soma adopt: Bun not found in PATH.",
      "",
      "Every substrate hook installed by soma runs under Bun (#!/usr/bin/env bun).",
      "Install Bun (https://bun.sh) and re-run, or set SOMA_BUN_PATH to an absolute path.",
    ].join("\n"),
  );
}

/**
 * Resolve a bun binary path for embedding in a hook's runtime
 * config. Order:
 *   1. `SOMA_BUN_PATH` env override
 *   2. `which bun`
 *   3. `process.execPath` when soma itself runs under Bun
 *      (last-resort fallback — keeps tests that set neither env
 *      nor PATH working when running via `bun test`)
 *
 * Throws when none resolve. Adopters should have called
 * `requireBunInPath` before getting here.
 */
export function resolveBunExecutable(): string {
  if (process.env.SOMA_BUN_PATH) return process.env.SOMA_BUN_PATH;
  const fromPath = locateBunOnPath();
  if (fromPath !== null) return fromPath;
  if ((process.versions as Record<string, string | undefined>).bun && process.execPath) {
    return process.execPath;
  }
  throw new Error("soma#73: unable to resolve a Bun executable for the codex hook config.");
}
