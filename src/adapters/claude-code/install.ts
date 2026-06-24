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
  // soma#329: projections renamed TELOS.md → PURPOSE.md and ACTIVE_ISA.md →
  // ACTIVE_VSA.md. Claude Code auto-loads rules/soma/, so an upgrade must delete
  // the stale copies or it would keep loading frozen old content every session.
  obsoleteHomeFiles: ["rules/soma/TELOS.md", "rules/soma/ACTIVE_ISA.md"],
  // Soma-exclusive subtrees — reconciled to the projected set each install so any
  // renamed/recased/removed projection self-cleans (no per-rename bookkeeping).
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
