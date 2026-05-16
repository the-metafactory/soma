import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SECTION_NAME_MAP,
  appendIsaDecision as appendIsaDecisionAccessor,
  getCriteria,
  getGoal,
  recomputeProgress,
  recomputeVerified,
  renderCriteriaMarkdown,
} from "./isa-accessors";
import { parseIsa, serializeIsa } from "./isa-parse";
import { appendSomaMemoryEvent } from "./memory";
import { TIER_REQUIRED_SECTIONS, evaluateCompleteness, type CompletenessReport } from "./isa-schema";
import type {
  AlgorithmEffortTier,
  AlgorithmPhase,
  IdealStateArtifact,
  IdealStateCriterion,
  SomaActiveIsaState,
  SubstrateId,
} from "./types";

export type EffortTier = AlgorithmEffortTier;

const VALID_EFFORT_TIERS: readonly EffortTier[] = ["E1", "E2", "E3", "E4", "E5"];

const VALID_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const ACTIVE_STATE_FILENAME = "active.json";

export interface IsaLibraryOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
}

export interface IsaListEntry {
  slug: string;
  phase: AlgorithmPhase;
  progress: string;
  updated: string;
}

export interface ScaffoldIsaInput extends IsaLibraryOptions {
  slug: string;
  goal: string;
  effort: EffortTier;
  task?: string;
  timestamp?: string;
  initialCriteria?: IdealStateCriterion[];
}

export interface WriteIsaResult {
  path: string;
  changed: boolean;
}

export interface SetActiveIsaResult {
  previousSlug: string | null;
  state: SomaActiveIsaState;
}

