import { resolve } from "node:path";
import type { SubstrateInstallSpec } from "../../install-spec";
import { CLAUDE_CODE_RULES_FILES } from "../claude-code";

export const claudeCodeInstallSpec: SubstrateInstallSpec<"claude-code"> = {
  substrate: "claude-code",
  defaultHome: ".claude",
  homeFiles: CLAUDE_CODE_RULES_FILES,
  isaSkillProjection: {
    destinationDir: (substrateHome) => resolve(substrateHome, "skills/ISA"),
  },
  uninstall: {
    kind: "implemented",
    remove: ["rules/soma", "skills/ISA"],
  },
};
