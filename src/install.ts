import { installCodexHomeProjection } from "./home-projection";
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

function resolveInstallHomes(options: SomaInstallOptions): { somaHome: string; substrateHome: string } {
  const homeDir = options.homeDir;
  const somaHome = options.somaHome ?? `${homeDir ?? "~"}/.soma`;
  const substrateHome = options.substrateHome ?? `${homeDir ?? "~"}/.codex`;

  return {
    somaHome,
    substrateHome,
  };
}

export function planSomaForCodexInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  const homes = resolveInstallHomes(options);

  return {
    substrate: "codex",
    apply: false,
    somaHome: homes.somaHome,
    substrateHome: homes.substrateHome,
    somaDirectories: SOMA_BOOTSTRAP_DIRECTORIES.map((path) => `${homes.somaHome}/${path}`),
    somaFiles: SOMA_BOOTSTRAP_FILES.map((path) => `${homes.somaHome}/${path}`),
    substrateFiles: CODEX_HOME_FILES.map((path) => `${homes.substrateHome}/${path}`),
  };
}

export async function installSomaForCodex(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  const somaHome = await bootstrapSomaHome(options);
  const substrateHome = await installCodexHomeProjection(somaHome.context, {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrateHome: options.substrateHome,
  });

  return {
    substrate: "codex",
    somaHome,
    substrateHome,
  };
}
