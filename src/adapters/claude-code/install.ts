import { isaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { CLAUDE_CODE_RULES_FILES } from "../claude-code";

export const claudeCodeInstallSpec: SubstrateInstallSpec<"claude-code"> = {
  substrate: "claude-code",
  defaultHome: ".claude",
  homeFiles: CLAUDE_CODE_RULES_FILES,
  isaSkillProjection: {
    destinationDir: isaSkillUnder(),
  },
  uninstall: {
    kind: "implemented",
    remove: ["rules/soma", "skills/ISA"],
  },
};
