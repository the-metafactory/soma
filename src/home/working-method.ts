import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkingMethod } from "./types";

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
 * Source is the installed skills in the Soma home, not the bundled copy: the
 * index points at leaf files, and the pointers must resolve to the files a
 * substrate can actually read. The principles index comes from the-algorithm
 * skill; the playbooks index is the SKILL.md of the `playbooks` skill, which
 * the soma-pstack pack installs, so a home without the pack has no Playbooks
 * section. Each index's relative `references/...` pointers are rewritten to
 * absolute paths under its own skill's `references/` directory.
 *
 * Triggers is poteto-mode's "Remaining triggers" list. A skill declares a
 * `route:` line in its frontmatter, and the index carries that condition with
 * the skill's absolute SKILL.md path; a skill kept out of the skill catalog
 * (`disable-model-invocation`) is reached only this way. Only installed skills
 * that declare one are listed, so a pack ships its own rows.
 */

export const WORKING_METHOD_HEADING = "# Working Method";

export const PLAYBOOKS_SKILL = "playbooks";

const REPLY_RULES = [
  "The principles and playbooks below apply in every mode, not only in Algorithm runs. This index is always loaded; read a principle or card file when its trigger fires.",
  "",
  "- Read a principle's file before applying it. Cite only principles whose file you read this session.",
  "- Name a principle only next to the decision it changed. A principle named with no decision behind it is name-dropping; leave it out.",
];

const CARD_RULE =
  "- When a task matches a playbook card, copy its steps, verbatim and numbered, as the first items of the todo list. A step you choose not to do stays as `skip: <reason>`. A greeting or a one-line answer needs no card.";

export interface PlaybooksIndex {
  readonly source: string;
  readonly referencesDir: string;
}

export interface SkillRoute {
  readonly path: string;
  readonly route: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---/;
const FRONTMATTER_BLOCK = /^---\n[\s\S]*?\n---\n+/;
const ROUTE_KEY = /^route:\s*(.+?)\s*$/m;

/** The `route:` value of a SKILL.md frontmatter block, unquoted; `undefined` when absent. */
export function skillRoute(content: string): string | undefined {
  const block = FRONTMATTER.exec(content)?.[1];
  const value = block === undefined ? undefined : ROUTE_KEY.exec(block)?.[1];
  return value?.replace(/^"(.*)"$/, "$1");
}

/** Drop the source's frontmatter and own H1, and rewrite `references/` pointers to absolute paths. */
function section(heading: string, source: string, referencesDir: string): string[] {
  const body = source
    .replace(FRONTMATTER_BLOCK, "")
    .replace(/^# .*\n+/, "")
    .replaceAll("`references/", `\`${referencesDir}/`)
    .trimEnd();
  return [`## ${heading}`, "", body];
}

function triggersSection(routes: readonly SkillRoute[]): string[] {
  return [
    "## Triggers",
    "",
    "Skills routed by condition. When a row's condition fires, read that SKILL.md in full and follow it. A skill hidden from the skill catalog is reached only this way.",
    "",
    "| Skill | When it applies |",
    "| --- | --- |",
    ...routes.map(({ path, route }) => `| \`${path}\` | ${route.replaceAll("|", "\\|")} |`),
  ];
}

export function renderWorkingMethod(
  referencesDir: string,
  sources: { principles?: string; playbooks?: PlaybooksIndex; triggers?: readonly SkillRoute[] },
): string {
  const { playbooks } = sources;
  return [
    WORKING_METHOD_HEADING,
    "",
    ...REPLY_RULES,
    ...(playbooks === undefined ? [] : [CARD_RULE]),
    ...(sources.principles === undefined ? [] : ["", ...section("Principles", sources.principles, referencesDir)]),
    ...(playbooks === undefined ? [] : ["", ...section("Playbooks", playbooks.source, playbooks.referencesDir)]),
    ...(sources.triggers === undefined || sources.triggers.length === 0 ? [] : ["", ...triggersSection(sources.triggers)]),
  ].join("\n");
}

/** ENOTDIR covers `<file>/SKILL.md` for a stray file in the skills directory. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Every skill under `skillsDir` whose SKILL.md declares a `route:`, sorted by directory name. */
export async function readSkillRoutes(skillsDir: string): Promise<SkillRoute[]> {
  let names: string[];
  try {
    names = await readdir(skillsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const routes = await Promise.all(names.sort().map(async (name) => {
    const path = join(skillsDir, name, "SKILL.md");
    const content = await readOptional(path);
    const route = content === undefined ? undefined : skillRoute(content);
    return route === undefined ? undefined : { path, route };
  }));
  return routes.filter((entry): entry is SkillRoute => entry !== undefined);
}

/**
 * Absent indexes → `undefined`: a home with neither the-algorithm nor the
 * playbooks skill installed projects no working method rather than one with
 * dead pointers. Any other read error propagates.
 */
export async function readWorkingMethod(referencesDir: string, skillsDir?: string): Promise<WorkingMethod | undefined> {
  const playbooksDir = skillsDir === undefined ? undefined : join(skillsDir, PLAYBOOKS_SKILL);
  const [principles, playbooksSource, triggers] = await Promise.all([
    readOptional(join(referencesDir, "principles.md")),
    playbooksDir === undefined ? Promise.resolve(undefined) : readOptional(join(playbooksDir, "SKILL.md")),
    skillsDir === undefined ? Promise.resolve([]) : readSkillRoutes(skillsDir),
  ]);
  if (principles === undefined && playbooksSource === undefined) return undefined;
  const playbooks = playbooksSource === undefined || playbooksDir === undefined
    ? undefined
    : { source: playbooksSource, referencesDir: join(playbooksDir, "references") };
  return { content: renderWorkingMethod(referencesDir, { principles, playbooks, triggers }) };
}
