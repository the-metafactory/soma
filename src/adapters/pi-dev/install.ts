import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SubstrateInstallSpec } from "../../install-spec";
import type { SubstrateId } from "../../types";
import {
  PI_DEV_ISA_SKILL_ID,
  piDevIsaSkillDestinationDir,
  removeLegacyPiDevIsaSkillProjection,
} from "./skill-projection";
import { validatePiDevInstallRuntime } from "./version";

const PI_DEV_DEFAULT_HOME = ".pi";

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
  "agent/soma/soma-repo.txt",
  "agent/skills/soma/SKILL.md",
] as const;

function piDevProjectionPrivateRoots(options: { homeDir?: string; substrate?: SubstrateId } = {}): string[] {
  if (options.substrate !== undefined && options.substrate !== "pi-dev") return [];
  const home = resolve(options.homeDir ?? homedir());
  return [
    join(home, PI_DEV_DEFAULT_HOME, "agent", "soma"),
    join(home, PI_DEV_DEFAULT_HOME, "agent", "skills", "soma"),
  ].map((path) => resolve(path));
}

export const piDevInstallSpec: SubstrateInstallSpec<"pi-dev"> = {
  substrate: "pi-dev",
  defaultHome: PI_DEV_DEFAULT_HOME,
  homeFiles: PI_DEV_HOME_FILES,
  isaSkillProjection: {
    destinationDir: piDevIsaSkillDestinationDir,
    skillNameOverride: PI_DEV_ISA_SKILL_ID,
    prepare: removeLegacyPiDevIsaSkillProjection,
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
