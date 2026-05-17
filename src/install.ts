import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { configureCodexInstall } from "./adapters/codex";
import { installClaudeCodeHomeProjection, installCodexHomeProjection, installPiDevHomeProjection } from "./home-projection";
import { buildSomaStartupContext, runSomaLifecycleAlgorithmUpdated } from "./lifecycle";
import { defaultSomaRepoPath } from "./repo-path";
import { bootstrapSomaHome } from "./soma-home";
import { installIsaSkill } from "./isa-skill-installer";
import { DEFAULT_SUBSTRATE_HOMES, loadActiveIsaForBundle } from "./adapter-active-isa";
import type { SomaContextInput, SomaInstallOptions, SomaInstallPlan, SomaInstallResult } from "./types";

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

const CLAUDE_CODE_HOME_FILES = ["PAI/ACTIVE_ISA.md"] as const;

const SKILL_SUBPATHS: Record<InstallSubstrate, string> = {
  codex: "skills/ISA",
  "pi-dev": "agent/skills/ISA",
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
  return resolve(substrateHome, SKILL_SUBPATHS[substrate]);
}

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
  const somaHome = await bootstrapSomaHome(options);
  const somaRepoPath = options.somaRepoPath ?? defaultSomaRepoPath();
  // Install ISA skill into Soma home (canonical baseline) so other
  // tooling reading <somaHome>/skills/ISA continues to work.
  await installIsaSkill({
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
  await installIsaSkill({
    homeDir: options.homeDir,
    somaHome: somaHome.somaHome,
    somaRepoPath,
    skillDestinationDir: resolveSubstrateSkillDir(substrate, substrateRoot),
  });
  // Populate the projection input with the active ISA so each
  // substrate writes its `active-isa.md` file (#37 AC-1/AC-2).
  const contextWithActiveIsa: SomaContextInput = {
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
  context: SomaContextInput,
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
 * Claude Code substrate installer (#37 minimal). Bootstraps Soma home,
 * installs the ISA skill into `~/.claude/skills/ISA/`, and writes the
 * active-ISA projection at `~/.claude/PAI/ACTIVE_ISA.md` when one is
 * set. Full Claude Code home install lands in #29 with the
 * `.claude/rules/` pivot.
 */
export async function installSomaForClaudeCode(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("claude-code", options);
}
