import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { somaPolicyPrivateMarkers } from "../../../policy";
import { somaMemoryPrivateRoots, somaProjectionPrivateRoots } from "../../../projection-private-roots";
import { defaultSomaRepoPath } from "../../../repo-path";

export function resolveBunExecutable(explicitBunPath = process.env.SOMA_BUN_PATH): string {
  if (explicitBunPath) {
    return explicitBunPath;
  }

  if ((process.versions as Record<string, string | undefined>).bun && process.execPath) {
    return process.execPath;
  }

  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  const resolved = which.status === 0 ? which.stdout.trim().split("\n")[0] : "";
  if (!resolved) {
    throw new Error("Unable to resolve a Bun executable for Codex hook projection. Set SOMA_BUN_PATH or install with Bun.");
  }

  return resolved;
}

export function renderCodexLifecycleHook(somaHome: string, homeDir?: string, somaRepoPath = defaultSomaRepoPath(), bunPath = resolveBunExecutable()): string {
  const privateRoots = [...somaProjectionPrivateRoots({ homeDir, substrate: "codex" }), ...codexAdapterMemoryPrivateRoots(homeDir)];
  const policyMarkers = somaPolicyPrivateMarkers(somaHome, homeDir, privateRoots);

  return [
    "#!/usr/bin/env node",
    'import { runCodexHook } from "./codex-hook-entry.mjs";',
    "",
    "runCodexHook({",
    `  somaHome: ${JSON.stringify(somaHome)},`,
    `  trustedSomaRepo: ${JSON.stringify(somaRepoPath)},`,
    `  bunPath: ${JSON.stringify(bunPath)},`,
    `  privateRoots: ${JSON.stringify(privateRoots)},`,
    `  policyMarkers: ${JSON.stringify(policyMarkers)},`,
    "});",
  ].join("\n");
}

function codexAdapterMemoryPrivateRoots(homeDir?: string): string[] {
  const home = resolve(homeDir ?? homedir());
  return [
    ...somaMemoryPrivateRoots({ homeDir, substrate: "codex" }),
    join(home, ".claude", "memory"),
    join(home, ".claude", "memories"),
    join(home, ".claude", "PAI", "MEMORY"),
  ].map((path) => resolve(path));
}
