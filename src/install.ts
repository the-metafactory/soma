import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configureCodexInstall } from "./adapters/codex-config";
import { installCodexHomeProjection, installPiDevHomeProjection } from "./home-projection";
import { buildSomaStartupContext, runSomaLifecycleAlgorithmUpdated } from "./lifecycle";
import { defaultSomaRepoPath } from "./repo-path";
import { bootstrapSomaHome } from "./soma-home";
import type { SomaInstallOptions, SomaInstallPlan, SomaInstallResult } from "./types";

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
  "memories/soma/profile.md",
  "memories/soma/startup-context.md",
  "memories/soma/lifecycle.md",
  "memories/soma/memory-layout.md",
  "memories/soma/pai-imports.md",
  "memories/soma/skills.md",
  "memories/soma/policy.md",
] as const;

const PI_DEV_HOME_FILES = [
  "agent/extensions/soma.ts",
  "agent/soma/context.md",
  "agent/soma/profile.md",
  "agent/soma/startup-context.md",
  "agent/soma/memory-layout.md",
  "agent/soma/pai-imports.md",
  "agent/soma/tools.md",
  "agent/soma/skills.md",
  "agent/soma/policy.md",
  "agent/skills/soma/SKILL.md",
] as const;

function resolveInstallHomes(substrate: "codex" | "pi-dev", options: SomaInstallOptions): { somaHome: string; substrateHome: string } {
  const homeDir = options.homeDir;
  const defaultSubstrateHome = substrate === "codex" ? ".codex" : ".pi";
  const somaHome = options.somaHome ?? `${homeDir ?? "~"}/.soma`;
  const substrateHome = options.substrateHome ?? `${homeDir ?? "~"}/${defaultSubstrateHome}`;

  return {
    somaHome,
    substrateHome,
  };
}

function planSomaInstall(
  substrate: "codex" | "pi-dev",
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

async function installSomaForSubstrate(
  substrate: "codex" | "pi-dev",
  options: SomaInstallOptions = {},
): Promise<SomaInstallResult> {
  const somaHome = await bootstrapSomaHome(options);
  const projectionOptions = {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrateHome: options.substrateHome,
    somaRepoPath: options.somaRepoPath ?? defaultSomaRepoPath(),
  };
  const substrateHome =
    substrate === "codex"
      ? await installCodexHomeProjection(somaHome.context, projectionOptions)
      : await installPiDevHomeProjection(somaHome.context, projectionOptions);
  const configFiles = substrate === "codex" ? [await configureCodexInstall(substrateHome.rootDir, somaHome.somaHome)] : [];
  const lifecycleFiles = await installLifecycleProjection(substrate, substrateHome.rootDir, {
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
      files: [...substrateHome.files, ...configFiles, ...lifecycleFiles],
    },
  };
}

async function writeProjectionFile(root: string, relativePath: string, content: string): Promise<string> {
  const path = join(root, relativePath);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${content.trimEnd()}\n`, "utf8");

  return path;
}

async function installLifecycleProjection(
  substrate: "codex" | "pi-dev",
  substrateHome: string,
  options: { homeDir?: string; somaHome: string; somaRepoPath: string; substrate: "codex" | "pi-dev" },
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
