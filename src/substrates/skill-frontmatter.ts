export const SKILL_MD = "SKILL.md";

const NAME_KEY = /^name:\s*(.+?)\s*$/m;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

/**
 * The leading YAML frontmatter of a SKILL.md, WITHOUT its `---` fences, or
 * undefined when the file has none. Shares {@link FRONTMATTER} with
 * `rewriteSkillNameFrontmatter` so the fence format has a single definition
 * (soma#542 added the second reader).
 */
export function extractSkillFrontmatter(content: string): string | undefined {
  return FRONTMATTER.exec(content)?.[1];
}

export function rewriteSkillNameFrontmatter(relPath: string, content: string, skillName?: string): string {
  if (!skillName || relPath !== SKILL_MD) return content;
  const frontmatter = FRONTMATTER.exec(content);
  if (!frontmatter) return content;
  const rewritten = frontmatter[0].replace(NAME_KEY, `name: ${skillName}`);
  return `${rewritten}${content.slice(frontmatter[0].length)}`;
}
