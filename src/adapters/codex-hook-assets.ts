import { readFileSync } from "node:fs";

export function readCodexHookAsset(name: "codex-hook-entry.mjs" | "codex-policy-hook.mjs" | "policy-marker.mjs"): string {
  const assetUrl = new URL(`./${name}`, import.meta.url);

  return readFileSync(assetUrl, "utf8");
}
