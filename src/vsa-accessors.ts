import type {
  AlgorithmEffortTier,
  AlgorithmLogEntry,
  AlgorithmMode,
  AlgorithmPhase,
  CriterionStatus,
  EvidenceKind,
  VerificationStateArtifact,
  Checkpoint,
  VsaSection,
} from "./types";

/**
 * Canonical section names for the twelve-section VSA schema.
 * The unified `VerificationStateArtifact` type itself is section-agnostic; lifecycle
 * hooks and validators operate on these well-known names.
 *
 * Order matters: when a missing section needs to be inserted, it is placed
 * at the index implied by this list.
 */
export const SECTION_NAME_MAP = {
  problem: "Problem",
  vision: "Vision",
  outOfScope: "Out of Scope",
  principles: "Principles",
  constraints: "Constraints",
  goal: "Goal",
  criteria: "Checkpoints",
  testStrategy: "Test Strategy",
  features: "Features",
  decisions: "Decisions",
  changelog: "Changelog",
  verification: "Verification",
} as const;

export const TWELVE_SECTIONS = Object.values(SECTION_NAME_MAP);

/**
 * soma#329 slice 4: legacy section headings a VSA may carry on disk, mapped to
 * their current canonical name. Reads accept either; writes emit the canonical
 * name. No migration — an untouched legacy VSA keeps its old heading; a mutated
 * one is upgraded in place by {@link setSection}.
 */
const SECTION_LEGACY_ALIASES: Record<string, readonly string[]> = {
  [SECTION_NAME_MAP.criteria]: ["Criteria"],
};

/** Inverse of {@link SECTION_LEGACY_ALIASES}: legacy heading → its canonical name. */
const SECTION_CANONICAL_BY_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(SECTION_LEGACY_ALIASES).flatMap(([canonical, aliases]) => aliases.map((alias) => [alias, canonical])),
);

/**
 * Map a (possibly legacy) section heading to its canonical name, so callers that
 * compare section names treat `Criteria` and `Checkpoints` as the same section.
 */
export function canonicalSectionName(name: string): string {
  return SECTION_CANONICAL_BY_ALIAS[name] ?? name;
}

/** Index of the section matching `name` exactly, else a declared legacy alias of `name`. */
function findSectionIndex(sections: readonly VsaSection[], name: string): number {
  const exact = sections.findIndex((section) => section.name === name);
  if (exact >= 0) return exact;
  for (const alias of SECTION_LEGACY_ALIASES[name] ?? []) {
    const aliasIndex = sections.findIndex((section) => section.name === alias);
    if (aliasIndex >= 0) return aliasIndex;
  }
  return -1;
}

export function getSection(isa: VerificationStateArtifact, name: string): VsaSection | null {
  const index = findSectionIndex(isa.sections, name);
  return index >= 0 ? isa.sections[index] : null;
}

