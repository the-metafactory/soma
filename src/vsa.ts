import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SECTION_NAME_MAP,
  appendVsaChangelog as appendVsaChangelogAccessor,
  appendVsaDecision as appendVsaDecisionAccessor,
  appendVsaVerification as appendVsaVerificationAccessor,
  getCriteria,
  getGoal,
  recomputeProgress,
  recomputeVerified,
  renderCriteriaMarkdown,
} from "./vsa-accessors";
import { parseVsa, serializeVsa } from "./vsa-parse";
import { appendSomaMemoryEvent } from "./memory";
import { TIER_REQUIRED_SECTIONS, evaluateCompleteness, type CompletenessReport } from "./vsa-schema";
import type {
  AlgorithmEffortTier,
  AlgorithmPhase,
  VerificationStateArtifact,
  Checkpoint,
  SomaActiveVsaState,
  SubstrateId,
} from "./types";

export type EffortTier = AlgorithmEffortTier;

const VALID_EFFORT_TIERS: readonly EffortTier[] = ["E1", "E2", "E3", "E4", "E5"];

const VALID_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

const ACTIVE_STATE_FILENAME = "active.json";

export interface VsaLibraryOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
}

export interface VsaListEntry {
  slug: string;
  phase: AlgorithmPhase;
  progress: string;
  updated: string;
}

export interface ScaffoldVsaInput extends VsaLibraryOptions {
  slug: string;
  goal: string;
  effort: EffortTier;
  task?: string;
  timestamp?: string;
  initialCriteria?: Checkpoint[];
}

export interface WriteVsaResult {
  path: string;
  changed: boolean;
}

export interface SetActiveVsaResult {
  previousSlug: string | null;
  state: SomaActiveVsaState;
}

export function resolveSomaHome(options: VsaLibraryOptions = {}): string {
  return resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
}

export function vsaDir(somaHome: string): string {
  const canonical = join(somaHome, "vsa");
  if (existsSync(canonical)) return canonical;
  // soma#329 slice 3: homes created before the ISA→VSA rename stored VSAs under
  // `isa/`. Dual-read the legacy dir when the canonical `vsa/` does not exist
  // yet; the upgrade migration (migrateVsaStorageDir) renames isa/ → vsa/ so new
  // writes land canonically. Default to `vsa/` for fresh homes.
  const legacy = join(somaHome, "isa");
  if (existsSync(legacy)) return legacy;
  return canonical;
}

export function vsaPath(somaHome: string, slug: string): string {
  assertValidSlug(slug);
  return join(vsaDir(somaHome), `${slug}.md`);
}

export function activeStatePath(somaHome: string): string {
  return join(somaHome, "memory", "STATE", ACTIVE_STATE_FILENAME);
}

