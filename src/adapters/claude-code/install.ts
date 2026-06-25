import { vsaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { CLAUDE_CODE_RULES_FILES } from "../claude-code";
import {
  SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_HOOK_RELATIVE_PATH,
  SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH,
  installClaudeCodeSomaHooks,
  removeClaudeCodeSomaHookFiles,
} from "./hooks";
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
  optionalHomeFiles: (options) => isClaudeCodeInstallOptions(options) && options.modeClassifier === true
    ? [SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH, SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH]
    : [],
  vsaSkillProjection: {
    destinationDir: vsaSkillUnder(),
  },
  postProjection: [
    {
      name: "claude-code-soma-hooks",
      run: installClaudeCodeSomaHooks,
    },
  ],
  uninstall: {
    kind: "implemented",
    remove: ["rules/soma", "skills/VSA"],
    postRemove: (context) => removeClaudeCodeSomaHookFiles(context.substrateHome),
  },
};
