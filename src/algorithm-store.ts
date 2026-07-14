import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  AlgorithmEffortSource,
  AlgorithmEffortTier,
  AlgorithmMode,
  AlgorithmPhase,
  AlgorithmRun,
  AlgorithmRunSummary,
  VerificationStateArtifact,
  Checkpoint,
} from "./types";
import { buildVsaArtifact, getCriteria, getGoal } from "./vsa-accessors";
import { getRunPhase } from "./algorithm-lifecycle";
import { DEFAULT_ALGORITHM_LOOP_STATE } from "./algorithm-execution-modes";

export interface AlgorithmStoreOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface WrittenAlgorithmRun {
  path: string;
  run: AlgorithmRun;
}

export function resolveAlgorithmRunsDir(options: AlgorithmStoreOptions = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  const somaHome = resolve(options.somaHome ?? join(home, ".soma"));

  return join(somaHome, "memory/WORK/algorithm-runs");
}

export function algorithmRunPath(run: Pick<AlgorithmRun, "id">, options: AlgorithmStoreOptions = {}): string {
  return join(resolveAlgorithmRunsDir(options), `${run.id}.json`);
}

export function algorithmRunPathById(id: string, options: AlgorithmStoreOptions = {}): string {
  return join(resolveAlgorithmRunsDir(options), `${id}.json`);
}

function algorithmStoreWriteError(path: string, error: unknown): Error {
  if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
    return new Error(
      [
        `Cannot write Soma Algorithm run at ${path}.`,
        "The current substrate sandbox does not have write access to the Soma home.",
        "In Codex, rerun the Soma command with filesystem approval or configure the Soma home as a writable root; do not fall back to substrate-local scratch state.",
      ].join(" "),
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

export async function writeAlgorithmRun(run: AlgorithmRun, options: AlgorithmStoreOptions = {}): Promise<WrittenAlgorithmRun> {
  const path = algorithmRunPath(run, options);

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  } catch (error) {
    throw algorithmStoreWriteError(path, error);
  }

  return { path, run };
}

export async function readAlgorithmRun(path: string): Promise<AlgorithmRun> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return loadAlgorithmRun(raw);
}

interface LegacyVsa {
  slug: string;
  phase: AlgorithmPhase;
  goal: string;
  criteria: Checkpoint[];
}

// LegacyAlgorithmRun = pre-#41 on-disk shape. Derived from AlgorithmRun so
// field additions propagate; only the diverging fields (`phase` lived at
// the top level, `isa` carried embedded `{ phase, goal, criteria }`,
// `intent` was required) are overridden.
type LegacyAlgorithmRun = Omit<
  Partial<AlgorithmRun>,
  "schemaVersion" | "isa" | "phase" | "intent"
> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  prompt: string;
  intent?: string;
  effort: AlgorithmEffortTier;
  effortSource: AlgorithmEffortSource;
  mode: AlgorithmMode;
  classificationReason: string;
  currentState: string;
  phase?: AlgorithmPhase;
  isa: LegacyVsa;
  loop?: AlgorithmRun["loop"];
  schemaVersion?: 1 | 2;
};

/**
 * Compat shim — accepts every on-disk shape and always returns the current
 * unified schema (v3, embedded VSA under `vsa`):
 *  - v1 (pre-#41): flat, embedded `{ goal, criteria }` under `isa` → migrated.
 *  - v2 (#41): unified `VerificationStateArtifact` under the `isa` key.
 *  - v3 (#329 slice 3): unified VSA under the `vsa` key.
 * v2 and v3 differ only by the embedded key, so we dual-read `vsa ?? isa`,
 * strip the stale `isa` key, and normalize to `vsa` + schemaVersion 3.
 */
