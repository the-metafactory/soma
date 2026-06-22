import type {
  AlgorithmEffortTier,
  AlgorithmLogEntry,
  AlgorithmMode,
  AlgorithmPhase,
  CriterionStatus,
  EvidenceKind,
  IdealStateArtifact,
  IdealStateCriterion,
  IsaSection,
} from "./types";

/**
 * Canonical section names for the twelve-section ISA schema.
 * The unified `IdealStateArtifact` type itself is section-agnostic; lifecycle
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
  criteria: "Criteria",
  testStrategy: "Test Strategy",
  features: "Features",
  decisions: "Decisions",
  changelog: "Changelog",
  verification: "Verification",
} as const;

export const TWELVE_SECTIONS = Object.values(SECTION_NAME_MAP);

export function getSection(isa: IdealStateArtifact, name: string): IsaSection | null {
  return isa.sections.find((section) => section.name === name) ?? null;
}

export function getGoal(isa: IdealStateArtifact): string | null {
  const section = getSection(isa, SECTION_NAME_MAP.goal);
  if (section === null) return null;
  const trimmed = section.content.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function getCriteria(isa: IdealStateArtifact): IdealStateCriterion[] {
  const section = getSection(isa, SECTION_NAME_MAP.criteria);
  if (section === null) return [];
  return parseCriteriaMarkdown(section.content);
}

export function getDecisions(isa: IdealStateArtifact): AlgorithmLogEntry[] {
  return parseLogEntries(isa, SECTION_NAME_MAP.decisions);
}

export function getChangelog(isa: IdealStateArtifact): AlgorithmLogEntry[] {
  return parseLogEntries(isa, SECTION_NAME_MAP.changelog);
}

export function getVerification(isa: IdealStateArtifact): AlgorithmLogEntry[] {
  return parseLogEntries(isa, SECTION_NAME_MAP.verification);
}

export function setSection(isa: IdealStateArtifact, name: string, content: string): IdealStateArtifact {
  const existingIndex = isa.sections.findIndex((section) => section.name === name);
  const next: IsaSection = { name, content };

  if (existingIndex >= 0) {
    const sections = isa.sections.slice();
    sections[existingIndex] = next;
    return { ...isa, sections };
  }

  const insertIndex = canonicalInsertIndex(isa.sections, name);
  const sections = isa.sections.slice();
  sections.splice(insertIndex, 0, next);
  return { ...isa, sections };
}

export function setCriteria(isa: IdealStateArtifact, criteria: readonly IdealStateCriterion[]): IdealStateArtifact {
  return setSection(isa, SECTION_NAME_MAP.criteria, renderCriteriaMarkdown(criteria));
}

export interface UpdateCriterionResult {
  isa: IdealStateArtifact;
  criteria: IdealStateCriterion[];
}

export function updateCriterionWithResult(
  isa: IdealStateArtifact,
  criterionId: string,
  status: IdealStateCriterion["status"],
  verification?: string,
  evidenceKind?: IdealStateCriterion["evidenceKind"],
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
  criterion: IdealStateCriterion,
): criterion is IdealStateCriterion & { status: "passed" | "dropped" | "deferred-probe" } {
  return (
    criterion.status === "passed" || criterion.status === "dropped" || criterion.status === "deferred-probe"
  );
}

/**
 * A `passed` criterion whose evidence is a specification/design claim only.
 * It is self-attested, not a real probe, so it must not clear the LEARN gate.
 */
export function isHollowPass(criterion: IdealStateCriterion): boolean {
  return criterion.status === "passed" && criterion.evidenceKind === "specified";
}

/**
 * The criteria that block entry to LEARN, split by reason. Single source of truth
 * for the gate rule — both the assertGate guard and sync's reachability check call
 * this so the two cannot drift when a future evidence rule is added.
 */