export function getGoal(isa: VerificationStateArtifact): string | null {
  const section = getSection(isa, SECTION_NAME_MAP.goal);
  if (section === null) return null;
  const trimmed = section.content.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function getCriteria(isa: VerificationStateArtifact): Checkpoint[] {
  const section = getSection(isa, SECTION_NAME_MAP.criteria);
  if (section === null) return [];
  return parseCriteriaMarkdown(section.content);
}

export function getDecisions(isa: VerificationStateArtifact): AlgorithmLogEntry[] {
  return parseLogEntries(isa, SECTION_NAME_MAP.decisions);
}

export function getChangelog(isa: VerificationStateArtifact): AlgorithmLogEntry[] {
  return parseLogEntries(isa, SECTION_NAME_MAP.changelog);
}

export function getVerification(isa: VerificationStateArtifact): AlgorithmLogEntry[] {
  return parseLogEntries(isa, SECTION_NAME_MAP.verification);
}

export function setSection(isa: VerificationStateArtifact, name: string, content: string): VerificationStateArtifact {
  // Dual-read so a legacy-aliased section (e.g. `Criteria`) is found, replaced in
  // place, and renamed to the canonical `name`. If the VSA somehow carries BOTH
  // the canonical and a legacy-aliased section (hand-edited / partial state),
  // collapse them: replace the first match, drop the rest — never leave a stale
  // duplicate behind.
  const aliases = SECTION_LEGACY_ALIASES[name] ?? [];
  const matchesTarget = (sectionName: string): boolean => sectionName === name || aliases.includes(sectionName);
  const next: VsaSection = { name, content };

  if (isa.sections.some((section) => matchesTarget(section.name))) {
    let replaced = false;
    const sections: VsaSection[] = [];
    for (const section of isa.sections) {
      if (matchesTarget(section.name)) {
        if (!replaced) {
          sections.push(next);
          replaced = true;
        }
        continue; // drop any further canonical/legacy duplicate
      }
      sections.push(section);
    }
    return { ...isa, sections };
  }

  const insertIndex = canonicalInsertIndex(isa.sections, name);
  const sections = isa.sections.slice();
  sections.splice(insertIndex, 0, next);
  return { ...isa, sections };
}

export function setCriteria(isa: VerificationStateArtifact, criteria: readonly Checkpoint[]): VerificationStateArtifact {
  return setSection(isa, SECTION_NAME_MAP.criteria, renderCriteriaMarkdown(criteria));
}

export interface UpdateCriterionResult {
  isa: VerificationStateArtifact;
  criteria: Checkpoint[];
}

export function updateCriterionWithResult(
  isa: VerificationStateArtifact,
  criterionId: string,
  status: Checkpoint["status"],
  verification?: string,
  evidenceKind?: Checkpoint["evidenceKind"],
): UpdateCriterionResult {
  const criteria = getCriteria(isa);
  if (!criteria.some((criterion) => criterion.id === criterionId)) {
    throw new Error(`Algorithm criterion not found: ${criterionId}`);
  }
  const updated = criteria.map((criterion) =>
    criterion.id === criterionId
      ? {
          ...criterion,
          status,
          verification: verification ?? criterion.verification,
          evidenceKind: evidenceKind ?? criterion.evidenceKind,
        }
      : criterion,
  );
  return { isa: setCriteria(isa, updated), criteria: updated };
}

/** A criterion that no longer needs work: verified, dropped, or honestly deferred. */
export function isClosedCriterion(
  criterion: Checkpoint,
): criterion is Checkpoint & { status: "passed" | "dropped" | "deferred-probe" } {
  return (
    criterion.status === "passed" || criterion.status === "dropped" || criterion.status === "deferred-probe"
  );
}

/**
 * A `passed` criterion whose evidence is a specification/design claim only.
 * It is self-attested, not a real probe, so it must not clear the LEARN gate.
 */
export function isHollowPass(criterion: Checkpoint): boolean {
  return criterion.status === "passed" && criterion.evidenceKind === "specified";
}

/**
 * The evidence kind to record for a verification. A `passed` with no explicit
 * kind defaults to the weak, self-attested `specified` so it cannot silently
 * clear the LEARN gate; non-passed statuses carry no evidence kind.
 *
 * NOTE: the kind is caller-asserted. Soma records the claim — it does NOT verify
 * that a `probed`/`tested` label corresponds to a real probe or test. The gate
 * raises the bar from "any text passes" to "declare a probe/test or accept
 * deferred-probe"; it makes a hollow pass explicit and auditable, not impossible.
 */
export function defaultEvidenceKind(
  kind: EvidenceKind | undefined,
  status: CriterionStatus,
): EvidenceKind | undefined {
  return kind ?? (status === "passed" ? "specified" : undefined);
}

/**
 * VerificationGate (ported from PAI `EvidenceGate`, Ladder EX-00004): the
 * block-mode, record-time counterpart to #330's audit-time LEARN gate. #330
 * lets a hollow pass be RECORDED and only blocks it from COMPLETING; this
 * refuses to record a `passed` on specification-only or rote evidence in the
 * first place, so the caller learns immediately instead of at the finish line.
 *
 * Returns a violation (reason + message) when `status === "passed"` and the
 * evidence is either rote ("done"/"verified"/…) or specification-only (no
 * `probed`/`tested` kind declared); otherwise null. Escape hatches, same as the
 * LEARN gate: declare a real probe (`evidenceKind: "probed"|"tested"`) or record
 * `status: "deferred-probe"`. Non-`passed` statuses never violate.
 */
const ROTE_EVIDENCE = /^(?:done|verified|checked|confirmed|ok(?:ay)?|yes|pass(?:ed)?|complete[d]?|works?|looks?\s*good|good|fine)\.?$/i;

export function verificationGateViolation(
  status: CriterionStatus,
  evidence: string,
  evidenceKind: EvidenceKind | undefined,
): { reason: "rote_evidence" | "specification_only"; message: string } | null {
  if (status !== "passed") return null;
  const cleaned = evidence.trim().replace(/^evidence:\s*/i, "").trim();
  if (ROTE_EVIDENCE.test(cleaned)) {
    return {
      reason: "rote_evidence",
      message: `rote evidence rejected (${JSON.stringify(cleaned)}) — describe what you actually observed (a command + its output, a file:line, a probe result)`,
    };
  }
  if (defaultEvidenceKind(evidenceKind, status) === "specified") {
    return {
      reason: "specification_only",
      message: `specification-only evidence — declare a real probe (evidenceKind "probed" or "tested") or record status "deferred-probe"`,
    };
  }
  return null;
}

export function updateCriterion(
  isa: VerificationStateArtifact,
  criterionId: string,
  status: Checkpoint["status"],
  verification?: string,
): VerificationStateArtifact {
  return updateCriterionWithResult(isa, criterionId, status, verification).isa;
}

export function appendCriterion(isa: VerificationStateArtifact, criterion: Checkpoint): VerificationStateArtifact {
  const criteria = getCriteria(isa);
  if (criteria.some((existing) => existing.id === criterion.id)) {
    throw new Error(`Algorithm criterion already exists: ${criterion.id}`);
  }
  return setSection(isa, SECTION_NAME_MAP.criteria, renderCriteriaMarkdown([...criteria, criterion]));
}

export function appendVsaDecision(isa: VerificationStateArtifact, entry: AlgorithmLogEntry): VerificationStateArtifact {
  return appendLogEntry(isa, SECTION_NAME_MAP.decisions, entry);
}

export function appendVsaChangelog(isa: VerificationStateArtifact, entry: AlgorithmLogEntry): VerificationStateArtifact {
  return appendLogEntry(isa, SECTION_NAME_MAP.changelog, entry);
}

export function appendVsaVerification(isa: VerificationStateArtifact, entry: AlgorithmLogEntry): VerificationStateArtifact {
  return appendLogEntry(isa, SECTION_NAME_MAP.verification, entry);
}

function appendLogEntry(isa: VerificationStateArtifact, sectionName: string, entry: AlgorithmLogEntry): VerificationStateArtifact {
  const existing = parseLogEntries(isa, sectionName);
  return setSection(isa, sectionName, renderLogEntries([...existing, entry]));
}

function canonicalInsertIndex(sections: readonly VsaSection[], name: string): number {
  const canonicalOrder = TWELVE_SECTIONS as readonly string[];
  const targetIndex = canonicalOrder.indexOf(name);
  if (targetIndex < 0) {
    return sections.length;
  }
  for (let i = 0; i < sections.length; i++) {
    const sectionRank = canonicalOrder.indexOf(sections[i].name);
    if (sectionRank < 0 || sectionRank > targetIndex) {
      return i;
    }
  }
  return sections.length;
}

const CRITERION_LINE = /^- \[([ x\-_!~])\]\s+([^:]+):\s*(.+)$/;
const EVIDENCE_LINE = /^\s{2,}Evidence(?:\s*\((specified|probed|tested)\))?:\s*(.+)$/;

export function parseCriteriaMarkdown(content: string): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    const evidenceMatch = EVIDENCE_LINE.exec(rawLine);
    const last = out.at(-1);
    if (evidenceMatch !== null && last !== undefined) {
      const kind = evidenceMatch[1];
      last.verification = evidenceMatch[2].trim();
      if (kind === "specified" || kind === "probed" || kind === "tested") {
        last.evidenceKind = kind;
      }
      continue;
    }
    const criterion = parseCriterionLine(line.trim());
    if (criterion !== null) out.push(criterion);
  }
  return out;
}

