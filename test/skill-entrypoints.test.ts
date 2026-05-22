import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const MAX_SKILL_ENTRYPOINT_LINES = 120;
const MAX_WAIVED_SKILL_ENTRYPOINT_LINES = 240;

function collectSkillEntrypoints(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);

      if (stat.isDirectory()) {
        walk(path);
        continue;
      }

      if (entry === "SKILL.md") {
        results.push(path);
      }
    }
  }

  walk(root);
  return results;
}

function readEntrypointBudget(text: string): { maxLines: number; exception?: string } {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const maxLinesRaw = /^codex-entrypoint-max-lines:\s*(\d+)\s*$/m.exec(frontmatter)?.[1];
  const exception = /^codex-entrypoint-exception:\s*"(.+)"\s*$/m.exec(frontmatter)?.[1];

  if (!maxLinesRaw) {
    return { maxLines: MAX_SKILL_ENTRYPOINT_LINES };
  }

  const maxLines = Number(maxLinesRaw);
  expect(maxLines).toBeGreaterThan(MAX_SKILL_ENTRYPOINT_LINES);
  expect(maxLines).toBeLessThanOrEqual(MAX_WAIVED_SKILL_ENTRYPOINT_LINES);
  expect(exception?.length ?? 0).toBeGreaterThanOrEqual(20);

  return { maxLines, exception };
}

test("checked-in skill entrypoints stay Codex-friendly", () => {
  const skillEntrypoints = [
    join(REPO_ROOT, "skill/SKILL.md"),
    ...collectSkillEntrypoints(join(REPO_ROOT, "src/skills")),
  ];

  expect(skillEntrypoints.length).toBeGreaterThan(0);

  for (const path of skillEntrypoints) {
    const text = readFileSync(path, "utf8");
    const lines = text.trimEnd().split("\n").length;
    const budget = readEntrypointBudget(text);

    expect(
      lines,
      `${relative(REPO_ROOT, path)} has ${lines} lines; keep SKILL.md <= ${budget.maxLines} and move details to references/ or Workflows/.`,
    ).toBeLessThanOrEqual(budget.maxLines);
  }
});
