import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { configureCodexInstall } from "./config";
import type { SubstrateInstallSpec } from "../../install-spec";
import type { SubstrateId } from "../../types";

export const CODEX_HOME_FILES = [
  "rules/soma.rules",
  "hooks.json",
  "hooks/soma-lifecycle.mjs",
  "hooks/soma-lifecycle.config.json",
  "hooks/codex-hook-entry.mjs",
  "hooks/soma-feedback-capture.mjs",
  "hooks/codex-policy-hook.mjs",
  "hooks/codex-policy-targets.mjs",
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

export const CODEX_AGENTS_IMPORTS = ["@./skills/the-algorithm/SKILL.md", "@./memories/soma/startup-context.md"] as const;

export function codexProjectionPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  if (options.substrate !== undefined && options.substrate !== "codex") return [];
  const home = resolve(options.homeDir ?? homedir());
  return [join(home, ".codex", "skills", "soma")].map((path) => resolve(path));
}

export function codexMemoryPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  if (options.substrate !== undefined && options.substrate !== "codex") return [];
  const home = resolve(options.homeDir ?? homedir());
  return [join(home, ".codex", "memories")].map((path) => resolve(path));
}

export async function configureCodexAgentsImport(codexHome: string): Promise<string[]> {
  const path = join(codexHome, "AGENTS.md");
  const existing = await readFile(path, "utf8").catch(() => "");
  const existingLines = new Set(existing.split("\n").map((line) => line.trim()));
  const missingImports = CODEX_AGENTS_IMPORTS.filter((line) => !existingLines.has(line));

  if (missingImports.length > 0) {
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${existing}${separator}${missingImports.join("\n")}\n`, "utf8");
  }

  return [path];
}

export const codexInstallSpec: SubstrateInstallSpec<"codex"> = {
  substrate: "codex",
  defaultHome: ".codex",
  homeFiles: CODEX_HOME_FILES,
  lifecycleProjection: {
    startupContextPath: "memories/soma/startup-context.md",
    somaRepoPathPath: "memories/soma/soma-repo.txt",
  },
  postProjection: [
    {
      name: "codex-agents-import",
      run: async ({ substrateHome }) => configureCodexAgentsImport(substrateHome),
    },
    {
      name: "codex-config",
      run: async ({ substrateHome, somaHome }) => [await configureCodexInstall(substrateHome, somaHome)],
    },
  ],
  privateRoots: {
    projection: codexProjectionPrivateRoots,
    memory: codexMemoryPrivateRoots,
  },
  uninstall: {
    kind: "reserved",
    reason: "Codex uninstall is not implemented yet; projection removal needs a follow-up that preserves user-owned AGENTS.md and config.toml content.",
  },
};
