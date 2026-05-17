/**
 * Issue 86 — pai-pack-importer: claude-path rewriter too narrow,
 * PAI Customization block copied verbatim.
 *
 * Tests live in their own file so the regression surface is grep-able by
 * issue number and the fixture-driven invariants stay co-located.
 *
 * - AC-1: every `~/.claude/<subpath>` either rewrites, gets stripped, or
 *         surfaces as a warning. No silent passthrough.
 * - AC-2: PAI Customization block stripped via named action kind.
 * - AC-3: importing the fixture produces ZERO `~/.claude/` residue in the
 *         imported skill body (grep test on every projected .md).
 * - AC-4: fixture-based coverage for every rewrite/strip/warn class.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { normalizeSkillContent } from "../src/pai-pack-normalizer";
import { importPaiPack } from "../src/index";

const FIXTURE_PACK_DIR = join(import.meta.dir, "fixtures/pai-packs/issue-86");

async function withTempHome<T>(fn: (homeDir: string, somaHome: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), "soma-issue-86-"));
  try {
    return await fn(homeDir, join(homeDir, ".soma"));
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }
  }
  await visit(root);
  return out.sort();
}

// ─── AC-2: PAI Customization block strip ────────────────────────────────

test("AC-2: normalizeSkillContent strips the PAI Customization block", () => {
  const content = [
    "## Customization",
    "",
    "**Before executing, check for user customizations at:**",
    "`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/Demo/`",
    "",
    "If this directory exists, load and apply any PREFERENCES.md found there.",
    "",
    "## Real Content",
    "",
    "Body here.",
  ].join("\n");
  const result = normalizeSkillContent("SKILL.md", content);
  expect(result.actions.some((a) => a.kind === "stripped-pai-customization-block")).toBe(true);
  expect(result.content).not.toContain("Customization");
  expect(result.content).not.toContain("SKILLCUSTOMIZATIONS");
  expect(result.content).toContain("Real Content");
});

test("Sage R1 fix: shared helper strips ALL MANDATORY notification blocks (multi-match defense in depth)", () => {
  // The MANDATORY stripper now uses the same shared helper as the
  // Customization stripper. Multiple notification blocks in a single
  // skill file (rare but observed in some PAI packs) all get stripped.
  const content = [
    "## MANDATORY: Voice Notification",
    "",
    "curl http://localhost:31337/notify",
    "",
    "## Body",
    "",
    "Section.",
    "",
    "## MANDATORY: Voice Notification (REQUIRED BEFORE ANY ACTION)",
    "",
    "Send voice notification via curl to localhost:31337/notify.",
    "",
    "## Footer",
    "",
    "End.",
  ].join("\n");
  const result = normalizeSkillContent("SKILL.md", content);
  expect(result.content).not.toContain("MANDATORY");
  expect(result.content).not.toContain("localhost:31337/notify");
  expect(result.content).toContain("Footer");
  expect(result.content).toContain("End.");
  const mandatoryActions = result.actions.filter((a) => a.kind === "stripped-mandatory-runtime-block");
  expect(mandatoryActions.length).toBeGreaterThan(0);
});

test("AC-2 Sage R1 fix: strips PAI Customization block even when an unrelated Customization heading appears earlier", () => {
  // Sage R1 (PR #87) CodeQuality important finding: the original stripper
  // matched only the first `## Customization` heading and bailed when its
  // body lacked SKILLCUSTOMIZATIONS — leaving a later PAI runtime block
  // intact. Scan all matches; strip the one(s) whose body carries the
  // SKILLCUSTOMIZATIONS marker.
  const content = [
    "## Customization",
    "",
    "Configure colors in `theme.json` for your dashboard.",
    "",
    "## Body",
    "",
    "First real section.",
    "",
    "## Customization",
    "",
    "**Before executing, check for user customizations at:**",
    "`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/Demo/`",
    "",
    "## Tail",
    "",
    "Trailing body.",
  ].join("\n");
  const result = normalizeSkillContent("SKILL.md", content);
  // Theme-docs Customization heading survives
  expect(result.content).toContain("theme.json");
  // PAI runtime Customization block is gone
  expect(result.content).not.toContain("SKILLCUSTOMIZATIONS");
  expect(result.content).not.toContain("~/.claude/PAI/USER/");
  expect(result.actions.some((a) => a.kind === "stripped-pai-customization-block")).toBe(true);
  // Tail content preserved
  expect(result.content).toContain("Trailing body.");
});

test("AC-2: leaves unrelated 'Customization' headings alone (requires SKILLCUSTOMIZATIONS marker)", () => {
  const content = [
    "## Customization",
    "",
    "Configure colors and fonts in `theme.json`.",
    "",
    "## Body",
    "",
    "Real content.",
  ].join("\n");
  const result = normalizeSkillContent("SKILL.md", content);
  expect(result.actions.some((a) => a.kind === "stripped-pai-customization-block")).toBe(false);
  expect(result.content).toContain("Customization");
  expect(result.content).toContain("theme.json");
});

// ─── AC-1: catch-all for unmapped claude paths ─────────────────────────

test("AC-1: PAI DOCUMENTATION path rewrites to UNMAPPED placeholder + warning", () => {
  const content = "See `~/.claude/PAI/DOCUMENTATION/Skills/SkillSystem.md` for details.\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  expect(result.content).toContain("~/.soma/UNMAPPED/PAI/DOCUMENTATION/Skills/SkillSystem.md");
  expect(result.actions.some((a) => a.kind === "rewrote-unmapped-claude-path")).toBe(true);
  expect(result.warnings.some((w) => w.kind === "unmapped-claude-home-path")).toBe(true);
});

test("AC-1: PAI SkillSystem.md (no subdir) rewrites to UNMAPPED + warning", () => {
  const content = "Reference: ~/.claude/PAI/SkillSystem.md\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  expect(result.content).toContain("~/.soma/UNMAPPED/PAI/SkillSystem.md");
  expect(result.actions.some((a) => a.kind === "rewrote-unmapped-claude-path")).toBe(true);
});

test("AC-1: History/Backups path rewrites to UNMAPPED + warning", () => {
  const content = "cp -r ~/.claude/skills/Foo/ ~/.claude/History/Backups/Foo-backup/\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  // History/Backups → UNMAPPED catch-all
  expect(result.content).toContain("~/.soma/UNMAPPED/History/Backups/");
  // Skills path → deterministic rewrite (existing behavior preserved)
  expect(result.content).toContain("~/.soma/skills/Foo/");
});

// ─── AC-1: new deterministic rewrite (PAI MEMORY → soma memory) ────────

test("AC-1: PAI MEMORY path rewrites deterministically to ~/.soma/memory/", () => {
  const content = "Log execution: ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  expect(result.content).toContain("~/.soma/memory/SKILLS/execution.jsonl");
  // Deterministic mapping → no UNMAPPED warning; uses existing rewrote-claude-home-path action
  expect(result.actions.some((a) => a.kind === "rewrote-claude-home-path")).toBe(true);
  expect(result.warnings.some((w) => w.kind === "unmapped-claude-home-path")).toBe(false);
});

// ─── AC-1: skills root rewrite still works post-refactor ───────────────

test("AC-1: deterministic ~/.claude/skills/ rewrite still works", () => {
  const content = "ls ~/.claude/skills/Foo/Workflows/\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).toContain("~/.soma/skills/Foo/Workflows/");
  expect(result.content).not.toContain("~/.claude/");
  expect(result.actions.some((a) => a.kind === "rewrote-claude-home-path")).toBe(true);
});

// ─── AC-1: no claude residue — exhaustive catch-all ────────────────────

test("AC-1: arbitrary unknown ~/.claude/X path still rewrites to UNMAPPED", () => {
  const content = "Reference: ~/.claude/SomethingNew/file.md\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  expect(result.content).toContain("~/.soma/UNMAPPED/SomethingNew/file.md");
  expect(result.warnings.some((w) => w.kind === "unmapped-claude-home-path")).toBe(true);
});

test("AC-3: bare ~/.claude prose mentions rewrite to ~/.soma (zero-residue grep)", () => {
  // Real strings from the stress-test CreateSkill SKILL.md:
  //   "they never leave ~/.claude"        — no trailing slash
  //   "someone else's ~/.claude/"         — trailing slash, no path
  // A strict grep on the projected body must return zero — these
  // prose mentions are the only thing standing in the way after the
  // substantive catch-all runs.
  const content = [
    "Release tooling skips _* skills entirely — they never leave ~/.claude. Public",
    "Anything that would be wrong in someone else's ~/.claude/ is _ALLCAPS.",
  ].join("\n");
  const result = normalizeSkillContent("SKILL.md", content);
  expect(result.content).not.toContain("~/.claude");
  expect(result.content).toContain("~/.soma");
  expect(result.actions.some((a) => a.kind === "rewrote-unmapped-claude-path")).toBe(true);
  expect(result.warnings.some((w) => w.kind === "unmapped-claude-home-path")).toBe(true);
});

// ─── AC-3 / AC-4: end-to-end fixture import — zero claude residue ──────

test("AC-3 + AC-4: importing the issue-86 fixture leaves zero ~/.claude/ residue", async () => {
  await withTempHome(async (homeDir, somaHome) => {
    const result = await importPaiPack({ homeDir, somaHome, paiPackDir: FIXTURE_PACK_DIR });
    const skillRoot = join(somaHome, "skills", result.skillName);
    // Match the issue 86 reproduction scope: SKILL.md + Workflows/*.md only.
    // The `references/` directory under the skill root preserves original
    // PAI install/verify/readme docs verbatim — those are kept as
    // historical artifacts (per docs/pai-pack-importer.md: "Source docs are
    // preserved under references/ so Claude-specific installation guidance
    // remains available"). Rewriting them would corrupt their meaning.
    const projected = (await collectMarkdownFiles(skillRoot)).filter((path) => {
      const rel = path.slice(skillRoot.length + 1);
      return rel === "SKILL.md" || rel.startsWith("Workflows/");
    });

    expect(projected.length).toBeGreaterThan(0);
    for (const file of projected) {
      const body = await readFile(file, "utf8");
      // AC-3 grep test: zero ~/.claude residue (path-form OR bare prose).
      expect(body, `~/.claude residue in projected ${file}`).not.toContain("~/.claude");
    }

    // AC-2: the PAI runtime Customization block (heading + body referencing
    // SKILLCUSTOMIZATIONS) is stripped from SKILL.md. Note: mentions of the
    // word "SKILLCUSTOMIZATIONS" elsewhere in skill prose are conceptual
    // documentation of the PAI mental model (e.g. "user-specific content
    // lives in SKILLCUSTOMIZATIONS"); those are not runtime hooks and are
    // left alone. The block-vs-mention distinction matches the existing
    // MANDATORY-block strip pattern.
    const skillMd = await readFile(join(skillRoot, "SKILL.md"), "utf8");
    expect(skillMd).not.toMatch(/^##+\s*Customization\s*$/m);

    // Each named action kind must be present in the audit trail at least once
    const actionKinds = new Set(result.normalization.actions.map((a) => a.kind));
    expect(actionKinds.has("stripped-pai-customization-block")).toBe(true);
    expect(actionKinds.has("rewrote-claude-home-path")).toBe(true);
    expect(actionKinds.has("rewrote-unmapped-claude-path")).toBe(true);

    // Warning surface must include the catch-all kind so silent passthrough
    // is impossible — AC-1.
    const warningKinds = new Set(result.normalization.warnings.map((w) => w.kind));
    expect(warningKinds.has("unmapped-claude-home-path")).toBe(true);

    // Original PAI source must still be archived verbatim (AC-4 archive
    // contract from the existing importer suite — re-asserted here so the
    // archive doesn't regress when the projection rewrites change).
    const archivedSkill = await readFile(
      join(somaHome, "imports", "pai-packs", result.skillName, "source", "src", "SKILL.md"),
      "utf8",
    );
    expect(archivedSkill).toContain("~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/");
    expect(archivedSkill).toContain("## Customization");
  });
});

// ─── AC-1: stress-test pack parity (real CreateSkill pack on disk) ─────

test("AC-1 stress-test parity: every Claude path class from issue 86 produces an action or warning", () => {
  // Synthesizes the 10 actual residues from the issue body. The promise is
  // "no silent passthrough" — the assertions below check both halves of
  // that promise: (1) zero `~/.claude/` residue in the rewritten body, and
  // (2) every distinct unmapped routing root appears in the warning set
  // exactly once (warnings are de-duped per file by root segment so the
  // audit trail doesn't explode when a workflow mentions the same root 20
  // times — but every root must be present at least once).
  const residueLines = [
    "Refer to ~/.claude/PAI/SkillSystem.md for the canonical contract.",
    "Read ~/.claude/PAI/DOCUMENTATION/Skills/SkillSystem.md before creating any skill.",
    "Notifications live in ~/.claude/PAI/DOCUMENTATION/Notifications/NotificationSystem.md.",
    "Tool architecture: ~/.claude/PAI/DOCUMENTATION/Tools/CliFirstArchitecture.md.",
    "User customizations at ~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/CreateSkill/.",
    "Backups go to ~/.claude/History/Backups/.",
    "cp -r ~/.claude/skills/Foo/ ~/.claude/History/Backups/Foo/",
    "echo run >> ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl",
    "ls ~/.claude/skills/Foo/Workflows/",
    "cd ~/.claude/skills/Foo/",
  ];
  const content = residueLines.join("\n");
  const result = normalizeSkillContent("Workflows/Stress.md", content);
  // AC-3: no claude residue after normalization
  expect(result.content).not.toContain("~/.claude/");
  // AC-1: every unmapped routing root surfaced via the warning set
  // (PAI and History both have no Soma equivalent — both must show up).
  const unmappedDetails = result.warnings
    .filter((w) => w.kind === "unmapped-claude-home-path")
    .map((w) => w.detail);
  expect(unmappedDetails.some((d) => d.includes("~/.claude/PAI/"))).toBe(true);
  expect(unmappedDetails.some((d) => d.includes("~/.claude/History/"))).toBe(true);
  // skills and PAI/MEMORY are deterministically mapped → action, not warning.
  const actionKinds = new Set(result.actions.map((a) => a.kind));
  expect(actionKinds.has("rewrote-claude-home-path")).toBe(true);
  expect(actionKinds.has("rewrote-unmapped-claude-path")).toBe(true);
});
