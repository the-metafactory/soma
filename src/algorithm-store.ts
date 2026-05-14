import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AlgorithmRun } from "./types";

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

export async function writeAlgorithmRun(run: AlgorithmRun, options: AlgorithmStoreOptions = {}): Promise<WrittenAlgorithmRun> {
  const path = algorithmRunPath(run, options);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");

  return { path, run };
}

export async function readAlgorithmRun(path: string): Promise<AlgorithmRun> {
  return JSON.parse(await readFile(path, "utf8")) as AlgorithmRun;
}
