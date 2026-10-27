import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectClaudeCode, projectClaudeCodeHome } from "../../src/substrates/adapters/claude-code";
import { projectCodex, projectCodexHome } from "../../src/substrates/adapters/codex/adapter";
import { projectCursor } from "../../src/substrates/adapters/cursor";
import { projectDsh, projectDshHome } from "../../src/substrates/adapters/dsh/adapter";
import { projectGrok, projectGrokHome } from "../../src/substrates/adapters/grok/adapter";
import { projectPiDev, projectPiDevHome } from "../../src/substrates/adapters/pi-dev/adapter";
import type { Projection } from "../../src/substrates/types";
import { type ProjectionInput } from "../../src/home/types";
import { projectAnthropicCoworkHome } from "../../src/substrates/adapters/anthropic-cowork";
import { configureCodexAgentsImport } from "../../src/substrates/adapters/codex/install";
import { readWorkingMethod, WORKING_METHOD_HEADING } from "../../src/home/index";
import { portableProjectionInput } from "../fixtures";

const WORKING_METHOD = `${WORKING_METHOD_HEADING}\n\n## Principles\n\n| \`/home/references/principles/reproduce-first.md\` | a bug report |\n`;

const withMethod: ProjectionInput = {
  ...portableProjectionInput,
  profile: { ...portableProjectionInput.profile, workingMethod: { content: WORKING_METHOD } },
};

const withoutMethod: ProjectionInput = {
  ...portableProjectionInput,
  profile: { ...portableProjectionInput.profile, workingMethod: undefined },
};

function methodFiles(input: ProjectionInput): { name: string; file?: { path: string; content: string } }[] {
  const pick = (name: string, projection: Projection, path: string) => ({
    name,
    file: projection.files.find((candidate) => candidate.path === path),
  });
  return [
    pick("claude-code (workspace)", projectClaudeCode(input), ".claude/soma/principles.md"),
    pick("claude-code (home)", projectClaudeCodeHome(input), "rules/soma/PRINCIPLES.md"),
    pick("cursor", projectCursor(input), ".cursor/rules/soma/PRINCIPLES.md"),
    pick("anthropic-cowork", projectAnthropicCoworkHome(input), "soma/principles.md"),
    pick("pi-dev (workspace)", projectPiDev(input), ".pi/extensions/soma-core/principles.md"),
    pick("pi-dev (home)", projectPiDevHome(input, "/tmp/soma-home"), "agent/soma/principles.md"),
    pick("codex (workspace)", projectCodex(input), ".codex/soma/principles.md"),
    pick("codex (home)", projectCodexHome(input, "/tmp/soma-home"), "memories/soma/principles.md"),
    pick("grok (workspace)", projectGrok(input), ".grok/rules/soma/principles.md"),
    pick("grok (home)", projectGrokHome(input, "/tmp/soma-home"), "skills/soma/principles.md"),
    pick("dsh (workspace)", projectDsh(input), ".dsh/soma/principles.md"),
    pick("dsh (home)", projectDshHome(input, "/tmp/soma-home"), "skills/soma/principles.md"),
  ];
}

function text(projection: Projection, path: string): string {
  return projection.files.find((file) => file.path === path)?.content ?? "";
}

test("every substrate projects the working method, byte-identical across substrates", () => {
  for (const { name, file } of methodFiles(withMethod)) {
    expect(file, `${name} did not project the working method`).toBeDefined();
    expect(file?.content, `${name} re-rendered the working method`).toBe(WORKING_METHOD);
  }
});

test("a home without the-algorithm projects no working-method file", () => {
  for (const { name, file } of methodFiles(withoutMethod)) {
    expect(file, `${name} projected a working method with no source`).toBeUndefined();
  }
});

