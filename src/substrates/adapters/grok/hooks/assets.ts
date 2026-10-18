/**
 * Grok hook assets, still read at runtime — deliberately NOT converted to the
 * `with { type: "text" }` imports the codex adapter uses for soma#531.
 *
 * `grok-hook-verbs.mjs` is dual-use: `../adapter.ts` imports it as a real
 * module for `GROK_PRE_TOOL_USE_VERB`, and it is also shipped verbatim to the
 * user's machine. Bun resolves a specifier once, so a text import of the same
 * path strips the named exports and breaks that module import at load time —
 * which takes down anything that loads soma, hooks included.
 *
 * Consequence: `soma install grok --apply` does not work from a compiled
 * binary (ENOENT under /$bunfs). Fixing it means breaking the dual use first —
 * e.g. moving the verb constant into a .ts module that both the adapter and the
 * shipped .mjs can source from — which is #531 work, not a drive-by.
 */
import { readFileSync } from "node:fs";

export function readGrokHookAsset(
  name:
    | "grok-hook-entry.mjs"
    | "soma-lifecycle.mjs"
    | "grok-policy-targets.mjs"
    | "shell-policy-core.mjs"
    | "policy-marker.mjs"
    | "grok-hook-verbs.mjs",
): string {
  const assetUrl = new URL(`./${name}`, import.meta.url);

  return readFileSync(assetUrl, "utf8");
}
