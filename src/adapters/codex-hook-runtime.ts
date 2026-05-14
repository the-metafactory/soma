import { somaPolicyPrivateMarkers } from "../policy";
import { somaProjectionPrivateRoots } from "../projection-private-roots";
import { defaultSomaRepoPath } from "../repo-path";

export function renderCodexLifecycleHook(somaHome: string, homeDir?: string, somaRepoPath = defaultSomaRepoPath()): string {
  const policyMarkers = somaPolicyPrivateMarkers(somaHome, homeDir, somaProjectionPrivateRoots({ homeDir, substrate: "codex" }));

  return [
    "#!/usr/bin/env node",
    'import { runCodexHook } from "./codex-hook-entry.mjs";',
    "",
    "runCodexHook({",
    `  somaHome: ${JSON.stringify(somaHome)},`,
    `  trustedSomaRepo: ${JSON.stringify(somaRepoPath)},`,
    `  bunPath: ${JSON.stringify(process.execPath)},`,
    `  policyMarkers: ${JSON.stringify(policyMarkers)},`,
    "});",
  ].join("\n");
}