export function resolveSomaHome(options: IsaLibraryOptions = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

export function isaDir(somaHome: string): string {
  return join(somaHome, "isa");
}

export function isaPath(somaHome: string, slug: string): string {
  assertValidSlug(slug);
  return join(isaDir(somaHome), `${slug}.md`);
}

export function activeStatePath(somaHome: string): string {
  return join(somaHome, "memory", "STATE", ACTIVE_STATE_FILENAME);
}

function assertValidSlug(slug: string): void {
  if (!VALID_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid ISA slug: '${slug}'. Must match ${VALID_SLUG_PATTERN.source}.`);
  }
}

function assertValidEffort(effort: EffortTier): void {
  if (!VALID_EFFORT_TIERS.includes(effort)) {
    throw new Error(`Invalid effort tier: '${effort}'. Must be one of ${VALID_EFFORT_TIERS.join(", ")}.`);
  }
}

export function listAvailableTiers(): readonly EffortTier[] {
  return VALID_EFFORT_TIERS;
}

export async function readIsa(slug: string, options: IsaLibraryOptions = {}): Promise<IdealStateArtifact> {
  const somaHome = resolveSomaHome(options);
  const path = isaPath(somaHome, slug);
  const raw = await readFile(path, "utf8");
  return parseIsa(raw, path);
}

export async function writeIsa(
  slug: string,
  isa: IdealStateArtifact,
  options: IsaLibraryOptions = {},
): Promise<WriteIsaResult> {
  assertValidSlug(slug);
  const somaHome = resolveSomaHome(options);
  const path = isaPath(somaHome, slug);
  const next = serializeIsa(isa);
  let changed = true;
  try {
    const existing = await readFile(path, "utf8");
    changed = existing !== next;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (!changed) {
    return { path, changed: false };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  await emitEvent(somaHome, options, "isa.write", `Wrote ISA ${slug}`, { slug, path });
  return { path, changed: true };
}

export async function listIsas(options: IsaLibraryOptions = {}): Promise<IsaListEntry[]> {
  const somaHome = resolveSomaHome(options);
  const dir = isaDir(somaHome);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    // Only ENOENT (no isa dir yet) is a quiet empty list. Permission errors,
    // ENOTDIR, etc. are real failures and must surface to the caller.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md")
    .map((entry) => ({ slug: entry.name.slice(0, -3), path: join(dir, entry.name) }))
    .filter((entry) => VALID_SLUG_PATTERN.test(entry.slug));
  // Parallelize reads — listIsas was serializing per-file I/O. Bounded
  // by candidate count; ISA libraries are small (≤ low hundreds) so a
  // full Promise.all here is safe.
  const parsed = await Promise.all(
    candidates.map(async ({ slug, path }) => {
      try {
        const raw = await readFile(path, "utf8");
        const isa = parseIsa(raw, path);
        return {
          slug,
          phase: isa.frontmatter.phase,
          progress: isa.frontmatter.progress,
          updated: isa.frontmatter.updated,
        } satisfies IsaListEntry;
      } catch (error: unknown) {
        // Sage round 2: don't silently hide invalid ISA files. Rethrow
        // with slug/path context so callers see the real library error
        // rather than an incomplete-but-successful list.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`listIsas: failed to read or parse '${slug}' at ${path}: ${message}`, { cause: error });
      }
    }),
  );
  return parsed.sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function scaffoldIsa(input: ScaffoldIsaInput): Promise<{ path: string; isa: IdealStateArtifact }> {
  assertValidSlug(input.slug);
  assertValidEffort(input.effort);
  if (input.goal.trim().length === 0) {
    throw new Error("scaffoldIsa requires a non-empty goal.");
  }
  const somaHome = resolveSomaHome(input);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const criteria = input.initialCriteria ?? [];
  const sections = buildScaffoldSections(input.effort, input.goal, criteria);
  const draft: IdealStateArtifact = {
    slug: input.slug,
    frontmatter: {
      task: input.task ?? input.goal,
      effort: input.effort,
      phase: "observe",
      progress: `0/${criteria.length}`,
      verified: false,
      updated: timestamp,
      started: timestamp,
    },
    sections,
  };
  const isa: IdealStateArtifact = {
    ...draft,
    frontmatter: {
      ...draft.frontmatter,
      progress: recomputeProgress(draft),
      verified: recomputeVerified(draft),
    },
  };
  const path = isaPath(somaHome, input.slug);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeIsa(isa), "utf8");
  await emitEvent(somaHome, input, "isa.scaffold", `Scaffolded ISA ${input.slug} at ${input.effort}`, {
    slug: input.slug,
    effort: input.effort,
    path,
  });
  return { path, isa };
}

function buildScaffoldSections(
  effort: EffortTier,
  goal: string,
  initialCriteria: readonly IdealStateCriterion[],
): { name: string; content: string }[] {
  // Required sections per tier are pre-filled with `TODO_PLACEHOLDER` so
  // a freshly-scaffolded ISA passes `checkCompleteness` at its own tier
  // (AC-3). The user fills these in via Interview workflow or direct
  // editing; the placeholder is intentionally distinct so search tools
  // can find unfilled sections.
  const criteriaContent = renderCriteriaMarkdown(initialCriteria) || TODO_PLACEHOLDER;
  const out: { name: string; content: string }[] = [];
  const required = TIER_REQUIRED_SECTIONS[effort];
  for (const name of required) {
    if (name === SECTION_NAME_MAP.goal) {
      out.push({ name, content: goal });
    } else if (name === SECTION_NAME_MAP.criteria) {
      out.push({ name, content: criteriaContent });
    } else {
      out.push({ name, content: TODO_PLACEHOLDER });
    }
  }
  // E4/E5 include the full twelve sections; ensure any optional sections
  // beyond the required set also exist so authoring is symmetric.
  if (effort === "E4" || effort === "E5") {
    const seen = new Set(out.map((s) => s.name));
    for (const name of TWELVE_SECTIONS_ORDER) {
      if (!seen.has(name)) out.push({ name, content: TODO_PLACEHOLDER });
    }
    return reorderToCanonical(out);
  }
  return reorderToCanonical(out);
}

const TODO_PLACEHOLDER = "_TODO: scaffolded — fill in via Interview workflow or direct edit._";

// Canonical output order — single source of truth for "what order do
// sections appear on disk?". Tier gates (TIER_REQUIRED_SECTIONS from
// isa-schema) define WHICH sections must exist; this list defines
// THE ORDER. Distinct concerns, single owners — Sage round-1 dedup.
const TWELVE_SECTIONS_ORDER: readonly string[] = [
  SECTION_NAME_MAP.problem,
  SECTION_NAME_MAP.vision,
  SECTION_NAME_MAP.outOfScope,
  SECTION_NAME_MAP.principles,
  SECTION_NAME_MAP.constraints,
  SECTION_NAME_MAP.goal,
  SECTION_NAME_MAP.criteria,
  SECTION_NAME_MAP.testStrategy,
  SECTION_NAME_MAP.features,
  SECTION_NAME_MAP.decisions,
  SECTION_NAME_MAP.changelog,
  SECTION_NAME_MAP.verification,
];

function reorderToCanonical(sections: { name: string; content: string }[]): { name: string; content: string }[] {
  return [...sections].sort((a, b) => {
    const ai = TWELVE_SECTIONS_ORDER.indexOf(a.name);
    const bi = TWELVE_SECTIONS_ORDER.indexOf(b.name);
    return (ai < 0 ? TWELVE_SECTIONS_ORDER.length : ai) - (bi < 0 ? TWELVE_SECTIONS_ORDER.length : bi);
  });
}

export async function checkCompleteness(slug: string, options: IsaLibraryOptions = {}): Promise<CompletenessReport> {
  const isa = await readIsa(slug, options);
  return evaluateCompleteness(isa, isa.frontmatter.effort);
}

export async function getActiveIsa(options: IsaLibraryOptions = {}): Promise<SomaActiveIsaState | null> {
  const somaHome = resolveSomaHome(options);
  const path = activeStatePath(somaHome);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON — treat as no active state. Callers can recover by
    // calling `setActiveIsa(null, ...)` to reset.
    return null;
  }
  return isActiveIsaState(parsed) ? parsed : null;
}

function isActiveIsaState(value: unknown): value is SomaActiveIsaState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SomaActiveIsaState>;
  const slugOk = candidate.activeSlug === null || typeof candidate.activeSlug === "string";
  const runOk = candidate.runId === null || typeof candidate.runId === "string";
  const updatedOk = typeof candidate.updatedAt === "string";
  return slugOk && runOk && updatedOk;
}

export async function setActiveIsa(
  slug: string | null,
  options: IsaLibraryOptions & { runId?: string | null; timestamp?: string } = {},
): Promise<SetActiveIsaResult> {
  if (slug !== null) assertValidSlug(slug);
  const somaHome = resolveSomaHome(options);
  const path = activeStatePath(somaHome);
  const previous = await getActiveIsa({ homeDir: options.homeDir, somaHome: options.somaHome });
  const next: SomaActiveIsaState = {
    activeSlug: slug,
    runId: options.runId ?? null,
    updatedAt: options.timestamp ?? new Date().toISOString(),
  };
  await writeActiveStateAtomic(path, next);
  await emitEvent(
    somaHome,
    options,
    "isa.active_changed",
    slug ? `Active ISA set to ${slug}` : "Active ISA cleared",
    { slug, runId: next.runId },
  );
  return { previousSlug: previous?.activeSlug ?? null, state: next };
}

async function writeActiveStateAtomic(path: string, state: SomaActiveIsaState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // randomUUID guarantees temp path uniqueness across concurrent calls in
  // the same process and same millisecond — Sage round-3 suggestion.
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

/**
 * File-backed companion to the pure `appendIsaDecision` accessor (#41).
 * Reads slug → appends entry → writes back. Used by Algorithm integration
 * (#39); kept here so #34 ships a complete I/O surface for callers that
 * don't want to manage parse/serialize themselves.
 */
export async function recordIsaDecision(
  slug: string,
  text: string,
  options: IsaLibraryOptions & { timestamp?: string; phase?: AlgorithmPhase } = {},
): Promise<WriteIsaResult> {
  if (text.trim().length === 0) {
    throw new Error("recordIsaDecision requires non-empty text.");
  }
  const isa = await readIsa(slug, options);
  const phase = options.phase ?? isa.frontmatter.phase;
  const timestamp = options.timestamp ?? new Date().toISOString();
  const updated = appendIsaDecisionAccessor(isa, { timestamp, phase, text });
  return writeIsa(slug, { ...updated, frontmatter: { ...updated.frontmatter, updated: timestamp } }, options);
}

// Re-export schema surface for downstream consumers (CLI #36, lifecycle #38).
export { evaluateCompleteness, TIER_REQUIRED_SECTIONS, type CompletenessReport, type CompletenessGap } from "./isa-schema";

// Re-export the criteria/goal accessors so callers don't need to import
// from two places for the common cases.
export { getCriteria, getGoal };

async function emitEvent(
  somaHome: string,
  options: IsaLibraryOptions,
  kind: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await appendSomaMemoryEvent(somaHome, {
    substrate: options.substrate ?? "custom",
    kind,
    summary,
    metadata,
  });
}
