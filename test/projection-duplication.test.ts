import { expect, test } from "bun:test";
import { projectClaudeCodeHome, projectCodexHome, projectCursor, projectPiDevHome } from "../src/index";
import { projectAnthropicCoworkHome } from "../src/adapters/anthropic-cowork";
import { portableProjectionInput } from "./fixtures";

const ASSISTANT_CORE_HEADINGS = ["## Assistant", "## Principal", "## Purpose", "## Active VSA"];

function contentAt(files: { path: string; content: string }[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  expect(file, `missing projected file ${path}`).toBeDefined();
  return file?.content ?? "";
}

test("profiles point to context without repeating assistant-core sections", () => {
  const projections = [
    {
      name: "claude-code",
      files: projectClaudeCodeHome(portableProjectionInput).files,
      contextPath: "rules/soma/CONTEXT.md",
      profilePath: "rules/soma/PROFILE.md",
    },
    {
      name: "cursor",
      files: projectCursor(portableProjectionInput).files,
      contextPath: ".cursor/rules/soma/CONTEXT.md",
      profilePath: ".cursor/rules/soma/PROFILE.md",
    },
    {
      name: "anthropic-cowork",
      files: projectAnthropicCoworkHome(portableProjectionInput).files,
      contextPath: "soma/instructions.md",
      profilePath: "soma/profile.md",
    },
    {
      name: "pi-dev",
      files: projectPiDevHome(portableProjectionInput, "/tmp/soma-home").files,
      contextPath: "agent/soma/context.md",
      profilePath: "agent/soma/profile.md",
    },
    {
      name: "codex",
      files: projectCodexHome(portableProjectionInput, "/tmp/soma-home").files,
      contextPath: "skills/soma/SKILL.md",
      profilePath: "memories/soma/profile.md",
    },
  ];

  for (const projection of projections) {
    const context = contentAt(projection.files, projection.contextPath);
    const profile = contentAt(projection.files, projection.profilePath);

    for (const heading of ASSISTANT_CORE_HEADINGS) {
      expect(context, `${projection.name} context must include ${heading}`).toContain(heading);
      expect(profile, `${projection.name} profile must not repeat ${heading}`).not.toContain(heading);
    }
    expect(profile).toContain("on-demand pointer");
  }
});

test("Claude profile points to its sibling context file", () => {
  const profile = contentAt(projectClaudeCodeHome(portableProjectionInput).files, "rules/soma/PROFILE.md");

  expect(profile).toContain("Read `CONTEXT.md beside this file`");
});

test("pi.dev loads context, not profile, on each agent turn", () => {
  const extension = contentAt(projectPiDevHome(portableProjectionInput, "/tmp/soma-home").files, "agent/extensions/soma.ts");

  expect(extension).toContain('if (action === "profile") return `${PI_SOMA_HOME}/profile.md`;');
  expect(extension).toContain('readText(`${PI_SOMA_HOME}/profile.md`)');
  expect(extension).not.toContain('const profile = readOptional(`${PI_SOMA_HOME}/profile.md`);');
  expect(extension).not.toContain("${profile}");
  expect(extension).toContain('const context = readOptional(`${PI_SOMA_HOME}/context.md`);');
  expect(extension).toContain("${context}");
});
