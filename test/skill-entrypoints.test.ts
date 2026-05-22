import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const MAX_SKILL_ENTRYPOINT_LINES = 120;

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

test("checked-in skill entrypoints stay Codex-friendly", () => {
  const skillEntrypoints = [
    join(REPO_ROOT, "skill/SKILL.md"),
    ...collectSkillEntrypoints(join(REPO_ROOT, "src/skills")),
  ];

  expect(skillEntrypoints.length).toBeGreaterThan(0);

  for (const path of skillEntrypoints) {
    const text = readFileSync(path, "utf8");
    const lines = text.trimEnd().split("\n").length;

    expect(
      lines,
      `${relative(REPO_ROOT, path)} has ${lines} lines; keep SKILL.md <= ${MAX_SKILL_ENTRYPOINT_LINES} and move details to references/ or Workflows/.`,
    ).toBeLessThanOrEqual(MAX_SKILL_ENTRYPOINT_LINES);
  }
});
