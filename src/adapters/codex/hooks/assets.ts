/**
 * Codex hook assets, inlined at bundle time so they survive `bun build --compile`.
 *
 * These were read at runtime via `readFileSync(new URL("./x.mjs",
 * import.meta.url))`. Inside a single-file bundle that resolves to
 * `/$bunfs/root/…`, where the .mjs files do not exist, so `soma install codex
 * --apply` died with ENOENT before writing anything (soma#531 — the c-005 pack
 * ships a compiled soma to people who have no bun and no repo).
 *
 * `with { type: "text" }` makes bun inline the bytes at bundle time and still
 * read from disk in dev, so both paths get the same content. TypeScript has no
 * notion of text imports and resolves `.mjs` as a module, hence the
 * suppressions — a blanket `declare module "*.mjs"` is NOT an option: grok
 * imports `grok-hook-verbs.mjs` as a real module elsewhere, and a global text
 * declaration would break that.
 */
// @ts-expect-error text import: inlined by bun, unknown to tsc
import codexHookEntry from "./codex-hook-entry.mjs" with { type: "text" };
// @ts-expect-error text import: inlined by bun, unknown to tsc
import codexPolicyTargets from "./codex-policy-targets.mjs" with { type: "text" };
// @ts-expect-error text import: inlined by bun, unknown to tsc
import policyMarker from "./policy-marker.mjs" with { type: "text" };
// @ts-expect-error text import: inlined by bun, unknown to tsc
import somaLifecycle from "./soma-lifecycle.mjs" with { type: "text" };

type CodexHookAsset =
  | "codex-hook-entry.mjs"
  | "codex-policy-targets.mjs"
  | "policy-marker.mjs"
  | "soma-lifecycle.mjs";

const ASSETS: Record<CodexHookAsset, string> = {
  "codex-hook-entry.mjs": codexHookEntry as string,
  "codex-policy-targets.mjs": codexPolicyTargets as string,
  "policy-marker.mjs": policyMarker as string,
  "soma-lifecycle.mjs": somaLifecycle as string,
};

export function readCodexHookAsset(name: CodexHookAsset): string {
  return ASSETS[name];
}

export function renderCodexPolicyHook(): string {
  return `export {
  extractInboundContentTargets,
  extractWriteTargets,
  shouldCheckPolicyTarget,
} from "./codex-policy-targets.mjs";
`;
}

export function renderCodexPolicyTargets(): string {
  return readCodexHookAsset("codex-policy-targets.mjs");
}
