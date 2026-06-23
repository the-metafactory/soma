import { isaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
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
  // soma#329: the Purpose projection was renamed from TELOS.md → PURPOSE.md.
  // Claude Code auto-loads rules/soma/, so an upgrade must delete the stale
  // copy or it would keep loading frozen old content every session.
  obsoleteHomeFiles: ["rules/soma/TELOS.md"],
  optionalHomeFiles: (options) => isClaudeCodeInstallOptions(options) && options.modeClassifier === true
    ? [SOMA_CLAUDE_MODE_CLASSIFIER_RELATIVE_PATH, SOMA_CLAUDE_MODE_CLASSIFIER_CONFIG_RELATIVE_PATH]
    : [],
  isaSkillProjection: {
    destinationDir: isaSkillUnder(),
  },
  postProjection: [
    {
      name: "claude-code-soma-hooks",
      run: installClaudeCodeSomaHooks,
    },
  ],
  uninstall: {
    kind: "implemented",
    remove: ["rules/soma", "skills/ISA"],
    postRemove: (context) => removeClaudeCodeSomaHookFiles(context.substrateHome),
  },
};