export function learnGateViolations(criteria: readonly IdealStateCriterion[]): {
  unresolved: IdealStateCriterion[];
  hollow: IdealStateCriterion[];
} {
  return {
    unresolved: criteria.filter((criterion) => !isClosedCriterion(criterion)),
    hollow: criteria.filter(isHollowPass),
  };
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

export function updateCriterion(
  isa: IdealStateArtifact,
  criterionId: string,
  status: IdealStateCriterion["status"],
  verification?: string,
): IdealStateArtifact {
  return updateCriterionWithResult(isa, criterionId, status, verification).isa;
}

export function appendCriterion(isa: IdealStateArtifact, criterion: IdealStateCriterion): IdealStateArtifact {
  const criteria = getCriteria(isa);
  if (criteria.some((existing) => existing.id === criterion.id)) {
    throw new Error(`Algorithm criterion already exists: ${criterion.id}`);
  }
  return setSection(isa, SECTION_NAME_MAP.criteria, renderCriteriaMarkdown([...criteria, criterion]));
}

export function appendIsaDecision(isa: IdealStateArtifact, entry: AlgorithmLogEntry): IdealStateArtifact {
  return appendLogEntry(isa, SECTION_NAME_MAP.decisions, entry);
}

export function appendIsaChangelog(isa: IdealStateArtifact, entry: AlgorithmLogEntry): IdealStateArtifact {
  return appendLogEntry(isa, SECTION_NAME_MAP.changelog, entry);
}

export function appendIsaVerification(isa: IdealStateArtifact, entry: AlgorithmLogEntry): IdealStateArtifact {
  return appendLogEntry(isa, SECTION_NAME_MAP.verification, entry);
}

function appendLogEntry(isa: IdealStateArtifact, sectionName: string, entry: AlgorithmLogEntry): IdealStateArtifact {
  const existing = parseLogEntries(isa, sectionName);
  return setSection(isa, sectionName, renderLogEntries([...existing, entry]));
}

function canonicalInsertIndex(sections: readonly IsaSection[], name: string): number {
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

export function parseCriteriaMarkdown(content: string): IdealStateCriterion[] {
  const out: IdealStateCriterion[] = [];
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

function parseCriterionLine(line: string): IdealStateCriterion | null {
  const match = CRITERION_LINE.exec(line);
  if (match === null) return null;
  const [, mark, idRaw, textRaw] = match;
  return {
    id: idRaw.trim(),
    text: textRaw.trim(),
    status: criterionStatusFromMark(mark),
  };
}

function criterionStatusFromMark(mark: string): IdealStateCriterion["status"] {
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

function criterionStatusMark(status: IdealStateCriterion["status"]): string {
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

export function renderCriteriaMarkdown(criteria: readonly IdealStateCriterion[]): string {
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

function parseLogEntries(isa: IdealStateArtifact, sectionName: string): AlgorithmLogEntry[] {
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

export interface BuildIsaInput {
  slug: string;
  task: string;
  goal: string;
  criteria: IdealStateCriterion[];
  effort: AlgorithmEffortTier;
  mode?: AlgorithmMode;
  phase?: AlgorithmPhase;
  timestamp: string;
}

/**
 * Single source of truth for constructing a fresh IdealStateArtifact from
 * primitive inputs. Used by both `createAlgorithmRun` (new runs) and the
 * legacy v1 → v2 compat shim in `algorithm-store`. Keeps section + frontmatter
 * shape consistent across both paths.
 */
export function buildIsaArtifact(input: BuildIsaInput): IdealStateArtifact {
  const sections: IsaSection[] = [
    { name: SECTION_NAME_MAP.goal, content: input.goal },
    { name: SECTION_NAME_MAP.criteria, content: renderCriteriaMarkdown(input.criteria) },
  ];
  const draft: IdealStateArtifact = {
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

export function recomputeProgress(isa: IdealStateArtifact): string {
  return progressFromCriteria(getCriteria(isa));
}

export function recomputeVerified(isa: IdealStateArtifact): boolean {
  return verifiedFromCriteria(getCriteria(isa));
}

export function progressFromCriteria(criteria: readonly IdealStateCriterion[]): string {
  if (criteria.length === 0) return "0/0";
  const completed = criteria.filter((c) => c.status === "passed" || c.status === "dropped").length;
  return `${completed}/${criteria.length}`;
}

export function verifiedFromCriteria(criteria: readonly IdealStateCriterion[]): boolean {
  if (criteria.length === 0) return false;
  return criteria.every((c) => c.status === "passed" || c.status === "dropped");
}
