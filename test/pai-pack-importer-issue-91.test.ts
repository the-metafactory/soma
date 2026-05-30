/**
 * Issue 91 — pai-pack-importer: replace ~/.claude/PAI/... UNMAPPED catch-all
 * with deterministic ~/.soma/PAI/... rewrites.
 *
 * After #88 (memory taxonomy) + #89 (soma import pai-docs) landed, Soma has
 * concrete homes for PAI's DOCUMENTATION, TEMPLATES, ALGORITHM, and MEMORY
 * subtrees. This issue stops sending paths under those subtrees through the
 * loud UNMAPPED catch-all and instead rewrites them to their real Soma
 * destinations under named action kinds.
 *
 * - AC-1: Each deterministic rewrite below runs as a named action kind in
 *         the normalizer pipeline, ordered before the UNMAPPED catch-all.
 * - AC-2: Re-importing the CreateSkill-shaped fixture produces zero
 *         `rewrote-unmapped-claude-path` actions for paths under
 *         DOCUMENTATION/, TEMPLATES/, ALGORITHM/, or MEMORY/.
 * - AC-4: Fixture-based tests cover each new rewrite class.
 * - AC-5: Existing tests pass (verified by the broader suite; this file
 *         pins the new contract).
 */
import { expect, test } from "bun:test";
import { normalizeSkillContent } from "../src/pai-pack-normalizer";

// ─── AC-1 + AC-4: per-class deterministic rewrites ─────────────────────
//
// Table-driven (Sage R1, PR #96 Maintainability suggestion): the four
// per-subtree rules share an identical contract — rewrite the input path,
// fire the per-rule action kind, suppress the UNMAPPED catch-all action,
// suppress the UNMAPPED warning. Encoding the contract as a table keeps
// the contract in one place; future rewrite rules slot in as one row
// rather than another ~10-line test block.
//
// Note the asymmetric MEMORY target: PAI's `PAI/MEMORY/` maps to Soma's
// `~/.soma/memory/` (lowercase, no PAI/ prefix) per DD-1, DD-2 — Soma's
// memory is canonical, not a PAI projection. The other three preserve
// the `PAI/` prefix because `~/.soma/PAI/` is the imported-docs surface.
const DETERMINISTIC_REWRITE_CASES: readonly {
  label: string;
  inputLine: string;
  expectedTarget: string;
  kind:
    | "rewrote-pai-doc-path"
    | "rewrote-pai-template-path"
    | "rewrote-pai-algorithm-path"
    | "rewrote-pai-memory-path";
}[] = [
  {
    label: "PAI/DOCUMENTATION → ~/.soma/PAI/DOCUMENTATION",
    inputLine: "See `~/.claude/PAI/DOCUMENTATION/Skills/SkillSystem.md` for details.",
    expectedTarget: "~/.soma/PAI/DOCUMENTATION/Skills/SkillSystem.md",
    kind: "rewrote-pai-doc-path",
  },
  {
    label: "PAI/TEMPLATES → ~/.soma/PAI/TEMPLATES",
    inputLine: "Template lives at ~/.claude/PAI/TEMPLATES/ReportTemplate/dashboard.tpl.html.",
    expectedTarget: "~/.soma/PAI/TEMPLATES/ReportTemplate/dashboard.tpl.html",
    kind: "rewrote-pai-template-path",
  },
  {
    label: "PAI/ALGORITHM → ~/.soma/PAI/ALGORITHM",
    inputLine: "Load `~/.claude/PAI/ALGORITHM/v6.3.0.md` and follow its instructions.",
    expectedTarget: "~/.soma/PAI/ALGORITHM/v6.3.0.md",
    kind: "rewrote-pai-algorithm-path",
  },
  {
    label: "PAI/MEMORY → ~/.soma/memory (asymmetric per DD-2)",
    inputLine: "echo run >> ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl",
    expectedTarget: "~/.soma/memory/SKILLS/execution.jsonl",
    kind: "rewrote-pai-memory-path",
  },
];

for (const tc of DETERMINISTIC_REWRITE_CASES) {
  test(`AC-1: ${tc.label} fires ${tc.kind} (not UNMAPPED)`, () => {
    const result = normalizeSkillContent("body.md", `${tc.inputLine}\n`);
    expect(result.content).not.toContain("~/.claude/");
    expect(result.content).toContain(tc.expectedTarget);
    // Deterministic mapping fires its own action kind...
    expect(result.actions.some((a) => a.kind === tc.kind)).toBe(true);
    // ...not the UNMAPPED catch-all action, and no UNMAPPED warning —
    // the path now has a real Soma home.
    expect(result.actions.some((a) => a.kind === "rewrote-unmapped-claude-path")).toBe(false);
    expect(result.warnings.some((w) => w.kind === "unmapped-claude-home-path")).toBe(false);
  });
}

// ─── AC-1 ordering: new rules run BEFORE the UNMAPPED catch-all ────────

test("AC-1 ordering: new deterministic rules win over the UNMAPPED catch-all when both could match", () => {
  // Without the new deterministic rules, all three paths below would fall
  // through to the catch-all and be rewritten to ~/.soma/UNMAPPED/PAI/...
  // After this issue, every one of them must hit its named action kind.
  const content = [
    "Read ~/.claude/PAI/DOCUMENTATION/Skills/SkillSystem.md.",
    "Templates in ~/.claude/PAI/TEMPLATES/Report/.",
    "Algorithm: ~/.claude/PAI/ALGORITHM/v6.3.0.md.",
    "Memory: ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl.",
  ].join("\n");
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  expect(result.content).not.toContain("UNMAPPED");
  const actionKinds = new Set(result.actions.map((a) => a.kind));
  expect(actionKinds.has("rewrote-pai-doc-path")).toBe(true);
  expect(actionKinds.has("rewrote-pai-template-path")).toBe(true);
  expect(actionKinds.has("rewrote-pai-algorithm-path")).toBe(true);
  expect(actionKinds.has("rewrote-pai-memory-path")).toBe(true);
  expect(actionKinds.has("rewrote-unmapped-claude-path")).toBe(false);
  expect(result.warnings.some((w) => w.kind === "unmapped-claude-home-path")).toBe(false);
});

