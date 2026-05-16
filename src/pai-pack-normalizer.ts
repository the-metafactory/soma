/**
 * PAI pack import-time normalizer.
 *
 * Deterministic, auditable transformations applied to staged PAI pack content
 * before it is promoted into `~/.soma/skills/`. The normalizer never makes
 * semantic rewrites — it strips known substrate-specific runtime blocks,
 * deterministically rewrites a small set of Claude→Soma paths, and emits
 * warnings for everything else.
 *
 * Boundaries (locked):
 * - No LLM rewrites.
 * - No personal/private context inference.
 * - No execution of embedded commands.
 * - Original PAI source remains available in `imports/pai-packs/<skill>/`.
 *
 * Output of `normalizeSkillContent` flows into `soma-pack.json` as the
 * `normalization` field so every action and warning is reviewable.
 */
import type {
  PaiPackNormalizationAction,
  PaiPackNormalizationWarning,
  PaiPackNormalizationReport,
  SomaSkillManifest,
} from "./types";

export interface NormalizeContentResult {
  content: string;
  actions: PaiPackNormalizationAction[];
  warnings: PaiPackNormalizationWarning[];
}

export const SOMA_SKILL_DESCRIPTION_MAX_LENGTH = 1024;

// Patterns that mark "must execute" runtime blocks in PAI skill bodies. We
// strip the *executable instruction* (curl notification calls + the
// "MANDATORY" framing) but keep neutral prose.
//
// NOTE: every pattern below is used non-globally (no `g` / `y` flags) so
// that `.test()` calls are stateless across files. Replace operations build
// fresh global copies on demand via `globalize()`.
const NOTIFICATION_HEADING = /^##+\s*(?:🚨\s*)?MANDATORY[^\n]*$/m;
const NOTIFICATION_CURL = /^\s*curl\s+[^\n]*localhost:31337\/notify[^\n]*\n?/m;

