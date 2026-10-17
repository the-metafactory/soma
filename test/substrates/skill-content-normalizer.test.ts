import { expect, test } from "bun:test";
import { normalizeSkillContent } from "../../src/substrates/skill-content-normalizer";

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

