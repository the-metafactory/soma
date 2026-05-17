import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { configureCodexInstall } from "./adapters/codex";
import {
  PI_DEV_ISA_SKILL_ID,
  piDevIsaSkillDestinationDir,
  removeLegacyPiDevIsaSkillProjection,
} from "./adapters/pi-dev/skill-projection";
import { installClaudeCodeHomeProjection, installCodexHomeProjection, installPiDevHomeProjection } from "./home-projection";
import { buildSomaStartupContext, runSomaLifecycleAlgorithmUpdated } from "./lifecycle";
import { defaultSomaRepoPath } from "./repo-path";
import { bootstrapSomaHome } from "./soma-home";
import { installIsaSkill, installIsaSkillProjection } from "./isa-skill-installer";
import { DEFAULT_SUBSTRATE_HOMES, loadActiveIsaForBundle } from "./adapter-active-isa";
import type { ProjectionInput, SomaInstallOptions, SomaInstallPlan, SomaInstallResult } from "./types";

const SOMA_BOOTSTRAP_FILES = [
  "profile/assistant.md",
  "profile/principal.md",
  "profile/telos.md",
  "policy/README.md",
  "skills/README.md",
  "projections/README.md",
] as const;

const SOMA_BOOTSTRAP_DIRECTORIES = [
  "memory/WORK",
  "memory/KNOWLEDGE",
  "memory/LEARNING",
  "memory/RELATIONSHIP",
  "memory/STATE",
  "projections/codex",
  "projections/pi-dev",
  "projections/claude-code",
] as const;

const CODEX_HOME_FILES = [
  "rules/soma.rules",
  "hooks.json",
  "hooks/soma-lifecycle.mjs",
  "hooks/soma-lifecycle.config.json",
  "hooks/codex-hook-entry.mjs",
  "hooks/soma-feedback-capture.mjs",
  "hooks/codex-policy-hook.mjs",
  "hooks/policy-marker.mjs",
  "skills/soma/SKILL.md",
  "skills/the-algorithm/SKILL.md",
  "memories/soma/profile.md",
  "memories/soma/startup-context.md",
  "memories/soma/lifecycle.md",
  "memories/soma/memory-layout.md",
  "memories/soma/pai-imports.md",
  "memories/soma/skills.md",
  "memories/soma/policy.md",
  "memories/soma/soma-repo.txt",
  "AGENTS.md",
  "config.toml",
] as const;

const CODEX_AGENTS_IMPORTS = ["@./skills/the-algorithm/SKILL.md", "@./memories/soma/startup-context.md"] as const;

const PI_DEV_HOME_FILES = [
  "agent/extensions/soma.ts",
  "agent/extensions/soma-path-guard.ts",
  // #43 minimal-correct slice — Algorithm phase renderer extension.
  "agent/extensions/soma-algorithm.ts",
  "agent/soma/context.md",
  "agent/soma/profile.md",
  "agent/soma/startup-context.md",
  "agent/soma/memory-layout.md",
  "agent/soma/pai-imports.md",
  "agent/soma/tools.md",
  "agent/soma/skills.md",
  "agent/soma/policy.md",
  "agent/soma/soma-repo.txt",
  "agent/skills/soma/SKILL.md",
] as const;

// Claude Code home files written by the full #29 installer
// (`.claude/rules/soma/`-pivot per soma#64). Sourced from the adapter
// so the planner and writer can't drift (sage r1 finding).
import { CLAUDE_CODE_RULES_FILES } from "./adapters/claude-code";
const CLAUDE_CODE_HOME_FILES = CLAUDE_CODE_RULES_FILES;

const SKILL_SUBPATHS: Record<Exclude<InstallSubstrate, "pi-dev">, string> = {
  codex: "skills/ISA",
  "claude-code": "skills/ISA",
};

type InstallSubstrate = "codex" | "pi-dev" | "claude-code";

function resolveInstallHomes(substrate: InstallSubstrate, options: SomaInstallOptions): { somaHome: string; substrateHome: string } {
  const homeDir = options.homeDir;
  const defaultSubstrateHome = DEFAULT_SUBSTRATE_HOMES[substrate];
  const somaHome = options.somaHome ?? `${homeDir ?? "~"}/.soma`;
  const substrateHome = options.substrateHome ?? `${homeDir ?? "~"}/${defaultSubstrateHome}`;

  return {
    somaHome,
    substrateHome,
  };
}

function resolveSubstrateSkillDir(substrate: InstallSubstrate, substrateHome: string): string {
  if (substrate === "pi-dev") return piDevIsaSkillDestinationDir(substrateHome);
  return resolve(substrateHome, SKILL_SUBPATHS[substrate]);
}

