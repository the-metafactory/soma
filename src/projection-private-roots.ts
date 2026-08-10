import { resolve } from "node:path";
import {
  anthropicCoworkProjectionPrivateRoots,
  codexMemoryPrivateRoots,
  codexProjectionPrivateRoots,
  grokProjectionPrivateRoots,
  piDevProjectionPrivateRoots,
} from "./adapters/private-roots";
import type { InstallSubstrate, PrivateRootOptions } from "./install-spec";

type PrivateRootBuilder = (options: PrivateRootOptions) => string[];

/**
 * Deliberately NOT routed through `install-spec-registry`.
 *
 * This module sits on every `checkSomaPolicy` call (src/policy-audit.ts) —
 * including the checks inside the GENERATED pi.dev extensions, which import this
 * repo's `src/` directly through pi's jiti loader. Walking the install-spec
 * registry pulled every adapter's *installer* into that graph, and the
 * claude-code installer imports its hook assets with bun's
 * `with { type: "text" }`. jiti strips that attribute, so `hook-runner.mjs` got
 * evaluated as a real module and the extension died on its unreplaced
 * `__SOMA_CLAUDE_HOOK_EVENT_HANDLERS__` placeholder (soma#531 follow-up).
 *
 * The registry keyed the lookup by substrate, so this table is keyed the same
 * way — a `Record<InstallSubstrate, ...>`, so adding a substrate is a type error
 * until it declares its private roots here. Order matches the registry's
 * insertion order because callers compare these lists positionally.
 */
const PRIVATE_ROOT_BUILDERS: Record<
  InstallSubstrate,
  { projection?: PrivateRootBuilder; memory?: PrivateRootBuilder }
> = {
  codex: { projection: codexProjectionPrivateRoots, memory: codexMemoryPrivateRoots },
  "pi-dev": { projection: piDevProjectionPrivateRoots },
  "claude-code": {},
  cursor: {},
  grok: { projection: grokProjectionPrivateRoots },
  "anthropic-cowork": { projection: anthropicCoworkProjectionPrivateRoots },
};

function isRegisteredPrivateRootSubstrate(value: string | undefined): value is InstallSubstrate {
  return value !== undefined && Object.prototype.hasOwnProperty.call(PRIVATE_ROOT_BUILDERS, value);
}

function privateRootsFor(options: PrivateRootOptions, kind: "projection" | "memory"): string[] {
  const entries = isRegisteredPrivateRootSubstrate(options.substrate)
    ? [PRIVATE_ROOT_BUILDERS[options.substrate]]
    : Object.values(PRIVATE_ROOT_BUILDERS);
  return entries.flatMap((entry) => entry[kind]?.(options) ?? []).map((path) => resolve(path));
}

export function somaProjectionPrivateRoots(options: PrivateRootOptions = {}): string[] {
  return privateRootsFor(options, "projection");
}

export function somaMemoryPrivateRoots(options: PrivateRootOptions = {}): string[] {
  return privateRootsFor(options, "memory");
}
