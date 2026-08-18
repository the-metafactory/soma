/**
 * Behavioral policy (`~/.soma/policy/behavior.md`) — the principal-authored
 * source of truth for cross-substrate behavioral rules, parsed here and
 * projected into every substrate's policy projection.
 *
 * This module is deliberately the MIRROR IMAGE of `self-healing-doctrine.ts`.
 * There, the TypeScript module is authoritative and the markdown is a
 * human-readable copy, because the doctrine ships with Soma. Here the markdown
 * is authoritative and this module only reads it, because behavioral rules
 * belong to the principal, not to Soma. Nothing in this file states a rule.
 *
 * The file has existed in the Soma home since the 2026-07 PAI migration
 * (T2.3) carrying its own admission that "until adapter wiring lands,
 * substrate instruction files carry them by hand". This module is that wiring.
 *
 * Parsing is intentionally NOT `soma-home.ts`'s `sectionBullets`: that helper
 * keeps only lines starting with `- `, which silently truncates every wrapped
 * bullet in the file to its first line. A behavioral rule that loses its second
 * half is worse than one that never projected, so the fold below is required,
 * not cosmetic.
 */

/**
 * One folded entry under a heading: a bullet, or a paragraph of prose. Both are
 * carried in one sequence because the two are the same thing semantically — a
 * principal-authored rule — and only differ in how the principal typed it.
 */
export interface BehaviorPolicyEntry {
  readonly kind: "rule" | "prose";
  /** The entry text, wrapped continuation lines folded into one string. */
  readonly text: string;
}

/** One `## Heading` block of `behavior.md` and the rules beneath it. */
export interface BehaviorPolicySection {
  /** The heading text, without the leading `## `. */
  readonly heading: string;
  /**
   * Every entry under the heading, IN SOURCE ORDER. This ordering is the
   * authoritative one: a section that opens with a paragraph and then lists
   * bullets must project in that order, because the principal wrote it that way
   * and a reordered rule list changes what it appears to say.
   */
  readonly entries: readonly BehaviorPolicyEntry[];
  /** The bullet entries, in source order. Derived from {@link entries}. */
  readonly rules: readonly string[];
  /** The prose entries, in source order. Derived from {@link entries}. */
  readonly prose: readonly string[];
}

/** The parsed `behavior.md`. Sections keep their source order. */
export interface BehaviorPolicy {
  readonly sections: readonly BehaviorPolicySection[];
}

/** An empty policy — what an absent or ruleless `behavior.md` parses to. */
export const EMPTY_BEHAVIOR_POLICY: BehaviorPolicy = { sections: [] };

/**
 * Sections whose content is preamble/provenance rather than behavioral rules.
 * Compared case-insensitively against the heading text.
 */
const NON_RULE_HEADINGS: ReadonlySet<string> = new Set(["provenance", "source", "about", "readme"]);

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

function headingText(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

function isBullet(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function bulletText(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "").trim();
}

/**
 * Fold a run of source lines into logical entries. A bullet opens an entry;
 * every following indented, non-bullet, non-blank line continues it. A blank
 * line closes the current entry. Non-bullet lines at column zero accumulate as
 * prose.
 */
function foldLines(lines: readonly string[]): BehaviorPolicyEntry[] {
  const entries: BehaviorPolicyEntry[] = [];
  let current: string[] | undefined;
  let currentIsRule = false;

  const flush = (): void => {
    if (current === undefined) return;
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text !== "") entries.push({ kind: currentIsRule ? "rule" : "prose", text });
    current = undefined;
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }

    if (isBullet(line)) {
      flush();
      current = [bulletText(line)];
      currentIsRule = true;
      continue;
    }

    if (current !== undefined) {
      // A continuation line of whatever entry is currently open, bullet or prose.
      current.push(line.trim());
      continue;
    }

    current = [line.trim()];
    currentIsRule = false;
  }

  flush();
  return entries;
}

/**
 * Parse `behavior.md` into its sections. Content before the first `## ` heading
 * (the document title and any preamble) is dropped: it is provenance, not rules.
 */
export function parseBehaviorPolicy(markdown: string): BehaviorPolicy {
  const lines = markdown.split("\n");
  const sections: BehaviorPolicySection[] = [];

  let heading: string | undefined;
  let buffer: string[] = [];

  const flushSection = (): void => {
    if (heading === undefined) return;
    if (NON_RULE_HEADINGS.has(heading.toLowerCase())) {
      heading = undefined;
      buffer = [];
      return;
    }
    const entries = foldLines(buffer);
    if (entries.length > 0) {
      sections.push({
        heading,
        entries,
        rules: entries.filter((entry) => entry.kind === "rule").map((entry) => entry.text),
        prose: entries.filter((entry) => entry.kind === "prose").map((entry) => entry.text),
      });
    }
    heading = undefined;
    buffer = [];
  };

  for (const line of lines) {
    if (isHeading(line)) {
      // A `# Title` at the top closes nothing and opens nothing; only `##`+
      // levels delimit sections, so a nested `### ` heading folds into its
      // parent section rather than starting a sibling.
      if (/^#\s/.test(line)) {
        flushSection();
        continue;
      }
      if (/^##\s/.test(line)) {
        flushSection();
        heading = headingText(line);
        continue;
      }
      if (heading !== undefined) buffer.push(headingText(line) + ":");
      continue;
    }

    if (heading !== undefined) buffer.push(line);
  }

  flushSection();
  return { sections };
}

/**
 * Render the parsed policy as advisory lines for `renderPolicyProjection`.
 * Each line is `<Heading>: <text>` so a substrate reading the flat advisory
 * list can still tell a scope rule from a verification rule.
 *
 * Bullets AND prose both render, IN SOURCE ORDER. In a principal-authored
 * policy file the difference between the two is formatting, not meaning:
 * `behavior.md`'s "Permission boundaries" and "External content" sections state
 * their rules as paragraphs, and dropping them for lacking a leading dash would
 * be the same silent truncation the wrapped-bullet fold exists to prevent.
 *
 * Rendering from `entries` rather than concatenating `rules` then `prose`
 * matters for the same reason: a section that opens with a paragraph and then
 * lists bullets would otherwise project with its opening sentence moved to the
 * end, silently reordering guidance the principal wrote in a deliberate order.
 */
export function behaviorPolicyAdvisory(policy: BehaviorPolicy | undefined): string[] {
  if (policy === undefined) return [];
  return policy.sections.flatMap((section) =>
    section.entries.map((entry) => `${section.heading}: ${entry.text}`),
  );
}
