import type { SomaSkill } from "../../types";

/**
 * soma#371 — the compact skill registry projection.
 *
 * The pre-#371 `renderSkills` emitted a `## <name>` heading, the FULL
 * frontmatter `description`, a `Path:` line, and a `Triggers:` bullet list
 * per skill — roughly 9 lines/skill, ~963 lines across the real ~104-skill
 * home. That entire catalog is eager context in every session (it is not
 * behind the Skill tool's on-demand load — only a skill's *body*
 * (`SKILL.md`) loads on demand; the catalog that tells the router a skill
 * exists loads every time), so its verbosity crowds out routing signal
 * rather than helping it.
 *
 * This module renders one tight entry per skill instead: name, a truncated
 * lead clause of the description, and the path on a single line, plus two
 * OPTIONAL follow-up lines — `triggers:` (from the skill's structured
 * `triggers` array) and `not:` (an anti-trigger clause extracted from the
 * description's inline prose, since skills declare anti-triggers only that
 * way today — there is no structured field for it, see soma#371's
 * out-of-scope note about adding one).
 */

/** Enforced by `renderSkills` output — see `test/skill-registry.test.ts`. */
export const SKILL_REGISTRY_LINE_BUDGET = 300;

/** Word-boundary truncation length for the per-skill lead-clause summary. */
export const SHORT_DESCRIPTION_MAX_LENGTH = 160;

/**
 * Markers whose presence means "the rest of this description is routing
 * guidance the registry shows structured instead" (triggers via the
 * `triggers` array, anti-triggers via `extractAntiTriggers` below) — so the
 * lead-clause summary is cut before the earliest one. A bare `NOT` is
 * deliberately NOT one of these: unlike `USE WHEN` / `NOT FOR` / `SKIP:`,
 * plain prose uses lowercase "not" constantly, and even the uppercase
 * shouted form ("Do NOT trigger on...") reads as a clause fragment, not a
 * tail — truncating there would leave the lead clause ending mid-sentence
 * on a dangling word. `extractAntiTriggers` still recognizes a bare `NOT`
 * as an anti-trigger marker (best-effort, lower priority); this pattern
 * only governs where the SHORT description gets cut.
 */
const LEAD_CLAUSE_MARKER = /\bUSE WHEN:?\s+|\bNOT FOR:?\s+|\bSKIP:\s+/;

/**
 * Anti-trigger markers, ordered so the regex engine prefers the more
 * specific alternative when both start at the same index (`NOT FOR` is
 * tried before the bare `NOT` it contains as a prefix). Case-sensitive on
 * purpose: real skill descriptions shout these keywords in caps
 * ("NOT FOR", "SKIP:", "Do NOT trigger"); ordinary prose ("does not",
 * "cannot") is lowercase and never matches.
 */
const ANTI_TRIGGER_MARKER = /\bNOT FOR:?\s+|\bSKIP:\s+|\bNOT\s+/;

/**
 * Extract an anti-trigger clause from a skill's description, best-effort.
 * Skills declare anti-triggers only as inline prose today (no structured
 * field — see soma#371's out-of-scope note), introduced by `NOT FOR `,
 * `SKIP: `, or a bare `NOT ` (in that priority). The clause runs from the
 * marker to the next sentence boundary (the first `.`) or the end of the
 * description. Returns `undefined` when no marker is present.
 */
export function extractAntiTriggers(description: string): string | undefined {
  const match = ANTI_TRIGGER_MARKER.exec(description);
  if (!match) return undefined;

  const rest = description.slice(match.index);
  const sentenceEnd = rest.indexOf(".");
  const clause = (sentenceEnd === -1 ? rest : rest.slice(0, sentenceEnd)).trim();
  return clause.length > 0 ? clause : undefined;
}

/**
 * The description's lead clause: everything before the earliest
 * `USE WHEN` / `NOT FOR` / `SKIP:` tail. Those tails are routing guidance
 * the registry shows structured instead (triggers array / `not:` line), so
 * repeating them in the summary would be redundant. Returns the whole
 * description unchanged when no marker is present.
 */
export function leadClause(description: string): string {
  const match = LEAD_CLAUSE_MARKER.exec(description);
  const clause = match ? description.slice(0, match.index) : description;
  return clause.trim();
}

/**
 * Truncate `text` to at most `maxLength` characters, cutting on a word
 * boundary (never mid-word) and appending an ellipsis when truncated.
 * Text at or under the limit is returned unchanged.
 */
export function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Render one skill as a compact registry entry:
 *
 * ```
 * - **<name>** — <short description> → <path>
 *   triggers: <t1>, <t2>, …            ← only when skill.triggers is non-empty
 *   not: <anti-triggers>               ← only when the description declares one
 * ```
 *
 * A skill with an empty description omits the `— <lead>` segment entirely
 * rather than rendering a dangling em dash.
 */
export function renderSkillRegistryEntry(skill: SomaSkill): string {
  const lead = truncateAtWordBoundary(leadClause(skill.description), SHORT_DESCRIPTION_MAX_LENGTH);
  const summary = lead.length > 0 ? `**${skill.name}** — ${lead}` : `**${skill.name}**`;
  const lines = [`- ${summary} → ${skill.path}`];

  if (skill.triggers.length > 0) {
    lines.push(`  triggers: ${skill.triggers.join(", ")}`);
  }

  const antiTriggers = extractAntiTriggers(skill.description);
  if (antiTriggers) {
    lines.push(`  not: ${antiTriggers}`);
  }

  return lines.join("\n");
}
