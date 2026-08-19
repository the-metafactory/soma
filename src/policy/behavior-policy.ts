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
 * Parsing is intentionally NOT `soma-home.ts`'s `sectionBullets`. Why the fold,
 * the prose handling, and the source ordering are each required is argued once,
 * in `docs/substrate-adapters.md` under "Communication Contract And Behavioral
 * Policy" — not restated here.
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
}

/** The parsed `behavior.md`. Sections keep their source order. */
export interface BehaviorPolicy {
  readonly sections: readonly BehaviorPolicySection[];
}

/** An empty policy — what an absent or ruleless `behavior.md` parses to. */
export const EMPTY_BEHAVIOR_POLICY: BehaviorPolicy = { sections: [] };

/** One `## Heading` block: the heading text and its raw body lines. */
interface MarkdownSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

/**
 * Split `behavior.md` on `##` headings, in source order.
 *
 * Only `##` delimits: a leading `# Title` closes the current section and opens
 * nothing (a document title is not a section), and a deeper `### ` folds into
 * its parent as a `Heading:` body line rather than starting a sibling — so a
 * nested heading's rules stay attached to the section that owns them. Content
 * before the first `## ` is the title and provenance preamble, never rules, and
 * is dropped.
 *
 * Fenced blocks are skipped wholesale. Without fence tracking a `# comment`
 * line inside a fenced example closes the open section and opens a bogus one,
 * discarding every remaining rule beneath it — the same silent truncation the
 * wrapped-bullet fold exists to prevent, and a plausible thing to write in a
 * policy file that shows a command.
 */
function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];

  let heading: string | undefined;
  let lines: string[] = [];
  let fence: string | undefined;

  const flush = (): void => {
    if (heading !== undefined) sections.push({ heading, lines });
    heading = undefined;
    lines = [];
  };

  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1][0].repeat(3);
      if (fence === undefined) fence = marker;
      else if (marker === fence) fence = undefined;
      if (heading !== undefined) lines.push(line);
      continue;
    }

    if (fence !== undefined || !/^#{1,6}\s/.test(line)) {
      if (heading !== undefined) lines.push(line);
      continue;
    }

    const text = line.replace(/^#{1,6}\s+/, "").trim();

    if (/^#\s/.test(line)) {
      flush();
      continue;
    }

    if (/^##\s/.test(line)) {
      flush();
      heading = text;
      continue;
    }

    if (heading !== undefined) lines.push(`${text}:`);
  }

  flush();
  return sections;
}

/** `- `, `* `, `1. `, and `1) ` all open a rule. */
const BULLET = /^\s*(?:[-*]|\d+[.)])\s+/;

function isBullet(line: string): boolean {
  return BULLET.test(line);
}

function bulletText(line: string): string {
  return line.replace(BULLET, "").trim();
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
  const sections: BehaviorPolicySection[] = [];

  // Every `## ` section projects. There is deliberately no heading blacklist:
  // provenance lives in the preamble before the first `## ` (which is dropped
  // below), and silently discarding a section because of its NAME would be the
  // fail-open-to-silence this module refuses everywhere else — the principal
  // would have no way to tell a dropped rule from a projected one.
  for (const section of splitMarkdownSections(markdown)) {
    const entries = foldLines(section.lines);
    if (entries.length > 0) sections.push({ heading: section.heading, entries });
  }

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
