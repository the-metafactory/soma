/**
 * Issue 86 — claude-path rewriter too narrow, PAI Customization block
 * copied verbatim. Originally pinned through the PAI pack importer; the
 * normalizer contract survives it (node #793) for `soma migrate claude-skills`.
 *
 * - AC-1: every `~/.claude/<subpath>` either rewrites, gets stripped, or
 *         surfaces as a warning. No silent passthrough.
 * - AC-2: PAI Customization block stripped via named action kind.
 */
import { expect, test } from "bun:test";
import { normalizeSkillContent } from "../src/substrates/skill-content-normalizer";


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

test("Sage R2 fix: strip respects H1 boundary — `# Title` between `## Customization` and next `##` survives", () => {
  // Sage R2 (PR #87) CodeQuality important finding: the section-end regex
  // `/^##+\s+/m` only matched ##+ — an H1 (`# Foo`) after the stripped
  // block but before the next `##` was treated as part of the stripped
  // section and removed. Fix: use any-ATX-heading boundary `/^#+\s+/m`
  // so the strip stops at the first heading of ANY level.
  const content = [
    "## Customization",
    "",
    "**Before executing, check for user customizations at:**",
    "`~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/Demo/`",
    "",
    "# MainTitle",
    "",
    "## Real Content",
    "",
    "Body here.",
  ].join("\n");
  const result = normalizeSkillContent("SKILL.md", content);
  expect(result.content).not.toContain("SKILLCUSTOMIZATIONS");
  // H1 between the stripped block and the next ## must survive.
  expect(result.content).toContain("# MainTitle");
  expect(result.content).toContain("## Real Content");
  expect(result.content).toContain("Body here.");
});

test("Sage R2 fix: same boundary fix applies to MANDATORY notification strip", () => {
  // The shared helper is used by both strippers — symmetry test.
  const content = [
    "## MANDATORY: Voice Notification",
    "",
    "curl http://localhost:31337/notify",
    "",
    "# MainTitle",
    "",
    "## Real Content",
    "",
    "Body.",
  ].join("\n");
  const result = normalizeSkillContent("SKILL.md", content);
  expect(result.content).not.toContain("MANDATORY");
  expect(result.content).not.toContain("localhost:31337/notify");
  expect(result.content).toContain("# MainTitle");
  expect(result.content).toContain("## Real Content");
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

test("AC-1: PAI bare-under-PAI path (no DOC/TEMPL/ALGO/MEMORY subtree) rewrites to UNMAPPED + warning", () => {
  // Issue 91 superseded the prior "DOCUMENTATION → UNMAPPED" assertion:
  // DOCUMENTATION now has a deterministic home (~/.soma/PAI/DOCUMENTATION).
  // The catch-all still has to fire on PAI subtrees with no Soma equivalent,
  // e.g. a bare `~/.claude/PAI/SkillSystem.md` (no subtree under PAI matches
  // the four deterministic rules). This test pins THAT remaining contract.
  const content = "See `~/.claude/PAI/SkillSystem.md` for details.\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  expect(result.content).toContain("~/.soma/UNMAPPED/PAI/SkillSystem.md");
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
  // Issue 91 promoted the MEMORY rewrite to its own named action kind
  // (`rewrote-pai-memory-path`). The mapping target is unchanged — Soma's
  // memory home is canonical (per DD-1, DD-2). What changed is the audit
  // trail: an explicit kind makes the rule reviewable, instead of folding
  // it under the generic `rewrote-claude-home-path` umbrella shared with
  // skills/.
  const content = "Log execution: ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl\n";
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  expect(result.content).toContain("~/.soma/memory/SKILLS/execution.jsonl");
  // Deterministic mapping → no UNMAPPED warning; named action kind per #91.
  expect(result.actions.some((a) => a.kind === "rewrote-pai-memory-path")).toBe(true);
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
