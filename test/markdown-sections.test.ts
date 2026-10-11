import { expect, test } from "bun:test";
import { selectMarkdownSections } from "../src/markdown-sections";

test("H1 ends H2, closing hashes and CRLF normalize, fences stay content", () => {
  const body = "## Constraints ##\r\none\r\n~~~md\r\n## Notes\r\n~~~\r\n# New document\r\nexcluded\r\n## Notes\r\ntwo";
  const result = selectMarkdownSections(body, ["constraints", "Notes"]);
  expect(result.missing).toEqual([]);
  expect(result.sections).toHaveLength(2);
  expect(result.sections[0].markdown).toContain("## Notes");
  expect(result.sections[0].markdown).not.toContain("excluded");
});
