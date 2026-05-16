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

// Patterns that mark "must execute" runtime blocks in PAI skill bodies. We
// strip the *executable instruction* (curl notification calls + the
// "MANDATORY" framing) but keep neutral prose.
const NOTIFICATION_HEADING = /^##+\s*(?:🚨\s*)?MANDATORY[^\n]*$/m;
const NOTIFICATION_CURL = /^\s*curl\s+[^\n]*localhost:31337\/notify[^\n]*\n?/gm;

const CLAUDE_HOME_DETERMINISTIC: readonly { from: RegExp; to: string; kind: PaiPackNormalizationAction["kind"] }[] = [
  // Skill payload root — has a clean Soma equivalent
  { from: /~\/\.claude\/skills\//g, to: "~/.soma/skills/", kind: "rewrote-claude-home-path" },
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
  /\b(?:rm|mv|cp|mkdir|chmod|chown|touch)\s+(?:-[a-zA-Z]+\s+)*~\/\.claude\//g,
];

const RELEASE_SAFETY_PATTERN = /\b(?:scan|grep|check)\b[^\n]*(?:(?:secret|credential|token|key)[^\n]*~\/\.claude\/|~\/\.claude\/[^\n]*(?:secret|credential|token|key))/gi;

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

function stripMandatoryNotificationBlock(
  relPath: string,
  content: string,
  actions: PaiPackNormalizationAction[],
): string {
  if (!NOTIFICATION_HEADING.test(content) && !NOTIFICATION_CURL.test(content)) {
    return content;
  }

  // Remove a MANDATORY notification section: heading line plus all content
  // until the next `## ` heading (or end of file). This is the section-level
  // strip the PAI pack research recommended.
  const headingMatch = NOTIFICATION_HEADING.exec(content);
  let stripped = content;
  if (headingMatch) {
    const start = headingMatch.index;
    const rest = stripped.slice(start + headingMatch[0].length);
    const nextHeading = /^##+\s+/m.exec(rest);
    const end = nextHeading ? start + headingMatch[0].length + nextHeading.index : stripped.length;
    stripped = `${stripped.slice(0, start).replace(/\n+$/, "\n")}${stripped.slice(end)}`;
    actions.push({
      file: relPath,
      kind: "stripped-mandatory-runtime-block",
      detail: "Removed mandatory runtime block (notification heading).",
    });
  }

  // Strip any stragglers — bare curl notification commands outside a heading.
  if (NOTIFICATION_CURL.test(stripped)) {
    stripped = stripped.replace(NOTIFICATION_CURL, "");
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
      working = working.replace(rule.from, rule.to);
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
  return {
    schema: "soma.skill.v1",
    name: input.skillName,
    description: input.description || `Imported PAI pack: ${input.packName}`,
    packId: input.packId,
    source: { kind: "pai-pack", packName: input.packName },
    entrypoint: input.entrypoint,
    references: [...input.references].sort(),
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