function assertValidSlug(slug: string): void {
  if (!VALID_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid VSA slug: '${slug}'. Must match ${VALID_SLUG_PATTERN.source}.`);
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

export async function readVsa(slug: string, options: VsaLibraryOptions = {}): Promise<VerificationStateArtifact> {
  const somaHome = resolveSomaHome(options);
  const path = vsaPath(somaHome, slug);
  const raw = await readFile(path, "utf8");
  return parseVsa(raw, path);
}

export async function writeVsa(
  slug: string,
  isa: VerificationStateArtifact,
  options: VsaLibraryOptions = {},
): Promise<WriteVsaResult> {
  assertValidSlug(slug);
  const somaHome = resolveSomaHome(options);
  const path = vsaPath(somaHome, slug);
  const next = serializeVsa(isa);
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
  await emitEvent(somaHome, options, "isa.write", `Wrote VSA ${slug}`, { slug, path });
  return { path, changed: true };
}

export async function listVsas(options: VsaLibraryOptions = {}): Promise<VsaListEntry[]> {
  const somaHome = resolveSomaHome(options);
  const dir = vsaDir(somaHome);
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
  // Parallelize reads — listVsas was serializing per-file I/O. Bounded
  // by candidate count; VSA libraries are small (≤ low hundreds) so a
  // full Promise.all here is safe.
  const parsed = await Promise.all(
    candidates.map(async ({ slug, path }) => {
      try {
        const raw = await readFile(path, "utf8");
        const isa = parseVsa(raw, path);
        return {
          slug,
          phase: isa.frontmatter.phase,
          progress: isa.frontmatter.progress,
          updated: isa.frontmatter.updated,
        } satisfies VsaListEntry;
      } catch (error: unknown) {
        // Sage round 2: don't silently hide invalid VSA files. Rethrow
        // with slug/path context so callers see the real library error
        // rather than an incomplete-but-successful list.
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`listVsas: failed to read or parse '${slug}' at ${path}: ${message}`, { cause: error });
      }
    }),
  );
  return parsed.sort((a, b) => b.updated.localeCompare(a.updated));
}

export async function scaffoldVsa(input: ScaffoldVsaInput): Promise<{ path: string; isa: VerificationStateArtifact }> {
  assertValidSlug(input.slug);
  assertValidEffort(input.effort);
  if (input.goal.trim().length === 0) {
    throw new Error("scaffoldVsa requires a non-empty goal.");
  }
  const somaHome = resolveSomaHome(input);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const criteria = input.initialCriteria ?? [];
  const sections = buildScaffoldSections(input.effort, input.goal, criteria);
  const draft: VerificationStateArtifact = {
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
  const isa: VerificationStateArtifact = {
    ...draft,
    frontmatter: {
      ...draft.frontmatter,
      progress: recomputeProgress(draft),
      verified: recomputeVerified(draft),
    },
  };
  const path = vsaPath(somaHome, input.slug);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeVsa(isa), "utf8");
  await emitEvent(somaHome, input, "isa.scaffold", `Scaffolded VSA ${input.slug} at ${input.effort}`, {
    slug: input.slug,
    effort: input.effort,
    path,
  });
  return { path, isa };
}

function buildScaffoldSections(
  effort: EffortTier,
  goal: string,
  initialCriteria: readonly Checkpoint[],
): { name: string; content: string }[] {
  // Required sections per tier are pre-filled with `TODO_PLACEHOLDER` so
  // a freshly-scaffolded VSA passes `checkCompleteness` at its own tier
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
// vsa-schema) define WHICH sections must exist; this list defines
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

export async function checkCompleteness(slug: string, options: VsaLibraryOptions = {}): Promise<CompletenessReport> {
  const isa = await readVsa(slug, options);
  return evaluateCompleteness(isa, isa.frontmatter.effort);
}

export async function getActiveVsa(options: VsaLibraryOptions = {}): Promise<SomaActiveVsaState | null> {
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
    // calling `setActiveVsa(null, ...)` to reset.
    return null;
  }
  return isActiveVsaState(parsed) ? parsed : null;
}

function isActiveVsaState(value: unknown): value is SomaActiveVsaState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SomaActiveVsaState>;
  const slugOk = candidate.activeSlug === null || typeof candidate.activeSlug === "string";
  const runOk = candidate.runId === null || typeof candidate.runId === "string";
  const updatedOk = typeof candidate.updatedAt === "string";
  return slugOk && runOk && updatedOk;
}

export async function setActiveVsa(
  slug: string | null,
  options: VsaLibraryOptions & { runId?: string | null; timestamp?: string } = {},
): Promise<SetActiveVsaResult> {
  if (slug !== null) assertValidSlug(slug);
  const somaHome = resolveSomaHome(options);
  const path = activeStatePath(somaHome);
  const previous = await getActiveVsa({ homeDir: options.homeDir, somaHome: options.somaHome });
  const next: SomaActiveVsaState = {
    activeSlug: slug,
    runId: options.runId ?? null,
    updatedAt: options.timestamp ?? new Date().toISOString(),
  };
  await writeActiveStateAtomic(path, next);
  await emitEvent(
    somaHome,
    options,
    "isa.active_changed",
    slug ? `Active VSA set to ${slug}` : "Active VSA cleared",
    { slug, runId: next.runId },
  );
  return { previousSlug: previous?.activeSlug ?? null, state: next };
}

async function writeActiveStateAtomic(path: string, state: SomaActiveVsaState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // randomUUID guarantees temp path uniqueness across concurrent calls in
  // the same process and same millisecond — Sage round-3 suggestion.
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

/**
 * File-backed companion to the pure `appendVsaDecision` accessor (#41).
 * Reads slug → appends entry → writes back. Used by Algorithm integration
 * (#39); kept here so #34 ships a complete I/O surface for callers that
 * don't want to manage parse/serialize themselves.
 */
export async function recordVsaDecision(
  slug: string,
  text: string,
  options: VsaLibraryOptions & { timestamp?: string; phase?: AlgorithmPhase } = {},
): Promise<WriteVsaResult> {
  return recordVsaSection(slug, text, "decisions", options);
}

export type VsaUpdateSection = "decisions" | "changelog" | "verification";

export interface VsaUpdateEntry {
  section: VsaUpdateSection;
  text: string;
  phase?: AlgorithmPhase;
  timestamp?: string;
}

const SECTION_ACCESSOR: Record<VsaUpdateSection, typeof appendVsaDecisionAccessor> = {
  decisions: appendVsaDecisionAccessor,
  changelog: appendVsaChangelogAccessor,
  verification: appendVsaVerificationAccessor,
};

/**
 * Trusted Soma-side VSA writer (#38 Sage round 1 architecture fix).
 *
 * Single read → validate all entries → apply atomically in memory →
 * single write. Replaces serial recordVsa*(slug, text) calls from
 * lifecycle so a multi-entry payload is now ONE file write instead of
 * three, and a malformed later entry can't leave earlier writes
 * committed.
 *
 * Caller emits the writeback event to events.jsonl BEFORE calling
 * this so the writeback gate has the full payload logged before the
 * authoritative VSA mutation runs.
 */
export async function applyVsaUpdate(
  slug: string,
  entries: readonly VsaUpdateEntry[],
  options: VsaLibraryOptions & { timestamp?: string } = {},
): Promise<WriteVsaResult> {
  for (const entry of entries) {
    if (entry.text.trim().length === 0) {
      throw new Error(`applyVsaUpdate refused empty text in ${entry.section} entry.`);
    }
  }
  if (entries.length === 0) {
    return { path: "", changed: false };
  }
  const fallbackTimestamp = options.timestamp ?? new Date().toISOString();
  let isa = await readVsa(slug, options);
  const vsaPhase = isa.frontmatter.phase;
  for (const entry of entries) {
    const accessor = SECTION_ACCESSOR[entry.section];
    isa = accessor(isa, {
      timestamp: entry.timestamp ?? fallbackTimestamp,
      phase: entry.phase ?? vsaPhase,
      text: entry.text,
    });
  }
  isa = { ...isa, frontmatter: { ...isa.frontmatter, updated: fallbackTimestamp } };
  return writeVsa(slug, isa, options);
}

/**
 * Internal shared helper for the section-specific record* wrappers
 * (Sage round-2 dedup). All three exported wrappers go through this
 * single path so validation + timestamp handling + persistence stay
 * consistent. New section writers just extend SECTION_ACCESSOR and
 * the wrapper they expose.
 */
async function recordVsaSection(
  slug: string,
  text: string,
  section: VsaUpdateSection,
  options: VsaLibraryOptions & { timestamp?: string; phase?: AlgorithmPhase } = {},
): Promise<WriteVsaResult> {
  if (text.trim().length === 0) {
    throw new Error(`record-vsa-${section}: requires non-empty text.`);
  }
  const isa = await readVsa(slug, options);
  const phase = options.phase ?? isa.frontmatter.phase;
  const timestamp = options.timestamp ?? new Date().toISOString();
  const accessor = SECTION_ACCESSOR[section];
  const updated = accessor(isa, { timestamp, phase, text });
  return writeVsa(slug, { ...updated, frontmatter: { ...updated.frontmatter, updated: timestamp } }, options);
}

/**
 * File-backed companion to the pure `appendVsaChangelog` accessor.
 * Mirror of `recordVsaDecision` for the Changelog section.
 */
export async function recordVsaChangelog(
  slug: string,
  text: string,
  options: VsaLibraryOptions & { timestamp?: string; phase?: AlgorithmPhase } = {},
): Promise<WriteVsaResult> {
  return recordVsaSection(slug, text, "changelog", options);
}

/**
 * File-backed companion to the pure `appendVsaVerification` accessor.
 * Mirror of `recordVsaDecision` for the Verification section.
 */
export async function recordVsaVerification(
  slug: string,
  text: string,
  options: VsaLibraryOptions & { timestamp?: string; phase?: AlgorithmPhase } = {},
): Promise<WriteVsaResult> {
  return recordVsaSection(slug, text, "verification", options);
}

// Re-export schema surface for downstream consumers (CLI #36, lifecycle #38).
export { evaluateCompleteness, TIER_REQUIRED_SECTIONS, type CompletenessReport, type CompletenessGap } from "./vsa-schema";

// Re-export the criteria/goal accessors so callers don't need to import
// from two places for the common cases.
export { getCriteria, getGoal };

async function emitEvent(
  somaHome: string,
  options: VsaLibraryOptions,
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
