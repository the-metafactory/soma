import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { SomaLifecycleOptions } from "../../types";

// Compatibility for hooks projected before lifecycle carried --home-dir. Read
// the binding from the live SUBSTRATE side, never from a potentially copied
// scratch Soma tree. Reprojecting replaces these hooks with explicit bindings.
const LEGACY_BINDINGS = {
  "claude-code": ".claude/hooks/soma/soma-claude-code-hook.config.json",
  codex: ".codex/hooks/soma-lifecycle.config.json",
  grok: ".grok/hooks/soma-lifecycle.config.json",
  "pi-dev": ".pi/agent/extensions/soma.ts",
} as const;

export async function resolveInstalledLifecycleHomeDir(
  options: SomaLifecycleOptions,
  liveHome = homedir(),
): Promise<string | undefined> {
  if (options.homeDir !== undefined || options.somaHome === undefined) return options.homeDir;
  const substrate = options.substrate;
  if (substrate === undefined || !(substrate in LEGACY_BINDINGS)) return undefined;
  try {
    const raw = await readFile(join(liveHome, LEGACY_BINDINGS[substrate as keyof typeof LEGACY_BINDINGS]), "utf8");
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