function parseCriterionLine(line: string): Checkpoint | null {
  const match = CRITERION_LINE.exec(line);
  if (match === null) return null;
  const [, mark, idRaw, textRaw] = match;
  return {
    id: idRaw.trim(),
    text: textRaw.trim(),
    status: criterionStatusFromMark(mark),
  };
}

function criterionStatusFromMark(mark: string): Checkpoint["status"] {
  switch (mark) {
    case "x":
      return "passed";
    case "-":
      return "dropped";
    case "!":
      return "failed";
    case "~":
      return "deferred-probe";
    default:
      return "open";
  }
}

function criterionStatusMark(status: Checkpoint["status"]): string {
  switch (status) {
    case "passed":
      return "x";
    case "dropped":
      return "-";
    case "failed":
      return "!";
    case "deferred-probe":
      return "~";
    default:
      return " ";
  }
}

function assertSingleLine(field: string, criterionId: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Algorithm criterion ${criterionId} ${field} must not contain newlines.`);
  }
}

export function renderCriteriaMarkdown(criteria: readonly Checkpoint[]): string {
  if (criteria.length === 0) return "";
  return criteria
    .map((criterion) => {
      assertSingleLine("id", criterion.id, criterion.id);
      assertSingleLine("text", criterion.id, criterion.text);
      const mark = criterionStatusMark(criterion.status);
      const head = `- [${mark}] ${criterion.id}: ${criterion.text}`;
      if (criterion.verification === undefined || criterion.verification.length === 0) {
        return head;
      }
      assertSingleLine("verification", criterion.id, criterion.verification);
      const kindTag = criterion.evidenceKind ? ` (${criterion.evidenceKind})` : "";
      return `${head}\n  Evidence${kindTag}: ${criterion.verification}`;
    })
    .join("\n");
}

const LOG_LINE = /^- (\S+)\s+\[(observe|think|plan|build|execute|verify|learn|complete|abandoned)\]\s+(.+)$/;

function parseLogEntries(isa: VerificationStateArtifact, sectionName: string): AlgorithmLogEntry[] {
  const section = getSection(isa, sectionName);
  if (section === null) return [];
  return section.content
    .split("\n")
    .map((line) => parseLogEntryLine(line.trim()))
    .filter((entry): entry is AlgorithmLogEntry => entry !== null);
}

function parseLogEntryLine(line: string): AlgorithmLogEntry | null {
  const match = LOG_LINE.exec(line);
  if (match === null) return null;
  const [, timestamp, phase, text] = match;
  return {
    timestamp: timestamp,
    phase: phase as AlgorithmPhase,
    text: text.trim(),
  };
}

export function renderLogEntries(entries: readonly AlgorithmLogEntry[]): string {
  if (entries.length === 0) return "";
  return entries
    .map((entry) => {
      assertSingleLine("timestamp", entry.timestamp, entry.timestamp);
      assertSingleLine("phase", entry.phase, entry.phase);
      assertSingleLine("text", entry.timestamp, entry.text);
      return `- ${entry.timestamp} [${entry.phase}] ${entry.text}`;
    })
    .join("\n");
}

export interface BuildVsaInput {
  slug: string;
  task: string;
  goal: string;
  criteria: Checkpoint[];
  effort: AlgorithmEffortTier;
  mode?: AlgorithmMode;
  phase?: AlgorithmPhase;
  timestamp: string;
}

/**
 * Single source of truth for constructing a fresh VerificationStateArtifact from
 * primitive inputs. Used by both `createAlgorithmRun` (new runs) and the
 * legacy v1 → v2 compat shim in `algorithm-store`. Keeps section + frontmatter
 * shape consistent across both paths.
 */
export function buildVsaArtifact(input: BuildVsaInput): VerificationStateArtifact {
  const sections: VsaSection[] = [
    { name: SECTION_NAME_MAP.goal, content: input.goal },
    { name: SECTION_NAME_MAP.criteria, content: renderCriteriaMarkdown(input.criteria) },
  ];
  const draft: VerificationStateArtifact = {
    slug: input.slug,
    frontmatter: {
      task: input.task,
      effort: input.effort,
      mode: input.mode,
      phase: input.phase ?? "observe",
      progress: `0/${input.criteria.length}`,
      verified: false,
      updated: input.timestamp,
      started: input.timestamp,
    },
    sections,
  };
  return {
    ...draft,
    frontmatter: {
      ...draft.frontmatter,
      progress: recomputeProgress(draft),
      verified: recomputeVerified(draft),
    },
  };
}

export function recomputeProgress(isa: VerificationStateArtifact): string {
  return progressFromCriteria(getCriteria(isa));
}

export function recomputeVerified(isa: VerificationStateArtifact): boolean {
  return verifiedFromCriteria(getCriteria(isa));
}

export function progressFromCriteria(criteria: readonly Checkpoint[]): string {
  if (criteria.length === 0) return "0/0";
  const completed = criteria.filter((c) => c.status === "passed" || c.status === "dropped").length;
  return `${completed}/${criteria.length}`;
}

export function verifiedFromCriteria(criteria: readonly Checkpoint[]): boolean {
  if (criteria.length === 0) return false;
  return criteria.every((c) => c.status === "passed" || c.status === "dropped");
}
