import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The working method: the Algorithm's principles and playbooks indexes,
 * projected as an always-loaded rules file so they bind in every mode, not
 * only inside an Algorithm run.
 *
 * This is pstack's poteto-mode shape: the one-line index is always in
 * context, and a principle or card file is read only when its trigger fires.
 * Before this projection the indexes sat in `references/` of the-algorithm
 * skill, so a NATIVE turn never saw them.
 *
 * Source is the installed the-algorithm skill in the Soma home, not the
 * bundled copy: the index points at leaf files, and the pointers must resolve
 * to the files a substrate can actually read. The relative `references/...`
 * pointers are rewritten to absolute paths under that directory.
 */
export interface WorkingMethod {
  readonly content: string;
}

export const WORKING_METHOD_HEADING = "# Working Method";

const REPLY_RULES = [
  "The principles and playbooks below apply in every mode, not only in Algorithm runs. This index is always loaded; read a principle or card file when its trigger fires.",
  "",
  "- Read a principle's file before applying it. Cite only principles whose file you read this session.",
  "- Name a principle only next to the decision it changed. A principle named with no decision behind it is name-dropping; leave it out.",
  "- When a task matches a playbook card, copy its steps, verbatim and numbered, as the first items of the todo list. A step you choose not to do stays as `skip: <reason>`. A greeting or a one-line answer needs no card.",
];

/** Drop the source's own H1 and rewrite `references/` pointers to absolute paths. */
function section(heading: string, source: string, referencesDir: string): string[] {
  const body = source
    .replace(/^# .*\n+/, "")
    .replaceAll("`references/", `\`${referencesDir}/`)
    .trimEnd();
  return [`## ${heading}`, "", body];
}

export function renderWorkingMethod(
  referencesDir: string,
  sources: { principles?: string; playbooks?: string },
): string {
  return [
    WORKING_METHOD_HEADING,
    "",
    ...REPLY_RULES,
    ...(sources.principles === undefined ? [] : ["", ...section("Principles", sources.principles, referencesDir)]),
    ...(sources.playbooks === undefined ? [] : ["", ...section("Playbooks", sources.playbooks, referencesDir)]),
  ].join("\n");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Absent indexes → `undefined`: a home without the-algorithm installed projects
 * no working method rather than one with dead pointers. Any other read error
 * propagates.
 */
export async function readWorkingMethod(referencesDir: string): Promise<WorkingMethod | undefined> {
  const [principles, playbooks] = await Promise.all([
    readOptional(join(referencesDir, "principles.md")),
    readOptional(join(referencesDir, "playbooks.md")),
  ]);
  if (principles === undefined && playbooks === undefined) return undefined;
  return { content: renderWorkingMethod(referencesDir, { principles, playbooks }) };
}
