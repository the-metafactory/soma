import { skillsLoaderUnder, vsaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { vsaSiblingPrunePrepare } from "../../legacy-skill-prune";
import { CLAUDE_CODE_RULES_FILES } from "../claude-code";
import {
  SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_HOOK_RELATIVE_PATH,
  SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH,
  SOMA_CLAUDE_POLICY_GUARD_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_POLICY_GUARD_RELATIVE_PATH,
  installClaudeCodeSomaHooks,
  removeClaudeCodeSomaHookFiles,
} from "./hooks";
import { CLAUDE_CODE_CLAUDE_MD_RELATIVE_PATH, installClaudeCodeClaudeMd } from "./claude-md";
import { isClaudeCodeInstallOptions } from "./install-options";

export const claudeCodeInstallSpec: SubstrateInstallSpec<"claude-code"> = {
  substrate: "claude-code",
  defaultHome: ".claude",
  homeFiles: [
    ...CLAUDE_CODE_RULES_FILES,
    SOMA_CLAUDE_HOOK_RELATIVE_PATH,
    SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
    "settings.json",
  ],
  // Owned (Soma-exclusive) dirs — see ownedSubtrees JSDoc. Subsumes the former
  // obsoleteHomeFiles for TELOS.md/ACTIVE_ISA.md, which live under rules/soma.
  ownedSubtrees: ["rules/soma", "hooks/soma"],
  optionalHomeFiles: (options) => [
    ...(isClaudeCodeInstallOptions(options) && options.modeClassifier === true
      ? [SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH, SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH]
      : []),
    ...(isClaudeCodeInstallOptions(options) && options.policyGuard === true
      ? [SOMA_CLAUDE_POLICY_GUARD_RELATIVE_PATH, SOMA_CLAUDE_POLICY_GUARD_CONFIG_RELATIVE_PATH]
      : []),
    ...(isClaudeCodeInstallOptions(options) && options.claudeMd === true
      ? [CLAUDE_CODE_CLAUDE_MD_RELATIVE_PATH]
      : []),
  ],
  skillsLoaderDir: skillsLoaderUnder(),
  vsaSkillProjection: {
    destinationDir: vsaSkillUnder(),
    // soma#329: before reprojecting VSA, prune a sibling renamed-away "ISA" skill
    // from <home>/skills (provenance-gated to Soma's published ISA identity — a
    // user skill lacking that identity is preserved; see pruneLegacyVsaSkill doc).
    prepare: vsaSiblingPrunePrepare(),
  },
  postProjection: [
    {
      name: "claude-code-soma-hooks",
      run: installClaudeCodeSomaHooks,
    },
    {
      // soma#368: opt-in (`--claude-md`) generated CLAUDE.md with a preserved
      // overlay. No-op without the flag, so the default install is unchanged.
      name: "claude-code-claude-md",
      run: installClaudeCodeClaudeMd,
    },
  ],
  uninstall: {
    kind: "implemented",
    remove: ["rules/soma", "skills/VSA"],
    postRemove: (context) => removeClaudeCodeSomaHookFiles(context.substrateHome),
  },
};
