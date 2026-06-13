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
import { tmpdir } from "node:os";
import { sep } from "node:path";

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
 * True when `execPath` points at an ephemeral Bun binary that will not
 * survive a reboot, so it must never be embedded in a persistent hook
 * command (soma#316).
 *
 * When Bun runs a single script (`bun run …`) or as a standalone
 * compiled executable, it extracts its runtime to a temp directory
 * named like `/tmp/bun-node-<hash>/bun`. The reporter's
 * `soma install claude-code --apply` embedded exactly such a path into
 * `settings.json`; it works until the temp dir is cleaned and then the
 * hook silently breaks. Either a `bun-node-*` path segment or any
 * location under the OS temp dir is treated as ephemeral.
 */
export function isEphemeralBunPath(execPath: string): boolean {
  if (!execPath) return false;
  if (execPath.split(/[/\\]/).some((segment) => segment.startsWith("bun-node-"))) {
    return true;
  }
  const tmp = tmpdir();
  const tmpPrefix = tmp.endsWith(sep) ? tmp : tmp + sep;
  return execPath === tmp || execPath.startsWith(tmpPrefix);
}

/**
 * Pure resolution core (testable without touching the real env/PATH).
 * Order:
 *   1. `SOMA_BUN_PATH` override
 *   2. `which bun` (PATH)
 *   3. `process.execPath` when running under Bun — but only when it is a
 *      durable path. An ephemeral `/tmp/bun-node-<hash>/bun` is rejected
 *      (soma#316): embedding it would break the hook after a reboot, so
 *      we fail loudly with remediation instead.
 *
 * Throws when none resolve.
 */
export function chooseBunExecutable(inputs: {
  somaBunPath?: string;
  fromPath: string | null;
  runningUnderBun: boolean;
  execPath: string;
}): string {
  if (inputs.somaBunPath) return inputs.somaBunPath;
  if (inputs.fromPath !== null) return inputs.fromPath;
  if (inputs.runningUnderBun && inputs.execPath && !isEphemeralBunPath(inputs.execPath)) {
    return inputs.execPath;
  }
  const ephemeral = Boolean(inputs.execPath) && isEphemeralBunPath(inputs.execPath);
  throw new Error(
    [
      "soma#73/#316: unable to resolve a durable Bun executable for the hook config.",
      "",
      ephemeral
        ? `The only Bun found (${inputs.execPath}) is an ephemeral extraction that will not survive a reboot.`
        : "Bun could not be located on PATH.",
      "Install Bun (https://bun.sh) so `which bun` resolves, or set SOMA_BUN_PATH to an absolute, persistent bun path.",
    ].join("\n"),
  );
}

/**
 * Resolve a bun binary path for embedding in a hook's runtime config.
 * Thin wrapper over {@link chooseBunExecutable} that reads the real
 * environment. Adopters should have called `requireBunInPath` before
 * getting here.
 */
export function resolveBunExecutable(): string {
  return chooseBunExecutable({
    somaBunPath: process.env.SOMA_BUN_PATH,
    fromPath: locateBunOnPath(),
    runningUnderBun: Boolean((process.versions as Record<string, string | undefined>).bun),
    execPath: process.execPath,
  });
}
