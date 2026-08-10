import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PrivateRootOptions } from "../install-spec";

/**
 * Per-substrate default homes and private-root path builders, deliberately kept
 * in a LEAF module — nothing here may import an adapter.
 *
 * Two very different callers need these facts:
 *
 *   1. the install specs (`adapters/<substrate>/install.ts`), which drag in the
 *      whole projection surface — hook assets, config writers, skill projection;
 *   2. `src/policy-audit.ts` via `src/projection-private-roots.ts`, which every
 *      Soma policy check goes through — including the checks inside the
 *      GENERATED pi.dev extensions, which `import` this repo's `src/` directly
 *      (see `adapters/pi-dev/adapter.ts`).
 *
 * Routing (2) through `install-spec-registry` made a policy check pull in every
 * adapter's installer, and that broke pi.dev outright (soma#531 follow-up): the
 * claude-code installer imports its hook assets with bun's
 * `import ... with { type: "text" }`, pi loads extensions through jiti, jiti
 * strips the import attribute, and `hook-runner.mjs` was then evaluated as a
 * real module — dying on its unreplaced `__SOMA_CLAUDE_HOOK_EVENT_HANDLERS__`
 * placeholder before the extension could register anything.
 *
 * So the install specs import FROM here, never the reverse.
 * `test/pi-dev-extension-import-graph.test.ts` holds the line.
 */

export const CODEX_DEFAULT_HOME = ".codex";
export const GROK_DEFAULT_HOME = ".grok";
export const PI_DEV_DEFAULT_HOME = ".pi";
export const ANTHROPIC_COWORK_DEFAULT_HOME = ".anthropic-cowork";

export function codexProjectionPrivateRoots(options: PrivateRootOptions = {}): string[] {
  if (options.substrate !== undefined && options.substrate !== "codex") return [];
  const home = resolve(options.homeDir ?? homedir());
  return [join(home, CODEX_DEFAULT_HOME, "skills", "soma")].map((path) => resolve(path));
}

export function codexMemoryPrivateRoots(options: PrivateRootOptions = {}): string[] {
  if (options.substrate !== undefined && options.substrate !== "codex") return [];
  const home = resolve(options.homeDir ?? homedir());
  return [join(home, CODEX_DEFAULT_HOME, "memories")].map((path) => resolve(path));
}

export function grokProjectionPrivateRoots(options: PrivateRootOptions = {}): string[] {
  if (options.substrate !== undefined && options.substrate !== "grok") return [];
  const home = resolve(options.homeDir ?? homedir());
  // The projected identity/context surface (Soma never writes into
  // ~/.grok/memory/, so there is no separate memory private root).
  return [join(home, GROK_DEFAULT_HOME, "skills", "soma")].map((path) => resolve(path));
}

export function piDevProjectionPrivateRoots(options: PrivateRootOptions = {}): string[] {
  if (options.substrate !== undefined && options.substrate !== "pi-dev") return [];
  const home = resolve(options.homeDir ?? homedir());
  return [
    join(home, PI_DEV_DEFAULT_HOME, "agent", "soma"),
    join(home, PI_DEV_DEFAULT_HOME, "agent", "skills", "soma"),
  ];
}

export function anthropicCoworkProjectionPrivateRoots(options: PrivateRootOptions = {}): string[] {
  const homeDir = resolve(options.homeDir ?? homedir());
  const substrateHome = resolve(options.substrateHome ?? join(homeDir, ANTHROPIC_COWORK_DEFAULT_HOME));
  return [resolve(substrateHome, "soma"), resolve(substrateHome, "capture"), resolve(substrateHome, "skills/VSA")];
}
