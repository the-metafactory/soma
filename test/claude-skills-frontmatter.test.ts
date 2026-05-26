import { expect, test } from "bun:test";
import { parseDescriptionFromFrontmatter } from "../src/claude-skills-frontmatter";

test("parseDescriptionFromFrontmatter reads literal block scalar descriptions", () => {
  const skillMd = [
    "---",
    "name: BlockSkill",
    "description: |",
    "  First line.",
    "  Second line with more detail.",
    "allowed-tools: Read",
    "---",
    "",
    "# BlockSkill",
    "",
  ].join("\n");

  expect(parseDescriptionFromFrontmatter(skillMd)).toBe("First line.\nSecond line with more detail.");
});

test("parseDescriptionFromFrontmatter reads folded block scalar descriptions", () => {
  const skillMd = [
    "---",
    "name: FoldedSkill",
    "description: >",
    "  First line",
    "  continues here.",
    "",
    "  Second paragraph.",
    "allowed-tools: Read",
    "---",
    "",
    "# FoldedSkill",
    "",
  ].join("\n");

  expect(parseDescriptionFromFrontmatter(skillMd)).toBe("First line continues here.\nSecond paragraph.");
});
