import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import { extractSkillFrontmatter } from "../../skill-frontmatter";
// @ts-expect-error text import: inlined by bun, unknown to tsc
import runtimeSource from "./tool-nudges.mjs" with { type: "text" };

const pattern = z.string().min(1).refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}, "Invalid nudge regular expression");

const declaration = z.object({
  tool: pattern,
  command: pattern.optional(),
  text: z.string().min(1),
});
const frontmatter = z.object({ nudge: z.array(declaration).optional() });
const storedRule = declaration.extend({ file: z.string().min(1) });
export type ToolNudgeRule = z.infer<typeof storedRule>;

function isAbsent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function previousToolNudges(somaHome: string): Promise<ToolNudgeRule[]> {
  let rules: unknown;
  try {
    rules = JSON.parse(await readFile(join(somaHome, "runtime/tool-nudges.json"), "utf8"));
  } catch (error) {
    if (isAbsent(error)) return [];
    if (!(error instanceof SyntaxError)) throw error;
    console.warn(`Cannot retain previous Soma tool nudges: ${error.message}`);
    return [];
  }
  const result = z.array(storedRule).safeParse(rules);
  if (result.success) return result.data;
  console.warn(`Cannot retain previous Soma tool nudges: ${result.error.message}`);
  return [];
}

const PRINCIPLE_ROOT = "skills/the-algorithm/references/principles";
const PRINCIPLE_NUDGES: readonly ToolNudgeRule[] = [
  {
    tool: "^(Agent|Task)$",
    file: `${PRINCIPLE_ROOT}/own-delegated-work.md`,
    text: "A subagent just reported. Read {path} before you relay or act on its result.",
  },
  {
    tool: "^Bash$",
    command: String.raw`^gh\s+(?:pr\s+(?:view|checks)\b|api\b[^\n]*\/(?:comments|reviews)\b)`,
    file: `${PRINCIPLE_ROOT}/weigh-review-findings-on-merit.md`,
    text: "This output may carry automated review findings. Read {path} and weigh each one on its merits.",
  },
  {
    tool: "^Bash$",
    command: String.raw`^(?:git\s+(?:-C\s+\S+\s+)*commit\b|gh\s+pr\s+create\b)`,
    file: `${PRINCIPLE_ROOT}/verify-before-claiming.md`,
    text: "You committed or opened a PR. Read {path} before you call the work done.",
  },
];

class InvalidNudgeDeclaration extends Error {}

export function skillNudges(content: string, file: string): ToolNudgeRule[] {
  const block = extractSkillFrontmatter(content);
  if (block === undefined || !/^nudge:/m.test(block)) return [];
  const parsed: unknown = parse(block);
  const result = frontmatter.safeParse(parsed);
  if (!result.success) throw new InvalidNudgeDeclaration(`Invalid nudge declaration in ${file}: ${result.error.message}`);
  return (result.data.nudge ?? []).map((rule) => ({ ...rule, file }));
}

export async function readToolNudges(somaHome: string): Promise<ToolNudgeRule[]> {
  const skillsDir = join(somaHome, "skills");
  let names: string[];
  try {
    names = await readdir(skillsDir);
  } catch (error) {
    if (isAbsent(error)) return [...PRINCIPLE_NUDGES];
    throw error;
  }
  let previous: Promise<ToolNudgeRule[]> | undefined;
  const skills = await Promise.all(names.sort().map(async (name) => {
    const file = `skills/${name}/SKILL.md`;
    let content: string;
    try {
      content = await readFile(join(somaHome, file), "utf8");
    } catch (error) {
      if (isAbsent(error)) return [];
      throw error;
    }
    try {
      return skillNudges(content, file);
    } catch (error) {
      if (!(error instanceof InvalidNudgeDeclaration || error instanceof YAMLParseError)) throw error;
      console.warn(`Skipping invalid Soma nudges in ${file}; retaining previous rules: ${error instanceof Error ? error.message : String(error)}`);
      previous ??= previousToolNudges(somaHome);
      return (await previous).filter((rule) => rule.file === file);
    }
  }));
  return [...PRINCIPLE_NUDGES, ...skills.flat()];
}

export async function installToolNudges({ somaHome }: { somaHome: string }): Promise<string[]> {
  const rules = await readToolNudges(somaHome);
  const runtime = join(somaHome, "runtime");
  await mkdir(runtime, { recursive: true });
  const files = [
    { path: join(runtime, "tool-nudges.mjs"), content: String(runtimeSource) },
    { path: join(runtime, "tool-nudges.json"), content: `${JSON.stringify(rules, null, 2)}\n` },
  ];
  for (const { path, content } of files) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  }
  // Shared Soma runtime assets are not substrate projection files.
  return [];
}
