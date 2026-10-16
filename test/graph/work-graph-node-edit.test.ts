import { expect, test } from "bun:test";
import { replaceNodeProse } from "../../src/graph/index";

test("prose edits retain node and GitLab routing blocks verbatim", () => {
  const node = '<!-- soma:work-graph-node\n{ "autonomy": "approve" }\n-->';
  const route = '<!-- soma:gitlab-work-graph-route\n{"homeProject":"group/project"}\n-->';
  expect(replaceNodeProse(`old\n${node}\n${route}`, "new")).toBe(`new\n\n${node}\n\n${route}`);
  expect(replaceNodeProse(node, `new\n${node}`)).toBe(`new\n\n${node}`);
  expect(() => replaceNodeProse(node, `${node}\n${node}`)).toThrow();
  expect(() => replaceNodeProse(node, "<!-- soma:work-graph-node")).toThrow("unterminated");
  expect(() => replaceNodeProse("<!-- soma:work-graph-node", "new")).toThrow("unterminated");
});
