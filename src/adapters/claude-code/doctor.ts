import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isEnoent, pathExists, pathMtimeMs } from "../../fs-utils";
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

// The Claude Code projection is rooted at `~/.claude`. `rules/soma/CONTEXT.md`
// is the primary projected context file (the analogue of codex's
// `soma.rules`), so its presence/mtime is the projection-health signal. The
// lifecycle hook and `settings.json` wiring are separate install artifacts the
// projection cannot work without, so each gets its own finding.
const CLAUDE_CODE_HOME = ".claude";
const CLAUDE_CODE_CONTEXT_RELATIVE_PATH = "rules/soma/CONTEXT.md";
const CLAUDE_CODE_SETTINGS_RELATIVE_PATH = "settings.json";

export async function diagnoseClaudeCodeProjectionDrift(options: {
  homeDir: string;
  profileMtime: number | null;
}): Promise<SomaDoctorFinding[]> {
  const substrateHome = join(options.homeDir, CLAUDE_CODE_HOME);
  const findings: SomaDoctorFinding[] = [];

  const contextMtime = await pathMtimeMs(join(substrateHome, CLAUDE_CODE_CONTEXT_RELATIVE_PATH));
  const stale =
    contextMtime === null ||
    (options.profileMtime !== null && contextMtime < options.profileMtime);
  if (stale) {
    findings.push({
      id: "claude-code-projection-stale",
      severity: "warning",
      message: contextMtime === null
        ? "Claude Code projection is missing."
        : "Claude Code projection is older than the Soma profile files.",
      action: "soma reproject claude-code",
    });
  }

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
