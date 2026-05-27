import { isaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { CLAUDE_CODE_RULES_FILES } from "../claude-code";
import {
  SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
  SOMA_CLAUDE_HOOK_RELATIVE_PATH,
  installClaudeCodeSomaHooks,
  removeClaudeCodeSomaHookFiles,
} from "./hooks";

export const claudeCodeInstallSpec: SubstrateInstallSpec<"claude-code"> = {
  substrate: "claude-code",
  defaultHome: ".claude",
  homeFiles: [
    ...CLAUDE_CODE_RULES_FILES,
    SOMA_CLAUDE_HOOK_RELATIVE_PATH,
    SOMA_CLAUDE_HOOK_CONFIG_RELATIVE_PATH,
    "settings.json",
  ],
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
