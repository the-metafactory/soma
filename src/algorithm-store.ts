import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AlgorithmRun, AlgorithmRunSummary } from "./types";

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
  return JSON.parse(await readFile(path, "utf8")) as AlgorithmRun;
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

  for (const criterion of run.isa.criteria) {
    counts[criterion.status] += 1;
  }

  const total = run.isa.criteria.length;
  const completed = counts.passed + counts.dropped;

  return {
    id: run.id,
    path,
    updatedAt: run.updatedAt,
    phase: run.phase,
    effort: run.effort,
    goal: run.isa.goal,
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
