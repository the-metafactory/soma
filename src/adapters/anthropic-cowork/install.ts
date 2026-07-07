import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isEnoent } from "../../fs-errors";
import { skillsLoaderUnder, type SubstrateInstallSpec, type UninstallContext } from "../../install-spec";
import { projectVsaSkillBundleFiles } from "../../vsa-skill-installer";
import {
  ANTHROPIC_COWORK_ACTIVE_VSA_PATH,
  ANTHROPIC_COWORK_ACTIVE_VSA_MARKER,
  ANTHROPIC_COWORK_DEFAULT_HOME,
  ANTHROPIC_COWORK_ENTRYPOINT_PATH,
  ANTHROPIC_COWORK_GENERATED_HOME_FILE_MARKERS,
  ANTHROPIC_COWORK_HOME_FILE_PATHS,
  ANTHROPIC_COWORK_SKILLS_ROOT_PATH,
} from "../anthropic-cowork";

type CoworkRemovalTargetKind = "entrypoint" | "projection-file" | "vsa-skill";

function coworkRemovalTarget(target: string): { kind: CoworkRemovalTargetKind; markerFile: string } {
  const normalizedTarget = target.replaceAll("\\", "/");
  if (normalizedTarget.endsWith("SOMA.md")) {
    return { kind: "entrypoint", markerFile: target };
  }
  if (normalizedTarget.endsWith("skills/VSA")) {
    return { kind: "vsa-skill", markerFile: join(target, "SKILL.md") };
  }
  return { kind: "projection-file", markerFile: target };
}

function isGeneratedCoworkHomeFile(target: string, content: string): boolean {
  const normalizedTarget = target.replaceAll("\\", "/");
  if (normalizedTarget.endsWith(ANTHROPIC_COWORK_ACTIVE_VSA_PATH)) {
    return content.startsWith(ANTHROPIC_COWORK_ACTIVE_VSA_MARKER);
  }
  return ANTHROPIC_COWORK_GENERATED_HOME_FILE_MARKERS.some((file) => {
    if (!normalizedTarget.endsWith(file.path)) return false;
    return file.markerMatch === "includes" ? content.includes(file.marker) : content.startsWith(file.marker);
  });
}

async function hasGeneratedCoworkRoot(context: UninstallContext): Promise<boolean> {
  try {
    const entrypoint = resolve(context.substrateHome, ANTHROPIC_COWORK_ENTRYPOINT_PATH);
    const content = await readFile(entrypoint, "utf8");
    return isGeneratedCoworkHomeFile(entrypoint, content);
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

const generatedRootCache = new WeakMap<UninstallContext, Promise<boolean>>();

function cachedGeneratedCoworkRoot(context: UninstallContext): Promise<boolean> {
  const cached = generatedRootCache.get(context);
  if (cached) return cached;
  const result = hasGeneratedCoworkRoot(context);
  generatedRootCache.set(context, result);
  return result;
}

async function isGeneratedCoworkVsaSkill(content: string): Promise<boolean> {
  const files = await projectVsaSkillBundleFiles({
    destinationPrefix: "skills/VSA",
    projectionSubstrate: "anthropic-cowork",
  });
  const generatedSkill = files.find((file) => file.path === "skills/VSA/SKILL.md");
  return generatedSkill?.content === content;
}

async function shouldRemoveCoworkProjection(target: string, context: UninstallContext): Promise<boolean> {
  const removalTarget = coworkRemovalTarget(target);
  try {
    const content = await readFile(removalTarget.markerFile, "utf8");
    switch (removalTarget.kind) {
      case "entrypoint":
        return isGeneratedCoworkHomeFile(target, content);
      case "vsa-skill":
        if (!(await cachedGeneratedCoworkRoot(context))) return false;
        return isGeneratedCoworkVsaSkill(content);
      case "projection-file":
        if (!(await cachedGeneratedCoworkRoot(context))) return false;
        return isGeneratedCoworkHomeFile(target, content);
    }
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

export const anthropicCoworkInstallSpec: SubstrateInstallSpec<"anthropic-cowork"> = {
  substrate: "anthropic-cowork",
  defaultHome: ANTHROPIC_COWORK_DEFAULT_HOME,
  homeFiles: ANTHROPIC_COWORK_HOME_FILE_PATHS,
  skillsLoaderDir: skillsLoaderUnder(ANTHROPIC_COWORK_SKILLS_ROOT_PATH),
  vsaSkillProjection: {
    destinationDir: (substrateHome) => resolve(substrateHome, "skills", "VSA"),
  },
  privateRoots: {
    projection: (options) => {
      const homeDir = resolve(options?.homeDir ?? homedir());
      const substrateHome = resolve(options?.substrateHome ?? join(homeDir, ANTHROPIC_COWORK_DEFAULT_HOME));
      return [
        resolve(substrateHome, "soma"),
        resolve(substrateHome, "capture"),
        resolve(substrateHome, "skills/VSA"),
      ];
    },
  },
  uninstall: {
    kind: "implemented",
    remove: [
      ...ANTHROPIC_COWORK_HOME_FILE_PATHS.filter((path) => path !== ANTHROPIC_COWORK_ENTRYPOINT_PATH),
      ANTHROPIC_COWORK_ACTIVE_VSA_PATH,
      "skills/VSA",
      ANTHROPIC_COWORK_ENTRYPOINT_PATH,
    ],
    shouldRemove: (target, context) => shouldRemoveCoworkProjection(target, context),
  },
};