test("every substrate is told to read the working method, not just handed the file", () => {
  const instructionSurfaces: { name: string; text: string }[] = [
    { name: "claude-code (CLAUDE.md)", text: text(projectClaudeCode(withMethod), "CLAUDE.md") },
    { name: "claude-code (rules README)", text: text(projectClaudeCodeHome(withMethod), "rules/soma/README.md") },
    { name: "cursor (.cursorrules)", text: text(projectCursor(withMethod), ".cursorrules") },
    { name: "cursor (rules README)", text: text(projectCursor(withMethod), ".cursor/rules/soma/README.md") },
    { name: "anthropic-cowork (SOMA.md)", text: text(projectAnthropicCoworkHome(withMethod), "SOMA.md") },
    { name: "anthropic-cowork (README)", text: text(projectAnthropicCoworkHome(withMethod), "soma/README.md") },
    { name: "codex (home SKILL.md)", text: text(projectCodexHome(withMethod, "/tmp/soma-home"), "skills/soma/SKILL.md") },
    { name: "grok (home SKILL.md)", text: text(projectGrokHome(withMethod, "/tmp/soma-home"), "skills/soma/SKILL.md") },
    { name: "grok (rules README)", text: text(projectGrok(withMethod), ".grok/rules/soma/README.md") },
    { name: "pi-dev (workspace context)", text: text(projectPiDev(withMethod), ".pi/extensions/soma-core/context.md") },
    { name: "codex (workspace context)", text: text(projectCodex(withMethod), ".codex/soma/context.md") },
    { name: "grok (workspace context)", text: text(projectGrok(withMethod), ".grok/rules/soma/context.md") },
    { name: "dsh (home SKILL.md)", text: text(projectDshHome(withMethod, "/tmp/soma-home"), "skills/soma/SKILL.md") },
    { name: "dsh (workspace context)", text: text(projectDsh(withMethod), ".dsh/soma/context.md") },
  ];

  const projecting = methodFiles(withMethod)
    .filter((entry) => entry.file !== undefined)
    .map((entry) => entry.name.replace(/ \(.*/, ""));
  for (const substrate of new Set(projecting)) {
    expect(
      instructionSurfaces.some((surface) => surface.name.startsWith(substrate)),
      `${substrate} projects the working method but no instruction surface is checked for it`,
    ).toBe(true);
  }
  for (const { name, text: content } of instructionSurfaces) {
    expect(content.toLowerCase(), `${name} never names principles.md`).toContain("principles.md");
  }
});

test("pi-dev appends the working method to the system prompt, and the extension still parses", () => {
  const extension = text(projectPiDevHome(withMethod, "/tmp/soma-home"), "agent/extensions/soma.ts");
  expect(extension).toContain("cachedWorkingMethod ??= readOptional(`${PI_SOMA_HOME}/principles.md`)");
  expect(extension).toContain("${principles}");
  expect(extension).toContain("cachedWorkingMethod = undefined;");

  const messagePath = extension.slice(extension.indexOf('pi.on("before_agent_start"'), extension.indexOf("const somaPrompt"));
  expect(messagePath).toContain("const principles = workingMethod();");
  expect(messagePath).not.toContain("readOptional(`${PI_SOMA_HOME}/principles.md`)");

  // learning-pi-dev-generated-code-guards: toContain passes on broken output;
  // transpiling is what proves the emitted extension parses.
  new Bun.Transpiler({ loader: "ts" }).transformSync(extension);
});

test("the loader renders both indexes with absolute pointers into each installed skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "soma-working-method-"));
  try {
    const skillsDir = join(root, "skills");
    const referencesDir = join(skillsDir, "the-algorithm", "references");
    const playbooksDir = join(skillsDir, "playbooks");
    expect(await readWorkingMethod(referencesDir, skillsDir)).toBeUndefined();

    await mkdir(referencesDir, { recursive: true });
    await writeFile(
      join(referencesDir, "principles.md"),
      "# Principles\n\nRead `references/principles.local.md` first.\n\n| `references/principles/reproduce-first.md` | a bug report |\n",
    );
    const vanilla = (await readWorkingMethod(referencesDir, skillsDir))?.content ?? "";
    expect(vanilla).toContain("## Principles");
    expect(vanilla).not.toContain("## Playbooks");
    expect(vanilla).not.toContain("playbook card, copy its steps");

    await mkdir(playbooksDir, { recursive: true });
    await writeFile(
      join(playbooksDir, "SKILL.md"),
      "---\nname: playbooks\ndisable-model-invocation: true\n---\n\n# Playbooks\n\n| `references/bug-fix.md` | broken |\n",
    );

    const content = (await readWorkingMethod(referencesDir, skillsDir))?.content ?? "";
    expect(content.startsWith(`${WORKING_METHOD_HEADING}\n`)).toBe(true);
    expect(content).toContain("## Principles");
    expect(content).toContain("## Playbooks");
    expect(content).toContain("playbook card, copy its steps");
    expect(content).toContain(`\`${referencesDir}/principles/reproduce-first.md\``);
    expect(content).toContain(`\`${referencesDir}/principles.local.md\``);
    expect(content).toContain(`\`${join(playbooksDir, "references", "bug-fix.md")}\``);
    expect(content).not.toContain("`references/");
    expect(content).not.toContain("disable-model-invocation");
    expect(content).not.toMatch(/^# (Principles|Playbooks)$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the loader lists only installed skills that declare a route, with absolute SKILL.md paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "soma-working-method-triggers-"));
  try {
    const skillsDir = join(root, "skills");
    const referencesDir = join(skillsDir, "the-algorithm", "references");
    await mkdir(referencesDir, { recursive: true });
    await writeFile(join(referencesDir, "principles.md"), "# Principles\n\n| `references/principles/reproduce-first.md` | a bug report |\n");
    await writeFile(join(skillsDir, "the-algorithm", "SKILL.md"), "---\nname: the-algorithm\n---\n\nroute: in the body, not frontmatter\n");
    for (const [name, frontmatter] of [
      ["benchmark-checklist", 'name: benchmark-checklist\ndisable-model-invocation: true\nroute: "running a benchmark | claiming a speedup"'],
      ["hidden-no-route", "name: hidden-no-route\ndisable-model-invocation: true"],
    ]) {
      await mkdir(join(skillsDir, name), { recursive: true });
      await writeFile(join(skillsDir, name, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n`);
    }
    await writeFile(join(skillsDir, ".DS_Store"), "");

    const content = (await readWorkingMethod(referencesDir, skillsDir))?.content ?? "";
    const rows = content.slice(content.indexOf("## Triggers")).split("\n").filter((line) => line.startsWith("| `"));
    expect(rows).toEqual([`| \`${join(skillsDir, "benchmark-checklist", "SKILL.md")}\` | running a benchmark \\| claiming a speedup |`]);

    await rm(join(skillsDir, "benchmark-checklist"), { recursive: true });
    expect((await readWorkingMethod(referencesDir, skillsDir))?.content).not.toContain("## Triggers");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped index leaves no relative pointer behind after rendering, and ships no cards", async () => {
  const referencesDir = join(import.meta.dir, "../..", "src", "skills", "the-algorithm", "references");
  const content = (await readWorkingMethod(referencesDir, join(import.meta.dir, "../..", "src", "skills")))?.content ?? "";
  expect(content).toContain("## Principles");
  expect(content).not.toContain("## Playbooks");
  expect(content).not.toContain("`references/");
});

test("codex AGENTS import follows the working method: appended when projected, removed when not", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "soma-codex-wm-"));
  try {
    await mkdir(join(codexHome, "memories/soma"), { recursive: true });
    await configureCodexAgentsImport(codexHome);
    expect(await readFile(join(codexHome, "AGENTS.md"), "utf8")).not.toContain("@./memories/soma/principles.md");

    await writeFile(join(codexHome, "memories/soma/principles.md"), WORKING_METHOD, "utf8");
    await configureCodexAgentsImport(codexHome);
    await configureCodexAgentsImport(codexHome);
    expect((await readFile(join(codexHome, "AGENTS.md"), "utf8")).match(/^@\.\/memories\/soma\/principles\.md$/gm)).toHaveLength(1);

    await rm(join(codexHome, "memories/soma/principles.md"));
    await configureCodexAgentsImport(codexHome);
    expect(await readFile(join(codexHome, "AGENTS.md"), "utf8")).not.toContain("@./memories/soma/principles.md");
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