export function loadAlgorithmRun(raw: unknown): AlgorithmRun {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("AlgorithmRun JSON is not an object.");
  }
  // Decouple `schemaVersion` from the cast: AlgorithmRun pins it to the literal
  // `3` while LegacyAlgorithmRun allows `1 | 2`, and their intersection would be
  // `never` — which poisons the whole candidate. Widen it to `number` here.
  const candidate = raw as Partial<Omit<AlgorithmRun, "schemaVersion"> & Omit<LegacyAlgorithmRun, "schemaVersion">> & {
    schemaVersion?: number;
  };
  const embedded = candidate.vsa ?? candidate.isa;
  if ((candidate.schemaVersion === 2 || candidate.schemaVersion === 3) && isUnifiedShape(embedded)) {
    const { isa: _legacyIsaKey, ...rest } = candidate;
    void _legacyIsaKey;
    return ensureAlgorithmRunDefaults({ ...rest, schemaVersion: 3, vsa: embedded as VerificationStateArtifact } as AlgorithmRun);
  }
  return ensureAlgorithmRunDefaults(migrateRunV1toV2(candidate as LegacyAlgorithmRun));
}

type AlgorithmRunWithDefaults = Omit<AlgorithmRun, "loop" | "provenance" | "observations" | "metaReflection"> &
  Partial<Pick<AlgorithmRun, "loop" | "provenance" | "observations" | "metaReflection">>;

function ensureAlgorithmRunDefaults(run: AlgorithmRunWithDefaults): AlgorithmRun {
  return {
    ...run,
    loop: run.loop ?? { ...DEFAULT_ALGORITHM_LOOP_STATE, iterations: [] },
    capabilityDefinitions: run.capabilityDefinitions ?? [],
    capabilitySelections: run.capabilitySelections ?? [],
    observations: run.observations ?? [],
    metaReflection: run.metaReflection ?? [],
    provenance: run.provenance ?? [],
  };
}

function isUnifiedShape(embedded: unknown): boolean {
  return (
    typeof embedded === "object" &&
    embedded !== null &&
    "frontmatter" in embedded &&
    "sections" in embedded &&
    Array.isArray((embedded as { sections: unknown }).sections)
  );
}

function migrateRunV1toV2(legacy: LegacyAlgorithmRun): AlgorithmRun {
  const legacyPhase: AlgorithmPhase = legacy.phase ?? legacy.isa.phase;
  const criteria = Array.isArray(legacy.isa.criteria) ? legacy.isa.criteria : [];
  const goal = typeof legacy.isa.goal === "string" ? legacy.isa.goal : "";
  const intent = legacy.intent ?? legacy.id;
  const built = buildVsaArtifact({
    slug: legacy.isa.slug,
    task: intent,
    goal,
    criteria,
    effort: legacy.effort,
    mode: legacy.mode,
    phase: legacyPhase,
    timestamp: legacy.createdAt,
  });
  const vsa: VerificationStateArtifact = {
    ...built,
    frontmatter: { ...built.frontmatter, updated: legacy.updatedAt },
  };

  // Spread legacy first, then override divergent fields. New AlgorithmRun
  // fields with default-safe optionality will propagate automatically. Strip
  // the legacy `isa` embedded key so the v3 result carries only `vsa`.
  const { phase: _legacyPhaseField, isa: _legacyEmbedded, ...legacyFields } = legacy;
  void _legacyPhaseField;
  void _legacyEmbedded;
  return {
    ...legacyFields,
    schemaVersion: 3,
    intent,
    vsa,
    loop: legacy.loop ?? { ...DEFAULT_ALGORITHM_LOOP_STATE, iterations: [] },
    antiCriteria: legacy.antiCriteria ?? [],
    capabilities: legacy.capabilities ?? [],
    capabilityDefinitions: legacy.capabilityDefinitions ?? [],
    capabilitySelections: legacy.capabilitySelections ?? [],
    planSteps: legacy.planSteps ?? [],
    decisions: legacy.decisions ?? [],
    observations: legacy.observations ?? [],
    changelog: legacy.changelog ?? [],
    verification: legacy.verification ?? [],
    learning: legacy.learning ?? [],
    metaReflection: legacy.metaReflection ?? [],
    provenance: legacy.provenance ?? [],
  };
}

