import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  AlgorithmEffortSource,
  AlgorithmEffortTier,
  AlgorithmMode,
  AlgorithmPhase,
  AlgorithmRun,
  AlgorithmRunSummary,
  IdealStateArtifact,
  IdealStateCriterion,
} from "./types";
import { buildIsaArtifact, getCriteria, getGoal } from "./isa-accessors";
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

interface LegacyIsa {
  slug: string;
  phase: AlgorithmPhase;
  goal: string;
  criteria: IdealStateCriterion[];
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
  isa: LegacyIsa;
  loop?: AlgorithmRun["loop"];
  schemaVersion?: 1 | 2;
};

/**
 * Compat shim — accepts both pre-#41 (schemaVersion 1, embedded `{ goal, criteria }`)
 * and post-#41 (schemaVersion 2, unified `IdealStateArtifact`) on-disk shapes.
 * Always returns the unified schema-2 shape.
 */
export function loadAlgorithmRun(raw: unknown): AlgorithmRun {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("AlgorithmRun JSON is not an object.");
  }
  const candidate = raw as Partial<AlgorithmRun & LegacyAlgorithmRun>;
  if (candidate.schemaVersion === 2 && isUnifiedShape(candidate.isa)) {
    return ensureAlgorithmRunDefaults(candidate as AlgorithmRun);
  }
  return ensureAlgorithmRunDefaults(migrateRunV1toV2(candidate as LegacyAlgorithmRun));
}

type AlgorithmRunWithDefaults = Omit<AlgorithmRun, "loop" | "provenance"> & Partial<Pick<AlgorithmRun, "loop" | "provenance">>;

function ensureAlgorithmRunDefaults(run: AlgorithmRunWithDefaults): AlgorithmRun {
  return {
    ...run,
    loop: run.loop ?? { ...DEFAULT_ALGORITHM_LOOP_STATE, iterations: [] },
    capabilityDefinitions: run.capabilityDefinitions ?? [],
    capabilitySelections: run.capabilitySelections ?? [],
    provenance: run.provenance ?? [],
  };
}

function isUnifiedShape(isa: unknown): boolean {
  return (
    typeof isa === "object" &&
    isa !== null &&
    "frontmatter" in isa &&
    "sections" in isa &&
    Array.isArray((isa as { sections: unknown }).sections)
  );
}

function migrateRunV1toV2(legacy: LegacyAlgorithmRun): AlgorithmRun {
  const legacyPhase: AlgorithmPhase = legacy.phase ?? legacy.isa.phase;
  const criteria = Array.isArray(legacy.isa.criteria) ? legacy.isa.criteria : [];
  const goal = typeof legacy.isa.goal === "string" ? legacy.isa.goal : "";
  const intent = legacy.intent ?? legacy.id;
  const built = buildIsaArtifact({
    slug: legacy.isa.slug,
    task: intent,
    goal,
    criteria,
    effort: legacy.effort,
    mode: legacy.mode,
    phase: legacyPhase,
    timestamp: legacy.createdAt,
  });
  const isa: IdealStateArtifact = {
    ...built,
    frontmatter: { ...built.frontmatter, updated: legacy.updatedAt },
  };

  // Spread legacy first, then override divergent fields. New AlgorithmRun
  // fields with default-safe optionality will propagate automatically.
  const { phase: _legacyPhaseField, ...legacyFields } = legacy;
  void _legacyPhaseField;
  return {
    ...legacyFields,
    schemaVersion: 2,
    intent,
    isa,
    loop: legacy.loop ?? { ...DEFAULT_ALGORITHM_LOOP_STATE, iterations: [] },
    antiCriteria: legacy.antiCriteria ?? [],
    capabilities: legacy.capabilities ?? [],
    capabilityDefinitions: legacy.capabilityDefinitions ?? [],
    capabilitySelections: legacy.capabilitySelections ?? [],
    planSteps: legacy.planSteps ?? [],
    decisions: legacy.decisions ?? [],
    changelog: legacy.changelog ?? [],
    verification: legacy.verification ?? [],
    learning: legacy.learning ?? [],
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
  };

  const criteria = getCriteria(run.isa);
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
    goal: getGoal(run.isa) ?? "",
    openCriteria: counts.open,
    passedCriteria: counts.passed,
    failedCriteria: counts.failed,
    droppedCriteria: counts.dropped,
    progress: `${completed}/${total}`,
  };
}

export async function listAlgorithmRuns(options: AlgorithmStoreOptions = {}): Promise<{ path: string; run: AlgorithmRun }[]> {
  const runsDir = resolveAlgorithmRunsDir(options);
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const path = join(runsDir, entry.name);
        return {
          path,
          run: await readAlgorithmRun(path),
        };
      }),
  );

  return runs.sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
}

export async function listAlgorithmRunSummaries(options: AlgorithmStoreOptions = {}): Promise<AlgorithmRunSummary[]> {
  const runs = await listAlgorithmRuns(options);

  return runs.map(({ path, run }) => summarizeAlgorithmRun(run, path));
}
