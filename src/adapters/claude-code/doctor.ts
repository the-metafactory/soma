import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isEnoent, pathExists } from "../../fs-utils";
import type { SomaDoctorFinding } from "../../types";
import { probeSomaRuntimeEntry } from "../../runtime-pin";
import {
  SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_HOOK_RELATIVE_PATH,
  SOMA_CLAUDE_POLICY_GUARD_CONFIG_RELATIVE_PATH,
} from "./hooks";

// The hook file's basename (e.g. `soma-claude-code-hook.mjs`) appears in the
// command string Soma writes into settings.json, so its presence in the file
// is a reliable "the hook is actually registered" signal.
const SOMA_HOOK_MARKER = basename(SOMA_CLAUDE_HOOK_RELATIVE_PATH);

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

const CLAUDE_CODE_HOME = ".claude";
const CLAUDE_CODE_SETTINGS_RELATIVE_PATH = "settings.json";

/**
 * soma#640: does the policy guard's configured runtime actually LOAD?
 *
 * The guard is fail-closed by design, so an unloadable runtime denies every
 * `Bash`/`Read`/`Edit`/`Write` — including the calls needed to repair it. That
 * is a state an operator can only discover by being locked out of their own
 * session, unless something asks the question first. This does.
 *
 * The probe follows whatever the installed config points at, so it covers both
 * shapes: a pinned `runtimeEntry` and the pre-#640 fallback to the working
 * tree. An install with no guard config has no guard, and reports nothing.
 */
async function diagnosePolicyGuardRuntime(substrateHome: string): Promise<SomaDoctorFinding[]> {
  const raw = await readFileOrNull(join(substrateHome, SOMA_CLAUDE_POLICY_GUARD_CONFIG_RELATIVE_PATH));
  if (raw === null) return [];

  let config: { bunPath?: unknown; trustedSomaRepo?: unknown; runtimeEntry?: unknown };
  try {
    config = JSON.parse(raw) as typeof config;
  } catch {
    return [{
      id: "claude-code-policy-guard-runtime-unloadable",
      severity: "error",
      message: "Claude Code policy guard config is not valid JSON — the guard denies every tool call it is asked about.",
      action: "soma install claude-code --apply",
    }];
  }

  if (typeof config.bunPath !== "string") return [];
  const pinned = typeof config.runtimeEntry === "string" && config.runtimeEntry.trim().length > 0;
  if (!pinned && typeof config.trustedSomaRepo !== "string") return [];
  const entryPath = pinned
    ? (config.runtimeEntry as string)
    : join(config.trustedSomaRepo as string, "src", "cli.ts");

  const probe = await probeSomaRuntimeEntry({ entryPath, bunPath: config.bunPath });
  if (!probe.ok) {
    return [{
      id: "claude-code-policy-guard-runtime-unloadable",
      severity: "error",
      message: `Claude Code policy guard runtime does not load (${entryPath}: ${probe.detail}). The guard is fail-closed, so every Bash/Read/Edit/Write call is denied until it does.`,
      action: "soma install claude-code --apply",
    }];
  }
  if (!pinned) {
    return [{
      id: "claude-code-policy-guard-runtime-unpinned",
      severity: "warning",
      message: `Claude Code policy guard loads the soma working tree (${entryPath}) rather than a pinned runtime, so a transient broken import while editing soma denies every tool call — including the ones needed to repair it (soma#640).`,
      action: "soma install claude-code --apply",
    }];
  }
  return [];
}

/**
 * Claude-Code-specific install-artifact checks that sit OUTSIDE the
 * projected `rules/soma/*` bundle: the lifecycle hook script/config on disk,
 * and whether `settings.json` actually wires the hook in. Projected content
 * (staleness / hand-edit detection) is now covered generically by
 * `../content-compare-doctor.ts` (soma#370) — this function used to also own
 * that via a profile-mtime heuristic plus a header-presence scan; both were
 * retired in favor of content-compare, which subsumes them (and, as a
 * byproduct, now ALSO covers ACTIVE_VSA.md and MEMORY.md staleness, which the
 * old mtime check could not).
 */
export async function diagnoseClaudeCodeInstallArtifactDrift(options: {
  homeDir: string;
}): Promise<SomaDoctorFinding[]> {
  const substrateHome = join(options.homeDir, CLAUDE_CODE_HOME);
  const findings: SomaDoctorFinding[] = [];

  const hookPresent =
    (await pathExists(join(substrateHome, SOMA_CLAUDE_HOOK_RELATIVE_PATH))) &&
    (await pathExists(join(substrateHome, SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH)));
  if (!hookPresent) {
    findings.push({
      id: "claude-code-hook-missing",
      severity: "warning",
      message: "Claude Code Soma lifecycle hook is not installed.",
      action: "soma install claude-code --apply",
    });
  }

  const settingsRaw = await readFileOrNull(join(substrateHome, CLAUDE_CODE_SETTINGS_RELATIVE_PATH));
  if (!settingsRaw?.includes(SOMA_HOOK_MARKER)) {
    findings.push({
      id: "claude-code-settings-missing",
      severity: "warning",
      message: settingsRaw === null
        ? "Claude Code settings.json is missing — Soma hooks are not wired in."
        : "Claude Code settings.json does not register the Soma hook.",
      action: "soma install claude-code --apply",
    });
  }

  findings.push(...(await diagnosePolicyGuardRuntime(substrateHome)));

  return findings;
}
