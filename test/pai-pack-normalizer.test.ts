import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  SOMA_SKILL_DESCRIPTION_MAX_LENGTH,
  generateSomaSkillManifest,
  mergeNormalizationReports,
  normalizeSkillDescription,
  normalizeSkillContent,
} from "../src/pai-pack-normalizer";
import { importPaiPack, planPaiPackImport } from "../src/index";

function makeLongDescription(count = 80, detail = "explains routing details"): string {
  return Array.from({ length: count }, (_, index) => `Sentence ${index} ${detail}.`).join(" ");
}

async function withFakePack<T>(fn: (paiPackDir: string, somaHome: string, homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-pack-norm-"));
  const paiPackDir = join(homeDir, "_pack");
  await mkdir(join(paiPackDir, "src", "Workflows"), { recursive: true });
  // Required pack files
  await writeFile(join(paiPackDir, "README.md"), "---\nname: TestPack\ndescription: Test pack.\n---\n\n# TestPack\n", "utf8");
  await writeFile(join(paiPackDir, "INSTALL.md"), "# Install\n", "utf8");
  await writeFile(join(paiPackDir, "VERIFY.md"), "# Verify\n", "utf8");
  await writeFile(
    join(paiPackDir, "src", "SKILL.md"),
    [
      "---",
      "name: TestPack",
      "description: USE WHEN testing, mandatory notification stripping, claude path rewriting.",
      "---",
      "",
      "## 🚨 MANDATORY: Voice Notification",
      "",
      "Run this before any action:",
      "",
      "```bash",
      "curl -s -X POST http://localhost:31337/notify -d '{}' &",
      "```",
      "",
      "## Body",
      "",
      "Refer to ~/.claude/skills/TestPack/notes.md for reference.",
      "Customization lives in ~/.claude/customization/test.md.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(paiPackDir, "src", "Workflows", "Run.md"),
    [
      "## 🚨 MANDATORY: Notify First",
      "",
      "```bash",
      "curl http://localhost:31337/notify",
      "```",
      "",
      "## Steps",
      "",
      "rm -rf ~/.claude/skills/TestPack/old",
      "Check ~/.claude/memory/runs.jsonl after execution.",
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    return await fn(paiPackDir, join(homeDir, ".soma"), homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

test("normalizeSkillContent strips MANDATORY notification heading + curl invocation", () => {
  const content = [
    "## 🚨 MANDATORY: Voice Notification",
    "",
    "```bash",
    "curl http://localhost:31337/notify",
    "```",
    "",
    "## Real content",
    "",
    "Body here.",
  ].join("\n");
  const result = normalizeSkillContent("SKILL.md", content);
  expect(result.actions.some((a) => a.kind === "stripped-mandatory-runtime-block")).toBe(true);
  expect(result.content).not.toContain("MANDATORY");
  expect(result.content).not.toContain("localhost:31337/notify");
  expect(result.content).toContain("Real content");
});

test("normalizeSkillContent rewrites deterministic Claude skills path", () => {
  const content = "Use ~/.claude/skills/Foo/bar.md for reference.\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).toContain("~/.soma/skills/Foo/bar.md");
  expect(result.actions.some((a) => a.kind === "rewrote-claude-home-path")).toBe(true);
});

test("normalizeSkillContent warns on ambiguous Claude paths AND rewrites them to the UNMAPPED placeholder", () => {
  // Issue #86 / AC-1: every ~/.claude/<subpath> must be rewritten,
  // stripped, or surface as a warning — silent passthrough is not
  // acceptable. The named-class warnings (customization-overlay-reference,
  // execution-logging-path, ambiguous-substrate-path) communicate *why* a
  // path is ambiguous; the catch-all rewrites the literal path to
  // ~/.soma/UNMAPPED/... so AC-3's "zero ~/.claude/ residue" promise is
  // also satisfied.
  const content = [
    "Customization in ~/.claude/customization/x.md",
    "Memory at ~/.claude/memory/run.jsonl",
    "Docs at ~/.claude/docs/index.md",
  ].join("\n");
  const result = normalizeSkillContent("body.md", content);
  const warningKinds = result.warnings.map((w) => w.kind);
  // Named warnings still fire — they explain the substrate-meaning of
  // each path class, which the bare unmapped-claude-home-path warning does
  // not capture.
  expect(warningKinds).toContain("customization-overlay-reference");
  expect(warningKinds).toContain("execution-logging-path");
  expect(warningKinds).toContain("ambiguous-substrate-path");
  // Catch-all warning + action also fire (AC-1 baseline).
  expect(warningKinds).toContain("unmapped-claude-home-path");
  expect(result.actions.some((a) => a.kind === "rewrote-unmapped-claude-path")).toBe(true);
  // AC-3: zero ~/.claude/ residue
  expect(result.content).not.toContain("~/.claude/");
  expect(result.content).toContain("~/.soma/UNMAPPED/customization/x.md");
});

test("normalizeSkillContent warns on substrate mutation commands", () => {
  const content = "Run `rm -rf ~/.claude/skills/Foo` to clean.\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.warnings.some((w) => w.kind === "substrate-mutation-command")).toBe(true);
});

test("normalizeSkillContent warns on release-safety scans", () => {
  const content = "Run `grep -r secret ~/.claude/skills/` to scan for tokens.\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.warnings.some((w) => w.kind === "release-safety-path")).toBe(true);
});

test("AC-4 round-4: workflow originals are archived alongside SKILL.md original", async () => {
  await withFakePack(async (paiPackDir, somaHome, homeDir) => {
    await importPaiPack({ homeDir, somaHome, paiPackDir });
    // Both SKILL.md AND Workflows/Run.md originals must be archived
    const archivedSkill = await readFile(
      join(somaHome, "imports", "pai-packs", "test-pack", "source", "src", "SKILL.md"),
      "utf8",
    );
    expect(archivedSkill).toContain("MANDATORY");
    const archivedWorkflow = await readFile(
      join(somaHome, "imports", "pai-packs", "test-pack", "source", "src", "Workflows", "Run.md"),
      "utf8",
    );
    // The fixture workflow body has the curl notification line
    expect(archivedWorkflow).toContain("localhost:31337/notify");
  });
});

test("AC-3 round-3: workflow markdown is normalized but keeps original frontmatter", async () => {
  await withFakePack(async (paiPackDir, somaHome, homeDir) => {
    // Workflow file in fixture has no frontmatter; add one to verify it survives
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(paiPackDir, "src", "Workflows", "Run.md"),
      [
        "---",
        "workflow: Run",
        "input: prompt",
        "---",
        "",
        "## 🚨 MANDATORY: Notify First",
        "",
        "Run this voice notification:",
        "",
        "curl http://localhost:31337/notify",
        "",
        "## Steps",
        "",
        "Body content.",
      ].join("\n"),
      "utf8",
    );
    await importPaiPack({ homeDir, somaHome, paiPackDir });
    const workflow = await readFile(join(somaHome, "skills", "test-pack", "Workflows", "Run.md"), "utf8");
    // Workflow frontmatter preserved (NOT replaced with skill identity)
    expect(workflow).toContain("workflow: Run");
    expect(workflow).toContain("input: prompt");
    expect(workflow).not.toContain("name: \"test-pack\"");
    // Body still normalized
    expect(workflow).not.toContain("MANDATORY");
    expect(workflow).not.toContain("localhost:31337/notify");
  });
});

test("normalizeSkillContent leaves unrelated MANDATORY sections alone (round-2 blocker fix)", () => {
  const content = [
    "## MANDATORY: Input Requirements",
    "",
    "Must include slug and goal.",
    "",
    "## Body",
    "",
    "Real content.",
  ].join("\n");
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).toContain("MANDATORY: Input Requirements");
  expect(result.content).toContain("Must include slug and goal");
  expect(result.actions.some((a) => a.kind === "stripped-mandatory-runtime-block")).toBe(false);
});

test("normalizeSkillContent is stateless across repeated calls (no /g lastIndex leak)", () => {
  // Regression for Sage round-1 blocker: previous /g regexes mutated
  // lastIndex on `.test()` so subsequent calls could miss matches.
  const hostile = "curl http://localhost:31337/notify -d '{}' &\n";
  for (let i = 0; i < 5; i++) {
    const result = normalizeSkillContent(`file-${i}.md`, hostile);
    expect(result.content).not.toContain("localhost:31337/notify");
    expect(result.actions.some((a) => a.kind === "removed-substrate-notification-hook")).toBe(true);
  }
});

test("normalizeSkillContent no-op on clean content", () => {
  const content = "# Skill body\n\nNothing substrate-specific here.\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.actions).toHaveLength(0);
  expect(result.warnings).toHaveLength(0);
  expect(result.content).toBe(content);
});

test("mergeNormalizationReports concatenates actions and warnings deterministically", () => {
  const merged = mergeNormalizationReports([
    { actions: [{ file: "a", kind: "removed-substrate-notification-hook", detail: "x" }], warnings: [] },
    { actions: [], warnings: [{ file: "b", kind: "ambiguous-substrate-path", detail: "y" }] },
  ]);
  expect(merged.mode).toBe("deterministic");
  expect(merged.actions).toHaveLength(1);
  expect(merged.warnings).toHaveLength(1);
});

test("generateSomaSkillManifest extracts triggers from USE WHEN clause", () => {
  const manifest = generateSomaSkillManifest({
    skillName: "demo",
    description: "Demo skill. USE WHEN demo work, demo testing, demo verification.",
    packName: "Demo",
    entrypoint: "SKILL.md",
    references: ["refs/B.md", "refs/A.md"],
    workflowFiles: ["Workflows/Run.md"],
  });
  expect(manifest.schema).toBe("soma.skill.v1");
  expect(manifest.triggers).toContain("demo work");
  // sorted references
  expect(manifest.references).toEqual(["refs/A.md", "refs/B.md"]);
  expect(manifest.source).toEqual({ kind: "pai-pack", packName: "Demo" });
});

test("generateSomaSkillManifest lists every substrate with portable-skill projection, including grok", () => {
  const manifest = generateSomaSkillManifest({
    skillName: "demo",
    description: "Demo skill.",
    packName: "Demo",
    entrypoint: "SKILL.md",
    references: [],
    workflowFiles: [],
  });
  // Pinned: algorithm-capabilities filters pack-imported skills per
  // substrate via this list, so a substrate missing here is silently
  // excluded from `soma algorithm --substrate <id>` capability
  // registration even though its skill files project to disk.
  expect(manifest.substrates).toEqual(["claude-code", "codex", "grok", "pi-dev"]);
});

test("normalizeSkillDescription compacts descriptions for portable metadata limit", () => {
  const longDescription = makeLongDescription();
  const result = normalizeSkillDescription(longDescription, {
    file: "README.md",
    fallback: "Imported PAI pack: Demo",
  });

  expect(result.description.length).toBeLessThanOrEqual(SOMA_SKILL_DESCRIPTION_MAX_LENGTH);
  expect(result.action?.kind).toBe("compacted-skill-description");
});

test("generateSomaSkillManifest keeps generated descriptions within portable limit", () => {
  const manifest = generateSomaSkillManifest({
    skillName: "demo",
    description: makeLongDescription(),
    packName: "Demo",
    entrypoint: "SKILL.md",
    references: [],
    workflowFiles: [],
  });

  expect(manifest.description.length).toBeLessThanOrEqual(SOMA_SKILL_DESCRIPTION_MAX_LENGTH);
});

test("AC-1: dry-run plan reports normalization actions + warnings", async () => {
  await withFakePack(async (paiPackDir, somaHome, homeDir) => {
    // #105 — planPaiPackImport returns array; FLAT pack → one plan.
    const [plan] = await planPaiPackImport({ homeDir, somaHome, paiPackDir });
    expect(plan.normalization.actions.length).toBeGreaterThan(0);
    expect(plan.normalization.warnings.length).toBeGreaterThan(0);
    // No files written under somaHome
    await expect(readFile(join(somaHome, "skills", "test-pack", "SKILL.md"), "utf8")).rejects.toThrow();
  });
});

test("PAI pack import compacts oversized skill descriptions in frontmatter and manifest", async () => {
  await withFakePack(async (paiPackDir, somaHome, homeDir) => {
    const longDescription = makeLongDescription(90, "explains imported routing details");
    await writeFile(
      join(paiPackDir, "README.md"),
      `---\nname: TestPack\ndescription: ${JSON.stringify(longDescription)}\n---\n\n# TestPack\n`,
      "utf8",
    );

    // #105 — importPaiPack returns array; FLAT pack → one result.
    const [result] = await importPaiPack({ homeDir, somaHome, paiPackDir });
    expect(result.normalization.actions.some((action) => action.kind === "compacted-skill-description")).toBe(true);

    const skillMd = await readFile(join(somaHome, "skills", "test-pack", "SKILL.md"), "utf8");
    const description = /^description:\s*"([\s\S]*?)"$/m.exec(skillMd)?.[1] ?? "";
    expect(description.length).toBeLessThanOrEqual(SOMA_SKILL_DESCRIPTION_MAX_LENGTH);

    const somaSkill = JSON.parse(await readFile(join(somaHome, "skills", "test-pack", "soma-skill.json"), "utf8"));
    expect(somaSkill.description.length).toBeLessThanOrEqual(SOMA_SKILL_DESCRIPTION_MAX_LENGTH);
  });
});

test("AC-2: apply writes normalized skill files + soma-skill.json", async () => {
  await withFakePack(async (paiPackDir, somaHome, homeDir) => {
    // #105 — importPaiPack returns array; FLAT pack → one result.
    const [result] = await importPaiPack({ homeDir, somaHome, paiPackDir });
    expect(result.normalization.actions.length).toBeGreaterThan(0);

    // AC-3: notification block removed from projected skill body
    const skillMd = await readFile(join(somaHome, "skills", "test-pack", "SKILL.md"), "utf8");
    expect(skillMd).not.toContain("MANDATORY");
    expect(skillMd).not.toContain("localhost:31337/notify");

    // soma-skill.json generated
    const somaSkill = JSON.parse(await readFile(join(somaHome, "skills", "test-pack", "soma-skill.json"), "utf8"));
    expect(somaSkill.schema).toBe("soma.skill.v1");
    expect(somaSkill.name).toBe("test-pack");
    expect(somaSkill.source).toEqual({ kind: "pai-pack", packName: "TestPack" });

    // soma-pack.json carries the normalization report (AC-5)
    const somaPack = JSON.parse(await readFile(join(somaHome, "skills", "test-pack", "soma-pack.json"), "utf8"));
    expect(somaPack.normalization.mode).toBe("deterministic");
    expect(somaPack.normalization.actions.length).toBeGreaterThan(0);
    expect(somaPack.normalization.warnings.length).toBeGreaterThan(0);

    // AC-4: original source remains under imports/pai-packs/<skill>/source/<original-path>
    const archivedSkill = await readFile(
      join(somaHome, "imports", "pai-packs", "test-pack", "source", "src", "SKILL.md"),
      "utf8",
    );
    expect(archivedSkill).toContain("MANDATORY"); // archive untouched
    expect(archivedSkill).toContain("localhost:31337/notify");
  });
});
