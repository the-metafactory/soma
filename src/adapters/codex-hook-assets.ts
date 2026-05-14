import { readFileSync } from "node:fs";

export function readCodexHookAsset(name: "codex-hook-entry.mjs" | "policy-marker.mjs"): string {
  const assetUrl =
    name === "codex-hook-entry.mjs"
      ? new URL("./codex-hook-entry.mjs", import.meta.url)
      : new URL("../policy-marker.mjs", import.meta.url);

  return readFileSync(assetUrl, "utf8");
}
