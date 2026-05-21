import { readFileSync } from "node:fs";

export function readCodexHookAsset(
  name:
    | "codex-hook-entry.mjs"
    | "codex-policy-targets.mjs"
    | "policy-marker.mjs"
    | "soma-lifecycle.mjs",
): string {
  const assetUrl = new URL(`./${name}`, import.meta.url);

  return readFileSync(assetUrl, "utf8");
}

export function renderCodexPolicyHook(): string {
  return `export {
  extractWriteTargets,
  shouldCheckPolicyTarget,
} from "./codex-policy-targets.mjs";
`;
}

export function renderCodexPolicyTargets(): string {
  return readCodexHookAsset("codex-policy-targets.mjs");
}