function substrateSkillNameOverride(substrate: InstallSubstrate): string | undefined {
  if (substrate === "pi-dev") return PI_DEV_ISA_SKILL_ID;
  return undefined;
}

async function prepareSubstrateSkillDestination(substrate: InstallSubstrate, substrateHome: string): Promise<void> {
  if (substrate === "pi-dev") {
    await removeLegacyPiDevIsaSkillProjection(substrateHome);
  }
}

// soma#73 pre-flight is shared with the codex adapter — see
// `src/bun-probe.ts` for the discovery + remediation logic.
import { requireBunInPath } from "./bun-probe";

function planSomaInstall(
  substrate: InstallSubstrate,
  substrateFiles: readonly string[],
  options: SomaInstallOptions = {},
): SomaInstallPlan {
  const homes = resolveInstallHomes(substrate, options);

  return {
    substrate,
    apply: false,
    somaHome: homes.somaHome,
    substrateHome: homes.substrateHome,
    somaDirectories: SOMA_BOOTSTRAP_DIRECTORIES.map((path) => `${homes.somaHome}/${path}`),
    somaFiles: SOMA_BOOTSTRAP_FILES.map((path) => `${homes.somaHome}/${path}`),
    substrateFiles: substrateFiles.map((path) => `${homes.substrateHome}/${path}`),
  };
}

export function planSomaForCodexInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("codex", CODEX_HOME_FILES, options);
}

export function planSomaForPiDevInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("pi-dev", PI_DEV_HOME_FILES, options);
}

export function planSomaForClaudeCodeInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("claude-code", CLAUDE_CODE_HOME_FILES, options);
}

async function installSomaForSubstrate(
  substrate: InstallSubstrate,
  options: SomaInstallOptions = {},
): Promise<SomaInstallResult> {
  // soma#73 pre-flight: every soma substrate hook now runs under Bun
  // (#!/usr/bin/env bun shebang). The adopter rejects loud + early
  // when bun is missing rather than producing a half-broken install
  // that fails at hook fire time. Always probes `which bun` — sage
  // r1 caught a bypass that trusted `process.versions.bun`, which
  // doesn't prove anything about the hook's later spawn environment.
  requireBunInPath();
  const somaHome = await bootstrapSomaHome(options);
  const somaRepoPath = options.somaRepoPath ?? defaultSomaRepoPath();
  // Install ISA skill into Soma home (canonical baseline) so other
  // tooling reading <somaHome>/skills/ISA continues to work.
  await installIsaSkillProjection({
    homeDir: options.homeDir,
    somaHome: somaHome.somaHome,
    somaRepoPath,
  });
  const projectionOptions = {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrateHome: options.substrateHome,
    somaRepoPath,
  };
  // Per-substrate skill projection (#37 AC-3). Each substrate gets the
  // versioned ISA skill under its native skills dir, with independent
  // baseline tracking via `skillDestinationDir`. AC-5: drift detection
  // inherits installIsaSkill's local-edits-preserved contract.
  const resolvedHomeDir = resolve(options.homeDir ?? homedir());
  const substrateRoot = resolve(options.substrateHome ?? join(resolvedHomeDir, DEFAULT_SUBSTRATE_HOMES[substrate]));
  await prepareSubstrateSkillDestination(substrate, substrateRoot);
  await installIsaSkillProjection({
    homeDir: options.homeDir,
    somaHome: somaHome.somaHome,
    somaRepoPath,
    skillDestinationDir: resolveSubstrateSkillDir(substrate, substrateRoot),
    skillNameOverride: substrateSkillNameOverride(substrate),
  });
  // Populate the projection input with the active ISA so each
  // substrate writes its `active-isa.md` file (#37 AC-1/AC-2).
  const contextWithActiveIsa: ProjectionInput = {
    ...somaHome.context,
    activeIsa: (await loadActiveIsaForBundle({ somaHome: somaHome.somaHome })) ?? undefined,
  };
  const substrateHome = await installHomeProjectionFor(substrate, contextWithActiveIsa, projectionOptions);
  const configFiles = substrate === "codex" ? [await configureCodexInstall(substrateHome.rootDir, somaHome.somaHome)] : [];
  const agentsFiles = substrate === "codex" ? [await configureCodexAgentsImport(substrateHome.rootDir)] : [];
  const lifecycleFiles =
    substrate === "claude-code"
      ? []
      : await installLifecycleProjection(substrate, substrateHome.rootDir, {
          homeDir: options.homeDir,
          somaHome: somaHome.somaHome,
          somaRepoPath: projectionOptions.somaRepoPath,
          substrate,
        });

  return {
    substrate,
    somaHome,
    substrateHome: {
      ...substrateHome,
      files: [...substrateHome.files, ...agentsFiles, ...configFiles, ...lifecycleFiles],
    },
  };
}

