/**
 * One staged real runtime per test process (node #929). Staging the real soma
 * tree into a temp home copies, re-hashes, load-checks and seals ~3,200 files;
 * tests that execute the staged runtime (hooks, policy checks, doctors) did
 * that once per test.
 *
 * The installers this module exports wrap `../src/index`'s with
 * `sharingStagedRuntime(install)`: an install of the real runtime into a home
 * without an artifact store first points that home's store at a store shared
 * by the whole process. The first such install stages;
 * every later one finds the artifact already there. Each install still hashes
 * the existing artifact before reusing it and re-stages it when the hash does
 * not match, so a test that tampers with the shared payload costs the next
 * test a fresh staging, never a wrong runtime. The home's own
 * `runtime/<target>/current` and `active.json` stay under the home.
 *
 * An install from another source (`runtimeSourceRoot`, `somaRepoPath`), or
 * into a home that already has a store, keeps a private store: pruning a
 * shared store would remove the artifact other homes reuse. A test that
 * asserts on staging, pruning or rollback calls the installer unwrapped.
 *
 * `bun test` does not emit `exit`, so the preload removes the store after the
 * run (`test/preload-shared-runtime.ts`), and the first share of a process
 * sweeps stores left by processes that no longer exist.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  experimentalAnthropicCowork,
  installSomaForClaudeCode as installSomaForClaudeCodeUnshared,
  installSomaForCodex as installSomaForCodexUnshared,
  installSomaForCursor as installSomaForCursorUnshared,
  installSomaForGrok as installSomaForGrokUnshared,
  installSomaForPiDev as installSomaForPiDevUnshared,
} from "../../src/index";
import { resolveSomaHome } from "../../src/lifecycle";
import type { SomaInstallOptions } from "../../src/types";

const STORE_PREFIX = "soma-shared-runtime-";

function storeFor(pid: number): string {
  return join(tmpdir(), `${STORE_PREFIX}${pid}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let swept = false;

function sweepDeadStores(): void {
  swept = true;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(STORE_PREFIX)) continue;
    const pid = Number(name.slice(STORE_PREFIX.length));
    if (Number.isInteger(pid) && pid !== process.pid && !isAlive(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

/** This process's shared store, created on demand: the preload may have removed it after an earlier file. */
function processStore(): string {
  if (!swept) sweepDeadStores();
  const store = storeFor(process.pid);
  mkdirSync(store, { recursive: true });
  return store;
}

/** Remove this process's shared store. Payload files are read-only but their directories stay writable. */
export function removeSharedRuntimeStore(): void {
  rmSync(storeFor(process.pid), { recursive: true, force: true });
}

function shareStoreFor(options: SomaInstallOptions): void {
  if (options.homeDir === undefined && options.somaHome === undefined) return;
  if (options.runtimeSourceRoot !== undefined || options.somaRepoPath !== undefined) return;
  const store = join(resolveSomaHome(options), "runtime", "artifacts");
  if (lstatSync(store, { throwIfNoEntry: false }) !== undefined) return;
  mkdirSync(join(store, ".."), { recursive: true });
  symlinkSync(processStore(), store, "dir");
}

/** Wrap `install` so a real-runtime install into a fresh home reuses this process's staged artifact. */
export function sharingStagedRuntime<O extends SomaInstallOptions, R>(install: (options?: O) => Promise<R>): (options?: O) => Promise<R> {
  return async (options) => {
    shareStoreFor(options ?? {});
    return install(options);
  };
}

// The installers wrapped once; a test imports these in place of `../src/index`'s
// and imports the unwrapped one only where it must keep a private store.
export const installSomaForAnthropicCowork = sharingStagedRuntime(experimentalAnthropicCowork.installSomaForAnthropicCowork);
export const installSomaForClaudeCode = sharingStagedRuntime(installSomaForClaudeCodeUnshared);
export const installSomaForCodex = sharingStagedRuntime(installSomaForCodexUnshared);
export const installSomaForCursor = sharingStagedRuntime(installSomaForCursorUnshared);
export const installSomaForGrok = sharingStagedRuntime(installSomaForGrokUnshared);
export const installSomaForPiDev = sharingStagedRuntime(installSomaForPiDevUnshared);
