import { installCodexHomeProjection, installPiDevHomeProjection } from "./home-projection";
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
  "skills/soma/SKILL.md",
  "memories/soma/profile.md",
  "memories/soma/memory-layout.md",
  "memories/soma/pai-imports.md",
  "memories/soma/skills.md",
  "memories/soma/policy.md",
] as const;

const PI_DEV_HOME_FILES = [
  "agent/extensions/soma.ts",
  "agent/soma/context.md",
  "agent/soma/profile.md",
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
  };
  const substrateHome =
    substrate === "codex"
      ? await installCodexHomeProjection(somaHome.context, projectionOptions)
      : await installPiDevHomeProjection(somaHome.context, projectionOptions);

  return {
    substrate,
    somaHome,
    substrateHome,
  };
}

export async function installSomaForCodex(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("codex", options);
}

export async function installSomaForPiDev(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("pi-dev", options);
}
