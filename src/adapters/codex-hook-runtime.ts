import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { somaPolicyPrivateMarkers } from "../policy";
import { somaProjectionPrivateRoots } from "../projection-private-roots";
import { defaultSomaRepoPath } from "../repo-path";

export function renderCodexLifecycleHook(somaHome: string, homeDir?: string, somaRepoPath = defaultSomaRepoPath()): string {
  const runtimeUrl = pathToFileURL(join(somaRepoPath, "src/adapters/codex-hook-entry.mjs")).href;
  const policyMarkers = somaPolicyPrivateMarkers(somaHome, homeDir, somaProjectionPrivateRoots({ homeDir, substrate: "codex" }));

  return [
    "#!/usr/bin/env node",
    `import { runCodexHook } from ${JSON.stringify(runtimeUrl)};`,
    "",
    "runCodexHook({",
    `  somaHome: ${JSON.stringify(somaHome)},`,
    `  trustedSomaRepo: ${JSON.stringify(somaRepoPath)},`,
    `  policyMarkers: ${JSON.stringify(policyMarkers)},`,
    "});",
  ].join("\n");
}