export async function readAlgorithmRunById(id: string, options: AlgorithmStoreOptions = {}): Promise<{ path: string; run: AlgorithmRun }> {
  const path = algorithmRunPathById(id, options);
  return {
    path,
    run: await readAlgorithmRun(path),
  };
}

export async function updateAlgorithmRunById(
  id: string,
  options: AlgorithmStoreOptions,
  update: (run: AlgorithmRun) => AlgorithmRun,
): Promise<WrittenAlgorithmRun> {
  const { run } = await readAlgorithmRunById(id, options);
  return writeAlgorithmRun(update(run), options);
}

export function summarizeAlgorithmRun(run: AlgorithmRun, path: string): AlgorithmRunSummary {
  const counts = {
    open: 0,
    passed: 0,
    failed: 0,
    dropped: 0,
    "deferred-probe": 0,
  };

  const criteria = getCriteria(run.vsa);
  for (const criterion of criteria) {
    counts[criterion.status] += 1;
  }

  const total = criteria.length;
  const completed = counts.passed + counts.dropped;

  return {
    id: run.id,
    path,
    updatedAt: run.updatedAt,
    phase: getRunPhase(run),
    effort: run.effort,
    goal: getGoal(run.vsa) ?? "",
    openCriteria: counts.open,
    passedCriteria: counts.passed,
    failedCriteria: counts.failed,
    droppedCriteria: counts.dropped,
    deferredProbeCriteria: counts["deferred-probe"],
    progress: `${completed}/${total}`,
  };
}

/**
 * Shared run-listing plumbing: discover `<id>.json` run files under `runsDir`,
 * optionally keep only those an async `accept(path)` predicate admits, read the
 * survivors, and return them newest-first by updatedAt. Any change to run-file
 * discovery / read / sort semantics lives here once.
 */
async function loadRunsFromDir(
  runsDir: string,
  accept?: (path: string) => Promise<boolean>,
): Promise<{ path: string; run: AlgorithmRun }[]> {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const jsonPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(runsDir, entry.name));
  const kept = accept
    ? (await Promise.all(jsonPaths.map(async (path) => ((await accept(path)) ? path : undefined)))).filter(
        (path): path is string => path !== undefined,
      )
    : jsonPaths;
  const runs = await Promise.all(kept.map(async (path) => ({ path, run: await readAlgorithmRun(path) })));
  return runs.sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
}

export async function listAlgorithmRuns(options: AlgorithmStoreOptions = {}): Promise<{ path: string; run: AlgorithmRun }[]> {
  return loadRunsFromDir(resolveAlgorithmRunsDir(options));
}

/**
 * Like {@link listAlgorithmRuns} but bounded to runs last modified on/after `since`,
 * using file mtime as a cheap recency PREFILTER (a stat, not a read) so hot-path
 * callers (e.g. the SessionStart learning readback) don't pay full-history read
 * I/O. This is a HEURISTIC: it assumes mtime tracks last-write (true for normal
 * append/rewrite paths — false if a file is touched/copied with a preserved or
 * reset mtime). It is designed to over-include rather than drop — the precise
 * per-item timestamp filter downstream is authoritative — but a run whose mtime
 * was pushed older than its content would be skipped, so callers that require a
 * hard guarantee should use {@link listAlgorithmRuns} + filter instead.
 */
export async function listRecentAlgorithmRuns(
  options: AlgorithmStoreOptions & { since: Date },
): Promise<{ path: string; run: AlgorithmRun }[]> {
  return loadRunsFromDir(resolveAlgorithmRunsDir(options), async (path) => {
    const info = await stat(path).catch(() => undefined);
    return info !== undefined && info.mtime >= options.since;
  });
}

export async function listAlgorithmRunSummaries(options: AlgorithmStoreOptions = {}): Promise<AlgorithmRunSummary[]> {
  const runs = await listAlgorithmRuns(options);

  return runs.map(({ path, run }) => summarizeAlgorithmRun(run, path));
}
