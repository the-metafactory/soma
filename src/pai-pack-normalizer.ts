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

// PAI `## Customization` runtime block. Issue #86 / AC-2.
//
// PAI's Customization block instructs the assistant to look in
// `~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/<SkillName>/` for user overlays.
// Soma deliberately does not grow a SKILLCUSTOMIZATIONS equivalent in this
// PR (see issue body "Out of scope"). The block is stripped as a PAI runtime
// hook, the same way the MANDATORY notification block is stripped — not
// rewritten, because there is no Soma side to point at.
//
// Anchored on the SKILLCUSTOMIZATIONS marker inside the section body so an
// unrelated "## Customization" heading (e.g. theme docs) survives intact.
const CUSTOMIZATION_HEADING = /^##+\s*Customization\s*$/m;
const CUSTOMIZATION_BODY_MARKER = "SKILLCUSTOMIZATIONS";

// Deterministic Claude → Soma rewrite rules. Ordered most-specific-first so a
// PAI subtree match (e.g. PAI/DOCUMENTATION) wins over a less-specific match
// would the latter exist. Every rule fires BEFORE `applyUnmappedClaudePathCatchall`
// (see `normalizeSkillContent`) — that ordering is what keeps the UNMAPPED
// warning class reserved for paths Soma genuinely cannot home.
//
// Issue #91: replaced the prior single `rewrote-claude-home-path` PAI/MEMORY
// rule with four named per-subtree kinds. Each rule's action kind tells a
// reviewer exactly which subtree contract fired, which #86's single shared
// kind could not — at scale, the audit trail has to disambiguate. Mapping
// targets are anchored to the Soma homes established by #88 (memory taxonomy)
// and #89 (soma import pai-docs); without those upstream issues these rules
// would dangle.
const CLAUDE_HOME_DETERMINISTIC: readonly { from: RegExp; to: string; kind: PaiPackNormalizationAction["kind"] }[] = [
  // Skill payload root — clean Soma equivalent.
  { from: /~\/\.claude\/skills\//, to: "~/.soma/skills/", kind: "rewrote-claude-home-path" },
  // Issue #91 / AC-1: PAI docs subtree → Soma docs subtree. The `~/.soma/PAI/`
  // root is populated by `soma import pai-docs` (#89); imported skills that
  // reference DOCUMENTATION resolve to a real on-disk file after import.
  { from: /~\/\.claude\/PAI\/DOCUMENTATION\//, to: "~/.soma/PAI/DOCUMENTATION/", kind: "rewrote-pai-doc-path" },
  // Issue #91 / AC-1: PAI templates subtree → Soma templates subtree.
  { from: /~\/\.claude\/PAI\/TEMPLATES\//, to: "~/.soma/PAI/TEMPLATES/", kind: "rewrote-pai-template-path" },
  // Issue #91 / AC-1: PAI algorithm subtree → Soma algorithm subtree.
  { from: /~\/\.claude\/PAI\/ALGORITHM\//, to: "~/.soma/PAI/ALGORITHM/", kind: "rewrote-pai-algorithm-path" },
  // Issue #91 / AC-1 (promotes #86 partial): PAI memory root → Soma memory
  // root. Both substrates share the "memory" concept; mapping is one-to-one.
  // The deeper subtree shape (SKILLS/execution.jsonl etc.) is preserved.
  // Asymmetric target: PAI's `PAI/MEMORY/` lands at lowercase `~/.soma/memory/`
  // because Soma's memory is canonical (per DD-1, DD-2) — not a PAI projection.
  { from: /~\/\.claude\/PAI\/MEMORY\//, to: "~/.soma/memory/", kind: "rewrote-pai-memory-path" },
];

// Issue #86 / AC-1: catch-all for every other `~/.claude/<segment>/...`
// path. Runs AFTER the deterministic rewrites and AFTER the Customization
// block strip, so it only fires on paths that have no Soma equivalent and
// have not been removed. Rewrites to a visible `~/.soma/UNMAPPED/<rest>`
// placeholder so runtime breakage is loud (the path does not exist) and
// emits a `unmapped-claude-home-path` warning so import-time review is loud.
// Together these satisfy AC-3 (zero `~/.claude/` residue in the body) and
// AC-1 (no silent passthrough — every unmapped reference shows up in the
// audit trail).
const CLAUDE_HOME_CATCHALL = /~\/\.claude\/([^\s`'")\]]+)/;
const CLAUDE_HOME_UNMAPPED_PREFIX = "~/.soma/UNMAPPED/";

// AC-3 strict-grep guard: a naked `~/.claude` or `~/.claude/` (no further
// path content) in prose ("they never leave ~/.claude") would survive the
// CLAUDE_HOME_CATCHALL above because it requires at least one character
// after the slash. Rewrite the bare form to `~/.soma` so the issue's
// reproduction `grep -n "~/.claude" SKILL.md Workflows/*.md` returns zero.
// The lookahead anchors on what definitively continues a path segment —
// alphanumeric, underscore, or dot-followed-by-alnum (for `.ts`, `.md`,
// etc.). Period-followed-by-space-or-EOL is sentence punctuation, not a
// path continuation. Anything that the substantive CLAUDE_HOME_CATCHALL
// already matched is gone by the time this regex runs.
const CLAUDE_HOME_BARE = /~\/\.claude\/?(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/;

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
  // Strip the PAI Customization block BEFORE any path rewriting so the
  // ~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/... path inside the block is
  // removed wholesale rather than rewritten — there is no Soma equivalent
  // mechanism to point at (issue #86 / AC-2, "Out of scope" note).
  working = stripPaiCustomizationBlock(relPath, working, actions);
  working = applyDeterministicPathRewrites(relPath, working, actions);
  // Catch-all runs LAST so deterministic rewrites and runtime-block strips
  // get first crack. Anything still containing `~/.claude/...` after this
  // point is unmapped — rewritten to `~/.soma/UNMAPPED/...` with a warning.
  working = applyUnmappedClaudePathCatchall(relPath, working, actions, warnings);

  return { content: working, actions, warnings };
}

// Tokens that prove a MANDATORY section is the notification runtime block we
// want to strip, not an unrelated MANDATORY section like "MANDATORY: Input
// Requirements". Without one of these, we leave the heading alone — Sage
// round-2 blocker.
const NOTIFICATION_BODY_MARKERS = /localhost:31337\/notify|voice notification|notify endpoint/i;

// Returns the ATX heading level (count of leading `#`s) for a matched
// heading string like `"## Customization"`. The matched string is
// guaranteed to start with `#`s by the heading regex it came from.
function headingHashCount(headingText: string): number {
  const hashes = /^(#+)/.exec(headingText);
  return hashes ? hashes[1].length : 0;
}

// Returns a fresh regex that matches the next ATX heading at the given
// level or higher (fewer `#`s = higher level). Used to compute where a
// stripped section ends — a deeper heading is part of the section's
// hierarchy, but a same-or-higher heading starts the next section.
//
// Precondition: `level >= 1`. Sage R3 (PR #87) Maintainability nit: the
// only call site (`stripMarkedHeadingSections`) gets `level` from
// `headingHashCount(headingText)` where `headingText` is captured by a
// regex anchored on `^#+`, so `level >= 1` is always true. Asserting here
// keeps the contract explicit instead of carrying a dead defensive branch.
function sameOrHigherHeadingBoundary(level: number): RegExp {
  if (level < 1) {
    throw new Error(`sameOrHigherHeadingBoundary: level must be >= 1, got ${level}`);
  }
  return new RegExp(`^#{1,${level}}\\s+`, "m");
}

// Sage R1 + R2 (PR #87) Maintainability + CodeQuality: shared section-
// strip helper. Iterates every match of `headingRegex` (a heading line
// anchored with /m), measures the section span to the next same-or-higher
// ATX heading or EOF, and strips every section whose body satisfies
// `markerMatches`. Returns the stripped content and the count of sections
// actually removed.
//
// "Iterate every match" was the R1 fix: the original stripper only
// inspected the first match, so an unrelated `## Customization` ahead of
// the real PAI runtime block would prevent the strip from firing on the
// later block. "Same-or-higher boundary" was the R2 fix: the original
// boundary regex `/^##+\s+/m` would swallow an H1 between the stripped
// `##` block and the next `##`.
function stripMarkedHeadingSections(
  content: string,
  headingRegex: RegExp,
  markerMatches: (sectionBody: string) => boolean,
): { content: string; stripped: number } {
  // Collect ALL match positions first so position math does not shift
  // mid-iteration. The heading regex is multiline-anchored; using
  // globalize() guarantees we never share lastIndex with caller-side
  // `.test()` / `.exec()` calls on the same RegExp instance.
  const matchPositions: { start: number; headingText: string }[] = [];
  const scanner = globalize(headingRegex);
  let scan: RegExpExecArray | null;
  while ((scan = scanner.exec(content)) !== null) {
    matchPositions.push({ start: scan.index, headingText: scan[0] });
    // Defend against zero-width matches looping forever.
    if (scan.index === scanner.lastIndex) scanner.lastIndex += 1;
  }

  if (matchPositions.length === 0) {
    return { content, stripped: 0 };
  }

  // Resolve each match to its section span [start, end) over the ORIGINAL
  // content. End is either the next same-or-higher ATX heading after the
  // section header, or EOF. Filter to the ones whose body matches the
  // marker.
  //
  // Sage R2 (PR #87) CodeQuality fix: the original boundary regex
  // `/^##+\s+/m` only matched `##+`, so an H1 between the stripped block
  // and the next `##` was swallowed. Boundary is now computed from the
  // matched heading's own level — for a `##` strip, any `#` or `##` ends
  // the section; deeper headings (`###`+) are treated as in-section
  // subsections and stripped along with the parent block.
  const stripSpans: { start: number; end: number }[] = [];
  for (const { start, headingText } of matchPositions) {
    const headingLength = headingText.length;
    const level = headingHashCount(headingText);
    const boundary = sameOrHigherHeadingBoundary(level);
    const rest = content.slice(start + headingLength);
    const nextHeading = boundary.exec(rest);
    const end = nextHeading ? start + headingLength + nextHeading.index : content.length;
    const sectionBody = content.slice(start, end);
    if (markerMatches(sectionBody)) {
      stripSpans.push({ start, end });
    }
  }

  if (stripSpans.length === 0) {
    return { content, stripped: 0 };
  }

  // Splice spans out from the tail so earlier indices remain valid.
  let working = content;
  for (let i = stripSpans.length - 1; i >= 0; i--) {
    const { start, end } = stripSpans[i];
    working = `${working.slice(0, start).replace(/\n+$/, "\n")}${working.slice(end)}`;
  }

  return { content: working, stripped: stripSpans.length };
}

function stripMandatoryNotificationBlock(
  relPath: string,
  content: string,
  actions: PaiPackNormalizationAction[],
): string {
  if (!NOTIFICATION_HEADING.test(content) && !NOTIFICATION_CURL.test(content)) {
    return content;
  }

  // Sage R1 fix: use the shared helper. Strips every MANDATORY section
  // whose body is the notification runtime block. Conservative gating
  // (NOTIFICATION_BODY_MARKERS) preserves `## MANDATORY: Input Requirements`.
  const { content: afterHeadingStrip, stripped: headingStrips } = stripMarkedHeadingSections(
    content,
    NOTIFICATION_HEADING,
    (sectionBody) => NOTIFICATION_BODY_MARKERS.test(sectionBody),
  );
  let stripped = afterHeadingStrip;
  if (headingStrips > 0) {
    actions.push({
      file: relPath,
      kind: "stripped-mandatory-runtime-block",
      detail: headingStrips === 1
        ? "Removed mandatory notification runtime block."
        : `Removed ${headingStrips} mandatory notification runtime blocks.`,
    });
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

function stripPaiCustomizationBlock(
  relPath: string,
  content: string,
  actions: PaiPackNormalizationAction[],
): string {
  if (!CUSTOMIZATION_HEADING.test(content)) {
    return content;
  }

  // Sage R1 (PR #87) CodeQuality fix: strip ALL `## Customization`
  // sections whose body contains the SKILLCUSTOMIZATIONS marker — not
  // just the first match. An unrelated `## Customization` heading
  // earlier in the document (e.g. theme docs) must not shield a later
  // PAI runtime block from removal.
  const { content: stripped, stripped: count } = stripMarkedHeadingSections(
    content,
    CUSTOMIZATION_HEADING,
    (sectionBody) => sectionBody.includes(CUSTOMIZATION_BODY_MARKER),
  );

  if (count === 0) {
    return content;
  }

  actions.push({
    file: relPath,
    kind: "stripped-pai-customization-block",
    detail: count === 1
      ? "Removed PAI Customization runtime block referencing ~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/."
      : `Removed ${count} PAI Customization runtime blocks referencing ~/.claude/PAI/USER/SKILLCUSTOMIZATIONS/.`,
  });
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

function applyUnmappedClaudePathCatchall(
  relPath: string,
  content: string,
  actions: PaiPackNormalizationAction[],
  warnings: PaiPackNormalizationWarning[],
): string {
  let working = content;
  const seenRests = new Set<string>();

  if (CLAUDE_HOME_CATCHALL.test(working)) {
    working = working.replace(globalize(CLAUDE_HOME_CATCHALL), (_match, rest: string) => {
      // The first segment after `~/.claude/` is the routing root; record it
      // for a single representative warning per file (avoids exploding the
      // audit trail when the same root appears 20 times in one workflow).
      const firstSegment = rest.split("/")[0] ?? "";
      if (firstSegment && !seenRests.has(firstSegment)) {
        seenRests.add(firstSegment);
        warnings.push({
          file: relPath,
          kind: "unmapped-claude-home-path",
          detail: `~/.claude/${firstSegment}/ has no Soma equivalent; rewrote to ${CLAUDE_HOME_UNMAPPED_PREFIX}${firstSegment}/ so runtime breakage is visible.`,
        });
      }
      return `${CLAUDE_HOME_UNMAPPED_PREFIX}${rest}`;
    });
  }

  // After the substantive catch-all, scrub bare `~/.claude` / `~/.claude/`
  // mentions (prose like "never leave ~/.claude") so a bare grep on the
  // projected body returns zero. These get a separate warning class so the
  // distinction between "broken path reference" and "stale prose mention"
  // stays visible in the audit trail.
  if (CLAUDE_HOME_BARE.test(working)) {
    working = working.replace(globalize(CLAUDE_HOME_BARE), "~/.soma");
    if (!seenRests.has("__bare__")) {
      seenRests.add("__bare__");
      warnings.push({
        file: relPath,
        kind: "unmapped-claude-home-path",
        detail: "Bare ~/.claude prose mention rewrote to ~/.soma to satisfy AC-3 zero-residue grep.",
      });
    }
  }

  if (working !== content) {
    actions.push({
      file: relPath,
      kind: "rewrote-unmapped-claude-path",
      detail: `Rewrote ${seenRests.size} unmapped ~/.claude/ reference(s) to ${CLAUDE_HOME_UNMAPPED_PREFIX} placeholder (or ~/.soma for bare mentions).`,
    });
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
    // Substrates with real portable-skill projection. Algorithm
    // capability registration filters on this list per substrate;
    // skill-file projection does not.
    substrates: ["claude-code", "codex", "grok", "pi-dev"],
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