async function installHomeProjectionFor(
  substrate: InstallSubstrate,
  context: ProjectionInput,
  options: { homeDir?: string; somaHome?: string; substrateHome?: string; somaRepoPath: string },
) {
  switch (substrate) {
    case "codex":
      return installCodexHomeProjection(context, options);
    case "pi-dev":
      return installPiDevHomeProjection(context, options);
    case "claude-code":
      return installClaudeCodeHomeProjection(context, options);
  }
}

async function configureCodexAgentsImport(codexHome: string): Promise<string> {
  const path = join(codexHome, "AGENTS.md");
  const existing = await readFile(path, "utf8").catch(() => "");
  const existingLines = new Set(existing.split("\n").map((line) => line.trim()));
  const missingImports = CODEX_AGENTS_IMPORTS.filter((line) => !existingLines.has(line));

  if (missingImports.length > 0) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${existing}${separator}${missingImports.join("\n")}\n`, "utf8");
  }

  return path;
}

async function writeProjectionFile(root: string, relativePath: string, content: string): Promise<string> {
  const path = join(root, relativePath);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${content.trimEnd()}\n`, "utf8");

  return path;
}

async function installLifecycleProjection(
  substrate: Exclude<InstallSubstrate, "claude-code">,
  substrateHome: string,
  options: { homeDir?: string; somaHome: string; somaRepoPath: string; substrate: Exclude<InstallSubstrate, "claude-code"> },
): Promise<string[]> {
  await runSomaLifecycleAlgorithmUpdated(options);
  const startup = await buildSomaStartupContext(options);
  const relativePath = substrate === "codex" ? "memories/soma/startup-context.md" : "agent/soma/startup-context.md";
  const files = [await writeProjectionFile(substrateHome, relativePath, startup.context)];

  if (substrate === "codex") {
    files.push(await writeProjectionFile(substrateHome, "memories/soma/soma-repo.txt", options.somaRepoPath));
  }

  if (substrate === "pi-dev") {
    files.push(await writeProjectionFile(substrateHome, "agent/soma/soma-repo.txt", options.somaRepoPath));
  }

  return files;
}

export async function installSomaForCodex(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("codex", options);
}

export async function installSomaForPiDev(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("pi-dev", options);
}

/**
 * Claude Code substrate installer (#29). Bootstraps Soma home,
 * installs the ISA skill into `~/.claude/skills/ISA/`, and writes the
 * full projection skeleton at `~/.claude/rules/soma/` (auto-discovered
 * by Claude Code, per the soma#64 pivot away from `@`-imports).
 *
 * Out of scope (follow-up issue): hook scripts +
 * settings.local.json patching, CLI command wiring, CLAUDE.md
 * composition.
 */
export async function installSomaForClaudeCode(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("claude-code", options);
}

/**
 * Uninstall Soma's projection from a Claude Code home (#29). Removes
 * `<substrateHome>/rules/soma/` and `<substrateHome>/skills/ISA/`
 * entirely. Returns the list of paths actually removed (empty when
 * Soma was never installed). Never touches files outside those two
 * directories — by construction, those are the only paths the
 * installer writes.
 */
export interface UninstallClaudeCodeOptions {
  homeDir?: string;
  substrateHome?: string;
}

export interface UninstallClaudeCodeResult {
  substrate: "claude-code";
  substrateHome: string;
  removed: string[];
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

export async function uninstallSomaForClaudeCode(
  options: UninstallClaudeCodeOptions = {},
): Promise<UninstallClaudeCodeResult> {
  const resolvedHomeDir = resolve(options.homeDir ?? homedir());
  const substrateHome = resolve(options.substrateHome ?? join(resolvedHomeDir, DEFAULT_SUBSTRATE_HOMES["claude-code"]));
  const targets = [join(substrateHome, "rules/soma"), join(substrateHome, "skills/ISA")];
  const { rm, stat } = await import("node:fs/promises");
  const removed: string[] = [];
  for (const target of targets) {
    try {
      await stat(target);
    } catch (error) {
      if (isEnoent(error)) continue; // not installed → idempotent skip
      throw error; // permissions or other I/O failure — sage r1: do NOT hide
    }
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      if (isEnoent(error)) continue; // race: gone between stat and rm
      throw error;
    }
  }
  return { substrate: "claude-code", substrateHome, removed };
}
