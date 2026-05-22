import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isEnoent } from "../../fs-errors";
import { isaSkillUnder, type SubstrateInstallSpec } from "../../install-spec";
import { CURSOR_HOME_FILE_PATHS, CURSOR_RULES_BLOCK_BEGIN, CURSOR_RULES_BLOCK_END, CURSOR_RULES_PATH } from "../cursor";

async function shouldRemoveSomaRulesDir(target: string): Promise<boolean> {
  const markerFile = join(target, "README.md");
  try {
    const content = await readFile(markerFile, "utf8");
    return content.startsWith("# Soma Cursor Projection");
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
  isaSkillProjection: {
    destinationDir: isaSkillUnder(".cursor/rules/soma"),
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
