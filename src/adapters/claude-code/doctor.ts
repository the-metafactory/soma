import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isEnoent, pathExists } from "../../fs-utils";
import type { SomaDoctorFinding } from "../../types";
import {
  SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_HOOK_RELATIVE_PATH,
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
 * Claude-Code-specific install-artifact checks that sit OUTSIDE the
 * rendered `rules/soma/*` projection bundle: the lifecycle hook script/
 * config on disk, and whether `settings.json` actually wires the hook in.
 * Rendered projection content (staleness / hand-edit detection) is now
 * covered generically by `../content-compare-doctor.ts` (soma#370) — this
 * function used to also own that via a profile-mtime heuristic plus a
 * header-presence scan; both were retired in favor of content-compare,
 * which subsumes them (and, as a byproduct, now ALSO covers ACTIVE_VSA.md
 * and MEMORY.md staleness, which the old mtime check could not).
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

  return findings;
}
