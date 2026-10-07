import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { defaultSubstrateHome } from "../../install-spec-registry";
import { SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH } from "../claude-code/hooks";
import { CODEX_LIFECYCLE_CONFIG_PATH } from "../codex/projection-constants";
import { GROK_LIFECYCLE_CONFIG_PATH } from "../grok/projection-constants";
import { PI_DEV_HOME_EXTENSION_PATH } from "../pi-dev/projection-constants";
import type { SomaLifecycleOptions } from "../../types";

// Compatibility for hooks projected before lifecycle carried --home-dir. Read
// the binding from the live SUBSTRATE side, never from a potentially copied
// scratch Soma tree. Only default locations under liveHome are discoverable;
// arbitrary relocated legacy installs must pin homeDir or reproject their hooks.
const LEGACY_BINDINGS = {
  "claude-code": SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
  codex: CODEX_LIFECYCLE_CONFIG_PATH,
  grok: GROK_LIFECYCLE_CONFIG_PATH,
  "pi-dev": PI_DEV_HOME_EXTENSION_PATH,
} as const;

export async function resolveInstalledLifecycleHomeDir(
  options: SomaLifecycleOptions,
  liveHome = homedir(),
): Promise<string | undefined> {
  if (options.homeDir !== undefined || options.somaHome === undefined) return options.homeDir;
  const substrate = options.substrate;
  if (substrate === undefined || !(substrate in LEGACY_BINDINGS)) return undefined;
  try {
    const bindingSubstrate = substrate as keyof typeof LEGACY_BINDINGS;
    const raw = await readFile(join(liveHome, defaultSubstrateHome(bindingSubstrate), LEGACY_BINDINGS[bindingSubstrate]), "utf8");
    // Pi's generated extension has no companion JSON config. Parse only its
    // JSON string literal; never evaluate installed code to recover a binding.
    const source: unknown = substrate === "pi-dev"
      ? JSON.parse(raw.match(/^const SOMA_HOME = ("(?:[^"\\]|\\.)*");$/mu)?.[1] ?? "null")
      : JSON.parse(raw)?.somaHome;
    if (typeof source !== "string" || !isAbsolute(source)) return undefined;
    const [installed, requested] = await Promise.all([realpath(source), realpath(options.somaHome)]);
    return installed === requested ? liveHome : undefined;
  } catch {
    // No readable, valid binding means no authority to write to the live home.
    return undefined;
  }
}
