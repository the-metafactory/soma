export const SKILL_MD = "SKILL.md";

const NAME_KEY = /^name:\s*(.+?)\s*$/m;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/;

export function rewriteSkillNameFrontmatter(relPath: string, content: string, skillName?: string): string {
  if (!skillName || relPath !== SKILL_MD) return content;
  const frontmatter = FRONTMATTER.exec(content);
  if (!frontmatter) return content;
  const rewritten = frontmatter[0].replace(NAME_KEY, `name: ${skillName}`);
  return `${rewritten}${content.slice(frontmatter[0].length)}`;
}
