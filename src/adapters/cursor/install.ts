import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isEnoent } from "../../fs-errors";
import { skillsLoaderUnder, vsaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { writeProjection } from "../../projection";
import { CURSOR_HOME_FILE_PATHS, CURSOR_RULES_BLOCK_BEGIN, CURSOR_RULES_BLOCK_END, CURSOR_RULES_PATH, isCursorSkillProjectionPath, projectCursorHome } from "../cursor";
import { stripProvenance } from "../shared";

function renderCursorRulesBlock(content: string): string {
  return `${CURSOR_RULES_BLOCK_BEGIN}\n${content.trimEnd()}\n${CURSOR_RULES_BLOCK_END}`;
}

function replaceCursorRulesBlock(existing: string, generated: string): string {
  const start = existing.indexOf(CURSOR_RULES_BLOCK_BEGIN);
  if (start === -1) return `${existing.trimEnd()}\n\n${renderCursorRulesBlock(generated)}\n`;
  const end = existing.indexOf(CURSOR_RULES_BLOCK_END, start);
  if (end === -1) return `${existing.trimEnd()}\n\n${renderCursorRulesBlock(generated)}\n`;
  const before = existing.slice(0, start).trimEnd();
  const after = existing.slice(end + CURSOR_RULES_BLOCK_END.length).trimStart();
  const next = [before, renderCursorRulesBlock(generated), after.trimEnd()].filter((part) => part.length > 0).join("\n\n");
  return `${next}\n`;
}

/** The Cursor-managed block definition shared by the writer and doctor. */
export function mergeCursorRulesContent(existing: string, generated: string): string {
  if (existing.length === 0 || existing.startsWith("# Soma Cursor Projection")) {
    return `${generated.trimEnd()}\n`;
  }
  return replaceCursorRulesBlock(existing, generated);
}

async function mergeCursorRulesFile(target: string, generated: string): Promise<string> {
  const existing = await readFile(target, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") return "";
    throw error;
  });
  return mergeCursorRulesContent(existing, generated);
}

async function shouldRemoveSomaRulesDir(target: string): Promise<boolean> {
  const markerFile = join(target, "README.md");
  try {
    const content = await readFile(markerFile, "utf8");
    // soma#370: README.md now carries the byte-stable provenance header, so
    // strip it before checking the marker prefix — otherwise every cursor
    // uninstall silently no-ops (a real regression this fixes).
    return stripProvenance(content).startsWith("# Soma Cursor Projection");
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

async function removeCursorRulesProjection(path: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }

  if (content.startsWith("# Soma Cursor Projection")) {
    await rm(path, { force: true });
    return true;
  }

  const start = content.indexOf(CURSOR_RULES_BLOCK_BEGIN);
  if (start === -1) return false;
  const end = content.indexOf(CURSOR_RULES_BLOCK_END, start);
  if (end === -1) return false;

  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end + CURSOR_RULES_BLOCK_END.length).trimStart();
  const preserved = [before, after.trimEnd()].filter((part) => part.length > 0).join("\n\n");
  if (preserved.length === 0) {
    await rm(path, { force: true });
    return true;
  }
  await writeFile(path, `${preserved}\n`, "utf8");
  return true;
}

export const cursorInstallSpec: SubstrateInstallSpec<"cursor"> = {
  substrate: "cursor",
  defaultHome: ".",
  homeFiles: CURSOR_HOME_FILE_PATHS,
  homeProjection: {
    build: (input) => projectCursorHome(input),
    isSkillProjectionPath: isCursorSkillProjectionPath,
    write: async (projection) => {
      const cursorRules = projection.bundle.files.find((file) => file.path === CURSOR_RULES_PATH);
      const projectionWithoutCursorRules = {
        ...projection.bundle,
        files: projection.bundle.files.filter((file) => file.path !== CURSOR_RULES_PATH),
      };
      const written = await writeProjection(projectionWithoutCursorRules, projection.substrateHome);
      if (cursorRules) {
        const target = resolve(projection.substrateHome, CURSOR_RULES_PATH);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await mergeCursorRulesFile(target, cursorRules.content), "utf8");
        written.files.push(target);
      }
      return written;
    },
  },
  // Owned (Soma-exclusive) dir — see ownedSubtrees JSDoc. Subsumes the former
  // obsoleteHomeFiles for TELOS.md/ACTIVE_ISA.md under .cursor/rules/soma.
  ownedSubtrees: [".cursor/rules/soma"],
  skillsLoaderDir: skillsLoaderUnder(".cursor/rules/soma"),
  skillsLoading: "on-demand",
  skillsDiscovery: "catalog",
  vsaSkillProjection: {
    destinationDir: vsaSkillUnder(".cursor/rules/soma"),
  },
  uninstall: {
    kind: "implemented",
    remove: [".cursor/rules/soma"],
    shouldRemove: (target) => shouldRemoveSomaRulesDir(target),
    postRemove: async ({ substrateHome }) => {
      const cursorRulesFile = join(substrateHome, CURSOR_RULES_PATH);
      return (await removeCursorRulesProjection(cursorRulesFile)) ? [cursorRulesFile] : [];
    },
  },
};
