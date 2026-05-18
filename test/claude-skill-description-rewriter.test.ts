/**
 * #120 — unit tests for the `--rewrite-descriptions` LLM dispatcher
 * primitives.
 *
 * Pure-function layer only — these tests exercise:
 *   - `classifyDescriptionStatus` against the 1024 substrate cap.
 *   - `buildRewritePrompt` shape (HARD CONSTRAINT line + source mode).
 *   - `sanitizeRewrittenDescription` against real-world LLM quirks
 *     (frontmatter delimiters, outer quotes, internal newlines).
 *   - `defaultRewriteDispatch` refuses `pi` agent loud (no
 *     subprocess wired today).
 *
 * The end-to-end migrator paths (oversize → rewrite → import,
 * idempotency, refused-description-limit) live in
 * `claude-skills-migrator.test.ts` against a stub dispatcher.
 */
import { describe, expect, test } from "bun:test";
import {
  buildRewritePrompt,
  classifyDescriptionStatus,
  defaultRewriteDispatch,
  sanitizeRewrittenDescription,
  SUBSTRATE_DESCRIPTION_LIMIT,
} from "../src/claude-skill-description-rewriter";

describe("classifyDescriptionStatus", () => {
  test("description present, ≤1024 chars → ok", () => {
    const status = classifyDescriptionStatus("short description");
    expect(status.kind).toBe("ok");
    expect(status.length).toBe("short description".length);
    expect(status.threshold).toBe(1024);
  });

  test("description present, exactly 1024 chars → ok", () => {
    const exactly = "a".repeat(SUBSTRATE_DESCRIPTION_LIMIT);
    const status = classifyDescriptionStatus(exactly);
    expect(status.kind).toBe("ok");
    expect(status.length).toBe(1024);
  });

  test("description present, 1025 chars → oversize", () => {
    const oversize = "a".repeat(SUBSTRATE_DESCRIPTION_LIMIT + 1);
    const status = classifyDescriptionStatus(oversize);
    expect(status.kind).toBe("oversize");
    expect(status.length).toBe(1025);
  });

  test("description undefined (no frontmatter / no line) → missing", () => {
    const status = classifyDescriptionStatus(undefined);
    expect(status.kind).toBe("missing");
    expect(status.length).toBe(0);
  });

  test("empty description (key with no value) → ok at length 0", () => {
    // A `description:` line with no value parses to "" by the
    // frontmatter parser (post stripQuotes). 0 ≤ 1024, so the
    // substrate would accept it; the migrator must NOT classify it
    // as missing — that lane is reserved for genuinely-absent
    // frontmatter.
    const status = classifyDescriptionStatus("");
    expect(status.kind).toBe("ok");
    expect(status.length).toBe(0);
  });
});

describe("buildRewritePrompt", () => {
  test("oversize path: prompt embeds the original description verbatim", () => {
    const prompt = buildRewritePrompt({
      status: { kind: "oversize", length: 1500, threshold: 1024 },
      originalDescription: "long original description goes here",
      skillMdBody: "# Skill\n\nBody.\n",
      targetMaxLength: 900,
    });
    expect(prompt).toContain("HARD CONSTRAINT");
    expect(prompt).toContain("≤ 900 characters");
    expect(prompt).toContain("long original description goes here");
    // Missing-path body header must NOT appear on the oversize lane.
    expect(prompt).not.toContain("Synthesize a description from this skill body");
  });

  test("missing path: prompt embeds first 2 KiB of body, not the description block", () => {
    const longBody = `# Skill\n\n${"A".repeat(5000)}\n`;
    const prompt = buildRewritePrompt({
      status: { kind: "missing", length: 0, threshold: 1024 },
      originalDescription: "",
      skillMdBody: longBody,
      targetMaxLength: 900,
    });
    expect(prompt).toContain("Synthesize a description from this skill body");
    expect(prompt).toContain("# Skill");
    // Truncated body — we do NOT pass the full 5000-char tail in.
    // The full body would push the prompt past sensible token budgets
    // on long PAI skills.
    expect(prompt.length).toBeLessThan(longBody.length);
    // Oversize-path header must NOT leak into the missing lane.
    expect(prompt).not.toContain("Original description (length");
  });

  test("preserve + drop lists land in the prompt", () => {
    const prompt = buildRewritePrompt({
      status: { kind: "oversize", length: 1500, threshold: 1024 },
      originalDescription: "x",
      skillMdBody: "",
      targetMaxLength: 900,
    });
    expect(prompt).toContain("PRESERVE in priority order");
    expect(prompt).toContain("Specific usage triggers");
    expect(prompt).toContain("DROP:");
    expect(prompt).toContain("Pleasantries, hedging");
  });
});

describe("sanitizeRewrittenDescription", () => {
  test("strips frontmatter delimiter wrappers", () => {
    const wrapped = "---\nclean text\n---";
    expect(sanitizeRewrittenDescription(wrapped)).toBe("clean text");
  });

  test("strips leading 'description:' key if the model echoes it", () => {
    expect(sanitizeRewrittenDescription("description: ok value")).toBe("ok value");
    expect(sanitizeRewrittenDescription("Description: ok value")).toBe("ok value");
  });

  test("strips outer double quotes", () => {
    expect(sanitizeRewrittenDescription("\"quoted text\"")).toBe("quoted text");
  });

  test("strips outer single quotes", () => {
    expect(sanitizeRewrittenDescription("'quoted text'")).toBe("quoted text");
  });

  test("leaves unbalanced quotes intact", () => {
    expect(sanitizeRewrittenDescription("'mismatched\"")).toBe("'mismatched\"");
  });

  test("collapses internal newlines into single spaces", () => {
    expect(sanitizeRewrittenDescription("line one\nline two\nline three")).toBe(
      "line one line two line three",
    );
  });

  test("preserves substantive content of a real oversize rewrite", () => {
    const rewritten = "  Scrape platforms via Apify. USE WHEN scrape, Instagram, LinkedIn, TikTok.  ";
    expect(sanitizeRewrittenDescription(rewritten)).toBe(
      "Scrape platforms via Apify. USE WHEN scrape, Instagram, LinkedIn, TikTok.",
    );
  });
});

describe("defaultRewriteDispatch", () => {
  test("pi agent refuses loud with actionable guidance", async () => {
    await expect(
      defaultRewriteDispatch({
        agent: "pi",
        sourceName: "TestSkill",
        status: { kind: "oversize", length: 1500, threshold: 1024 },
        originalDescription: "x",
        skillMdBody: "",
        targetMaxLength: 900,
      }),
    ).rejects.toThrow("Pi.dev LLM API not configured");
  });
});
