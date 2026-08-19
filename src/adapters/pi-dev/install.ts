import { skillsLoaderUnder, type SubstrateInstallSpec } from "../../install-spec";
import { PI_DEV_DEFAULT_HOME, piDevProjectionPrivateRoots } from "../private-roots";
import {
  PI_DEV_VSA_SKILL_ID,
  piDevVsaSkillDestinationDir,
  removeLegacyPiDevVsaSkillProjection,
} from "./skill-projection";
import { validatePiDevInstallRuntime } from "./version";

export const PI_DEV_HOME_FILES = [
  "agent/extensions/soma.ts",
  "agent/extensions/soma-path-guard.ts",
  "agent/extensions/soma-algorithm.ts",
  "agent/soma/context.md",
  "agent/soma/profile.md",
  "agent/soma/startup-context.md",
  "agent/soma/memory-layout.md",
  "agent/soma/pai-imports.md",
  "agent/soma/tools.md",
  "agent/soma/skills.md",
  "agent/soma/policy.md",
  // Conditional: omitted when the home has no `profile/communication.md`.
  "agent/soma/communication.md",
  "agent/soma/soma-repo.txt",
  "agent/skills/soma/SKILL.md",
] as const;

export const piDevInstallSpec: SubstrateInstallSpec<"pi-dev"> = {
  substrate: "pi-dev",
  defaultHome: PI_DEV_DEFAULT_HOME,
  homeFiles: PI_DEV_HOME_FILES,
  // Owned (Soma-exclusive) dir — see ownedSubtrees JSDoc. (agent/extensions + agent/skills shared.)
  ownedSubtrees: ["agent/soma"],
  skillsLoaderDir: skillsLoaderUnder("agent"),
  skillsLoading: "eager",
  skillsDiscovery: "catalog",
  vsaSkillProjection: {
    destinationDir: piDevVsaSkillDestinationDir,
    skillNameOverride: PI_DEV_VSA_SKILL_ID,
    prepare: removeLegacyPiDevVsaSkillProjection,
  },
  validator: validatePiDevInstallRuntime,
  lifecycleProjection: {
    startupContextPath: "agent/soma/startup-context.md",
    somaRepoPathPath: "agent/soma/soma-repo.txt",
  },
  privateRoots: {
    projection: piDevProjectionPrivateRoots,
  },
  uninstall: {
    kind: "reserved",
    reason: "Pi.dev uninstall is not implemented yet; extension and skill removal need a follow-up that preserves user-owned Pi.dev agent files.",
  },
};