const CLAUDE_HOME_DETERMINISTIC: readonly { from: RegExp; to: string; kind: PaiPackNormalizationAction["kind"] }[] = [
  // Skill payload root — has a clean Soma equivalent
  { from: /~\/\.claude\/skills\//, to: "~/.soma/skills/", kind: "rewrote-claude-home-path" },
];

const CLAUDE_HOME_AMBIGUOUS: readonly { pattern: RegExp; kind: PaiPackNormalizationWarning["kind"]; detail: string }[] = [
  {
    pattern: /~\/\.claude\/(?:context|user|customization)\//,
    kind: "customization-overlay-reference",
    detail: "User customization overlay path has no Soma equivalent; decide overlay model before projecting.",
  },
  {
    pattern: /~\/\.claude\/memory\//,
    kind: "execution-logging-path",
    detail: "Claude memory path detected; route through Soma memory event writeback instead.",
  },
  {
    pattern: /~\/\.claude\/(?:docs|documentation)\//,
    kind: "ambiguous-substrate-path",
    detail: "Claude documentation path has no deterministic Soma mapping.",
  },
  {
    pattern: /~\/\.claude\/(?:history|backup|logs)\//,
    kind: "execution-logging-path",
    detail: "Claude history/backup path; needs Soma memory event mapping.",
  },
];

const MUTATION_COMMAND_PATTERNS: readonly RegExp[] = [
  /\b(?:rm|mv|cp|mkdir|chmod|chown|touch)\s+(?:-[a-zA-Z]+\s+)*~\/\.claude\//,
];

const RELEASE_SAFETY_PATTERN = /\b(?:scan|grep|check)\b[^\n]*(?:(?:secret|credential|token|key)[^\n]*~\/\.claude\/|~\/\.claude\/[^\n]*(?:secret|credential|token|key))/i;

function globalize(source: RegExp): RegExp {
  // Build a fresh global copy for replace-all calls; never share state with
  // the canonical test regex.
  const flags = source.flags.includes("g") ? source.flags : `${source.flags}g`;
  return new RegExp(source.source, flags);
}

export function normalizeSkillContent(relPath: string, content: string): NormalizeContentResult {
  const actions: PaiPackNormalizationAction[] = [];
  const warnings: PaiPackNormalizationWarning[] = [];

  // Collect warnings against the ORIGINAL content — otherwise deterministic
  // rewrites (e.g. ~/.claude/skills/ → ~/.soma/skills/) erase the patterns
  // we want to flag in surrounding context (release-safety scans,
  // ambiguous adjacent paths, mutation commands).
  collectAmbiguousPathWarnings(relPath, content, warnings);
  collectMutationCommandWarnings(relPath, content, warnings);
  collectReleaseSafetyWarnings(relPath, content, warnings);

  let working = stripMandatoryNotificationBlock(relPath, content, actions);
  working = applyDeterministicPathRewrites(relPath, working, actions);

  return { content: working, actions, warnings };
}

// Tokens that prove a MANDATORY section is the notification runtime block we
// want to strip, not an unrelated MANDATORY section like "MANDATORY: Input
// Requirements". Without one of these, we leave the heading alone — Sage
// round-2 blocker.
const NOTIFICATION_BODY_MARKERS = /localhost:31337\/notify|voice notification|notify endpoint/i;

function stripMandatoryNotificationBlock(
  relPath: string,
  content: string,
  actions: PaiPackNormalizationAction[],
): string {
  if (!NOTIFICATION_HEADING.test(content) && !NOTIFICATION_CURL.test(content)) {
    return content;
  }

  let stripped = content;
  const headingMatch = NOTIFICATION_HEADING.exec(content);
  if (headingMatch) {
    const start = headingMatch.index;
    const rest = stripped.slice(start + headingMatch[0].length);
    const nextHeading = /^##+\s+/m.exec(rest);
    const end = nextHeading ? start + headingMatch[0].length + nextHeading.index : stripped.length;
    const sectionBody = stripped.slice(start, end);
    // Only strip when the section's body proves it is the notification
    // runtime block (curl invocation or notification keyword). A heading
    // like "## MANDATORY: Input Requirements" survives.
    if (NOTIFICATION_BODY_MARKERS.test(sectionBody)) {
      stripped = `${stripped.slice(0, start).replace(/\n+$/, "\n")}${stripped.slice(end)}`;
      actions.push({
        file: relPath,
        kind: "stripped-mandatory-runtime-block",
        detail: "Removed mandatory notification runtime block.",
      });
    }
  }

  // Strip any stragglers — bare curl notification commands outside a heading.
  if (NOTIFICATION_CURL.test(stripped)) {
    stripped = stripped.replace(globalize(NOTIFICATION_CURL), "");
    actions.push({
      file: relPath,
      kind: "removed-substrate-notification-hook",
      detail: "Removed localhost:31337/notify curl invocation.",
    });
  }

  return stripped.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function applyDeterministicPathRewrites(
  relPath: string,
  content: string,
  actions: PaiPackNormalizationAction[],
): string {
  let working = content;
  for (const rule of CLAUDE_HOME_DETERMINISTIC) {
    if (rule.from.test(working)) {
      working = working.replace(globalize(rule.from), rule.to);
      actions.push({
        file: relPath,
        kind: rule.kind,
        detail: `Rewrote ${rule.from.source} → ${rule.to}`,
      });
    }
  }
  return working;
}

function collectAmbiguousPathWarnings(
  relPath: string,
  content: string,
  warnings: PaiPackNormalizationWarning[],
): void {
  for (const rule of CLAUDE_HOME_AMBIGUOUS) {
    if (rule.pattern.test(content)) {
      warnings.push({ file: relPath, kind: rule.kind, detail: rule.detail });
    }
  }
}

function collectMutationCommandWarnings(
  relPath: string,
  content: string,
  warnings: PaiPackNormalizationWarning[],
): void {
  for (const pattern of MUTATION_COMMAND_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push({
        file: relPath,
        kind: "substrate-mutation-command",
        detail: "Detected embedded command that mutates Claude home; review before projecting.",
      });
      break;
    }
  }
}

function collectReleaseSafetyWarnings(
  relPath: string,
  content: string,
  warnings: PaiPackNormalizationWarning[],
): void {
  if (RELEASE_SAFETY_PATTERN.test(content)) {
    warnings.push({
      file: relPath,
      kind: "release-safety-path",
      detail: "Claude-specific release-safety check; integrate with Soma policy model.",
    });
  }
}

export function mergeNormalizationReports(
  reports: readonly { actions: PaiPackNormalizationAction[]; warnings: PaiPackNormalizationWarning[] }[],
): PaiPackNormalizationReport {
  return {
    mode: "deterministic",
    actions: reports.flatMap((report) => report.actions),
    warnings: reports.flatMap((report) => report.warnings),
  };
}

export interface NormalizeSkillDescriptionResult {
  description: string;
  action?: PaiPackNormalizationAction;
}

export function normalizeSkillDescription(
  description: string,
  options: {
    file: string;
    fallback: string;
    maxLength?: number;
  },
): NormalizeSkillDescriptionResult {
  const maxLength = options.maxLength ?? SOMA_SKILL_DESCRIPTION_MAX_LENGTH;
  const source = (description || options.fallback).replace(/\s+/g, " ").trim();
  const fallback = options.fallback.replace(/\s+/g, " ").trim();
  const initial = source || fallback;
  if (initial.length <= maxLength) {
    return { description: initial };
  }

  const sentences = initial.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ?? [];
  let compact = "";
  for (const sentence of sentences) {
    const next = compact ? `${compact} ${sentence}` : sentence;
    if (next.length > maxLength) break;
    compact = next;
  }

  if (!compact) {
    compact = initial.slice(0, maxLength).trimEnd();
    compact = compact.replace(/[,;:\s-]+$/u, "");
  }

  if (!compact) {
    compact = fallback.slice(0, maxLength).trimEnd();
  }

  return {
    description: compact,
    action: {
      file: options.file,
      kind: "compacted-skill-description",
      detail: `Compacted skill description from ${initial.length} to ${compact.length} characters for Soma's portable ${maxLength}-character skill metadata limit.`,
    },
  };
}

export interface GenerateSomaSkillManifestInput {
  skillName: string;
  description: string;
  packName: string;
  packId?: string;
  entrypoint: string;
  references: string[];
  workflowFiles: string[];
}

export function generateSomaSkillManifest(input: GenerateSomaSkillManifestInput): SomaSkillManifest {
  const { description } = normalizeSkillDescription(input.description, {
    file: "soma-skill.json",
    fallback: `Imported PAI pack: ${input.packName}`,
  });

  return {
    schema: "soma.skill.v1",
    name: input.skillName,
    description,
    packId: input.packId,
    source: { kind: "pai-pack", packName: input.packName },
    entrypoint: input.entrypoint,
    references: [...input.references].sort(),
    workflows: [...input.workflowFiles].sort(),
    tools: [],
    triggers: extractTriggersFromDescription(input.description),
    substrates: ["claude-code", "codex", "pi-dev"],
  };
}

const TRIGGER_PATTERN = /USE WHEN:?\s*([^.]+)\./i;

function extractTriggersFromDescription(description: string): string[] {
  const match = TRIGGER_PATTERN.exec(description);
  if (!match) return [];
  return match[1]
    .split(/,(?![^()]*\))/)
    .map((trigger) => trigger.trim())
    .filter((trigger) => trigger.length > 0 && trigger.length < 80)
    .slice(0, 12);
}
