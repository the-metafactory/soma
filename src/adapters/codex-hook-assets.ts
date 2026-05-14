import { readFileSync } from "node:fs";

export function readCodexHookAsset(name: "codex-hook-entry.mjs" | "policy-marker.mjs"): string {
  const assetUrl =
    name === "codex-hook-entry.mjs"
      ? new URL("./codex-hook-entry.mjs", import.meta.url)
      : new URL("../policy-marker.mjs", import.meta.url);

  const content = readFileSync(assetUrl, "utf8");
  return name === "codex-hook-entry.mjs" ? content.replace('"../policy-marker.mjs"', '"./policy-marker.mjs"') : content;
}