// ─── AC-2: residue not under DOC/TEMPL/ALGO/MEMORY still surfaces as UNMAPPED

test("AC-2: paths NOT under DOC/TEMPL/ALGO/MEMORY (e.g. PAI/USER/, History/) still route to UNMAPPED warning", () => {
  // The deterministic rewrites are surgical: ~/.claude/PAI/USER/... has no
  // Soma equivalent (per issue body) and must still surface as a loud
  // UNMAPPED warning so the audit trail does not lose the signal.
  const content = [
    "User overlay: ~/.claude/PAI/USER/PRINCIPAL_IDENTITY.md.",
    "Backups: ~/.claude/History/Backups/Foo-backup/.",
    "Bare PAI: ~/.claude/PAI/SkillSystem.md.",
  ].join("\n");
  const result = normalizeSkillContent("body.md", content);
  expect(result.content).not.toContain("~/.claude/");
  // Each of these residue forms produces a catch-all rewrite + warning.
  expect(result.actions.some((a) => a.kind === "rewrote-unmapped-claude-path")).toBe(true);
  expect(result.warnings.some((w) => w.kind === "unmapped-claude-home-path")).toBe(true);
  // Targets land under UNMAPPED placeholder so runtime breakage is loud.
  expect(result.content).toContain("~/.soma/UNMAPPED/PAI/USER/PRINCIPAL_IDENTITY.md");
  expect(result.content).toContain("~/.soma/UNMAPPED/History/Backups/Foo-backup/");
  expect(result.content).toContain("~/.soma/UNMAPPED/PAI/SkillSystem.md");
});

// ─── AC-2: CreateSkill-shaped real residues all route deterministically ─

test("AC-2: CreateSkill stress lines under DOC/TEMPL/ALGO/MEMORY produce zero UNMAPPED actions", () => {
  // The exact residue forms surfaced by re-importing
  // ~/work/PAI/Packs/CreateSkill, filtered to paths under the four
  // subtrees now covered. After this issue, NONE of these should produce
  // a `rewrote-unmapped-claude-path` action.
  const content = [
    "Read ~/.claude/PAI/DOCUMENTATION/Skills/SkillSystem.md before creating any skill.",
    "Notifications live in ~/.claude/PAI/DOCUMENTATION/Notifications/NotificationSystem.md.",
    "Tool architecture: ~/.claude/PAI/DOCUMENTATION/Tools/CliFirstArchitecture.md.",
    "echo run >> ~/.claude/PAI/MEMORY/SKILLS/execution.jsonl",
    "Templates: ~/.claude/PAI/TEMPLATES/Report/index.tpl.md",
    "Algorithm: ~/.claude/PAI/ALGORITHM/v6.3.0.md",
  ].join("\n");
  const result = normalizeSkillContent("Workflows/Stress.md", content);

  // AC-3 residue invariant from #86 still holds.
  expect(result.content).not.toContain("~/.claude/");

  // The whole point of this issue: zero UNMAPPED actions for these paths.
  expect(result.actions.some((a) => a.kind === "rewrote-unmapped-claude-path")).toBe(false);
  expect(result.warnings.some((w) => w.kind === "unmapped-claude-home-path")).toBe(false);

  // All four new action kinds present.
  const actionKinds = new Set(result.actions.map((a) => a.kind));
  expect(actionKinds.has("rewrote-pai-doc-path")).toBe(true);
  expect(actionKinds.has("rewrote-pai-template-path")).toBe(true);
  expect(actionKinds.has("rewrote-pai-algorithm-path")).toBe(true);
  expect(actionKinds.has("rewrote-pai-memory-path")).toBe(true);
});

// ─── AC-1: action detail records the actual pattern + target for audit ─

test("AC-1: each new action kind records its source pattern and target in the audit detail", () => {
  // The audit trail must let a reviewer reconstruct which rule fired.
  // Mirror the detail shape from the existing `rewrote-claude-home-path`
  // entries — `Rewrote <pattern> → <target>`.
  const content = [
    "~/.claude/PAI/DOCUMENTATION/A.md",
    "~/.claude/PAI/TEMPLATES/B.md",
    "~/.claude/PAI/ALGORITHM/C.md",
    "~/.claude/PAI/MEMORY/D.md",
  ].join("\n");
  const result = normalizeSkillContent("body.md", content);
  const byKind = new Map(result.actions.map((a) => [a.kind, a.detail]));
  expect(byKind.get("rewrote-pai-doc-path")).toMatch(/DOCUMENTATION.*~\/\.soma\/PAI\/DOCUMENTATION/);
  expect(byKind.get("rewrote-pai-template-path")).toMatch(/TEMPLATES.*~\/\.soma\/PAI\/TEMPLATES/);
  expect(byKind.get("rewrote-pai-algorithm-path")).toMatch(/ALGORITHM.*~\/\.soma\/PAI\/ALGORITHM/);
  expect(byKind.get("rewrote-pai-memory-path")).toMatch(/MEMORY.*~\/\.soma\/memory/);
});
