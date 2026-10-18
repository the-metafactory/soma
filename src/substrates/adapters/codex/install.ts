import { CODEX_LIFECYCLE_CONFIG_PATH } from "./projection-constants";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configureCodexInstall } from "./config";
import { skillsLoaderUnder, vsaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { vsaSiblingPrunePrepare } from "../../legacy-skill-prune";
import { CODEX_DEFAULT_HOME, codexMemoryPrivateRoots, codexProjectionPrivateRoots } from "../../../policy/private-roots";
import { pathExists } from "../../../core/index";
import { isCodexSkillProjectionPath, projectCodexHome } from "./adapter";

export const CODEX_HOME_FILES = [
  "rules/soma.rules",
  "hooks.json",
  "hooks/soma-lifecycle.mjs",
  CODEX_LIFECYCLE_CONFIG_PATH,
  "hooks/codex-hook-entry.mjs",
  "hooks/soma-feedback-capture.mjs",
  "hooks/codex-policy-hook.mjs",
  "hooks/codex-policy-targets.mjs",
  "hooks/policy-marker.mjs",
  "skills/soma/SKILL.md",
  "skills/the-algorithm/SKILL.md",
  "memories/soma/context.md",
  "memories/soma/profile.md",
  "memories/soma/startup-context.md",
  "memories/soma/lifecycle.md",
  "memories/soma/memory-layout.md",
  "memories/soma/pai-imports.md",
  "memories/soma/skills.md",
  "memories/soma/policy.md",
  // Conditional: omitted when the home has no `profile/communication.md`.
  "memories/soma/communication.md",
  // Conditional: omitted when the home has no installed the-algorithm skill.
  "memories/soma/principles.md",
  "memories/soma/soma-repo.txt",
  "AGENTS.md",
  "config.toml",
] as const;

export const CODEX_AGENTS_IMPORTS = ["@./memories/soma/context.md", "@./skills/the-algorithm/SKILL.md", "@./memories/soma/startup-context.md"] as const;

/**
 * The communication contract is conditional (no `profile/communication.md`, no
 * projected file), so it is not part of the unconditional import list: an `@`
 * line pointing at a file the projection omitted is exactly the unwired-file
 * case the contract guard exists to prevent. Codex discovers skills on demand,
 * so the `skills/soma/SKILL.md` pointer the contract guard checks only reaches
 * the model once that skill is loaded, and nothing codex always loads named the
 * contract: claude-code and cursor auto-load it from their rules dirs, pi-dev
 * gets it in the extension system prompt, and grok/dsh/anthropic-cowork at
 * least name the soma skill from their entrypoint. Codex named nothing.
 */
export const CODEX_AGENTS_CONTRACT_IMPORT = "@./memories/soma/communication.md";

/** The working method (principles and playbooks) is conditional the same way. */
export const CODEX_AGENTS_WORKING_METHOD_IMPORT = "@./memories/soma/principles.md";

const CODEX_CONDITIONAL_IMPORTS = [
  { line: CODEX_AGENTS_CONTRACT_IMPORT, projectionPath: "memories/soma/communication.md" },
  { line: CODEX_AGENTS_WORKING_METHOD_IMPORT, projectionPath: "memories/soma/principles.md" },
] as const;

export async function configureCodexAgentsImport(codexHome: string): Promise<string[]> {
  const path = join(codexHome, "AGENTS.md");
  const existing = await readFile(path, "utf8").catch(() => "");
  // Runs after the home projection is written, so disk is the authority on
  // whether each conditional file was projected at all.
  const present = await Promise.all(CODEX_CONDITIONAL_IMPORTS.map((entry) => pathExists(join(codexHome, entry.projectionPath))));
  const projected = CODEX_CONDITIONAL_IMPORTS.filter((_, index) => present[index]).map((entry) => entry.line);
  const stale = new Set<string>(CODEX_CONDITIONAL_IMPORTS.filter((_, index) => !present[index]).map((entry) => entry.line));
  const wanted = [...CODEX_AGENTS_IMPORTS, ...projected];
  // A later projection can omit a conditional file, in which case retaining
  // its import would leave AGENTS dangling.
  const withoutStale = stale.size === 0
    ? existing
    : existing.split("\n").filter((line) => !stale.has(line.trim())).join("\n");
  const existingLines = new Set(withoutStale.split("\n").map((line) => line.trim()));
  const missingImports = wanted.filter((line) => !existingLines.has(line));
  let updated = withoutStale;

  if (missingImports.length > 0) {
    const separator = updated.length === 0 || updated.endsWith("\n") ? "" : "\n";
    updated = `${updated}${separator}${missingImports.join("\n")}\n`;
  }
  if (updated !== existing) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, updated, "utf8");
  }

  return [path];
}

export const codexInstallSpec: SubstrateInstallSpec<"codex"> = {
  substrate: "codex",
  defaultHome: CODEX_DEFAULT_HOME,
  homeFiles: CODEX_HOME_FILES,
  homeProjection: {
    build: (input, context) => projectCodexHome(input, context.somaHome, context.homeDir, context.somaRepoPath),
    isSkillProjectionPath: isCodexSkillProjectionPath,
  },
  // Owned (Soma-exclusive) dir — see ownedSubtrees JSDoc. (hooks/ + skills/ are shared.)
  ownedSubtrees: ["memories/soma"],
  skillsLoaderDir: skillsLoaderUnder(),
  skillsLoading: "on-demand",
  skillsDiscovery: "catalog",
  vsaSkillProjection: {
    destinationDir: vsaSkillUnder(),
    // soma#329: before reprojecting VSA, prune a sibling renamed-away "ISA" skill
    // from <home>/skills (provenance-gated to Soma's published ISA identity — a
    // user skill lacking that identity is preserved; see pruneLegacyVsaSkill doc).
    prepare: vsaSiblingPrunePrepare(),
  },
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
