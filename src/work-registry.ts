import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPaths, type SomaPathsOptions } from "./paths";

export interface SomaWorkRegistryEntry {
  isa?: string;
  task: string;
  sessionName: string;
  sessionUUID: string;
  substrate: string;
  phase: string;
  progress: string;
  started: string;
  updatedAt: string;
  artifacts: Record<string, string>;
}

export interface SomaWorkRegistry {
  sessions: Record<string, SomaWorkRegistryEntry>;
}

export interface UpsertSomaWorkRegistryEntryOptions extends SomaPathsOptions {
  slug?: string;
  sessionId: string;
  sessionName?: string;
  substrate: string;
  task?: string;
  phase?: string;
  progress?: string;
  timestamp?: string;
  artifacts?: Record<string, string>;
}

export interface UpsertSomaWorkRegistryEntryResult {
  slug: string;
  entry: SomaWorkRegistryEntry;
  files: string[];
}

function safeToken(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown";
}

function uniqueSessionSlug(sessions: Record<string, SomaWorkRegistryEntry>, baseSlug: string, sessionId: string): string {
  const occupied = sessions[baseSlug];
  if (occupied === undefined || occupied.sessionUUID === sessionId) return baseSlug;

  const sessionSuffix = safeToken(sessionId);
  let candidate = `${baseSlug}-${sessionSuffix}`;
  let counter = 2;
  while (sessions[candidate] !== undefined && sessions[candidate].sessionUUID !== sessionId) {
    candidate = `${baseSlug}-${sessionSuffix}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function workRegistryPath(options: SomaPathsOptions): string {
  return createPaths(options).resolve("memory", "STATE", "work.json");
}

function sessionNamesPath(options: SomaPathsOptions): string {
  return createPaths(options).resolve("memory", "STATE", "session-names.json");
}

function currentWorkPath(options: SomaPathsOptions, sessionId: string): string {
  return createPaths(options).resolve("memory", "STATE", `current-work-${safeToken(sessionId)}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function readJsonFile<T>(path: string, fallback: T, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed ${label} JSON at ${path}: ${error.message}`);
    }
    throw error;
  }
}

export async function readSomaWorkRegistry(options: SomaPathsOptions = {}): Promise<SomaWorkRegistry> {
  const registry = await readJsonFile<Partial<SomaWorkRegistry>>(workRegistryPath(options), { sessions: {} }, "work registry");
  return { sessions: registry.sessions ?? {} };
}

export async function listSomaWorkRegistryEntries(options: SomaPathsOptions = {}): Promise<SomaWorkRegistryEntry[]> {
  const registry = await readSomaWorkRegistry(options);
  return Object.values(registry.sessions).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function upsertSomaWorkRegistryEntry(
  options: UpsertSomaWorkRegistryEntryOptions,
): Promise<UpsertSomaWorkRegistryEntryResult> {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const sessionName = options.sessionName?.trim() || options.task?.trim() || options.sessionId;
  const baseSlug = safeToken(options.slug ?? sessionName);
  const registryPath = workRegistryPath(options);
  const namesPath = sessionNamesPath(options);
  const pointerPath = currentWorkPath(options, options.sessionId);
  const registry = await readSomaWorkRegistry(options);
  const names = await readJsonFile<Record<string, string>>(namesPath, {}, "session-name registry");
  const existingSlug = Object.entries(registry.sessions).find(([, entry]) => entry.sessionUUID === options.sessionId)?.[0];
  const baseEntry = registry.sessions[baseSlug];
  const existing = baseEntry?.sessionUUID === options.sessionId ? baseEntry : existingSlug ? registry.sessions[existingSlug] : undefined;
  for (const [candidateSlug, candidateEntry] of Object.entries(registry.sessions)) {
    if (candidateEntry.sessionUUID === options.sessionId) {
      delete registry.sessions[candidateSlug];
    }
  }
  const slug = uniqueSessionSlug(registry.sessions, baseSlug, options.sessionId);
  const artifacts = options.artifacts ?? existing?.artifacts ?? {};
  const entry: SomaWorkRegistryEntry = {
    ...(artifacts.isa ? { isa: artifacts.isa } : {}),
    task: options.task?.trim() || existing?.task || sessionName,
    sessionName,
    sessionUUID: options.sessionId,
    substrate: options.substrate,
    phase: options.phase ?? existing?.phase ?? "native",
    progress: options.progress ?? existing?.progress ?? "0/0",
    started: existing?.started ?? timestamp,
    updatedAt: timestamp,
    artifacts,
  };

  registry.sessions[slug] = entry;
  names[options.sessionId] = sessionName;

  await writeJson(registryPath, registry);
  await writeJson(namesPath, names);
  await writeJson(pointerPath, { slug, ...entry });

  return {
    slug,
    entry,
    files: [registryPath, namesPath, pointerPath],
  };
}

export function somaWorkRegistryPaths(options: SomaPathsOptions = {}, sessionId?: string): {
  work: string;
  sessionNames: string;
  currentWork?: string;
  workRoot: string;
} {
  const paths = createPaths(options);
  return {
    work: workRegistryPath(options),
    sessionNames: sessionNamesPath(options),
    currentWork: sessionId ? currentWorkPath(options, sessionId) : undefined,
    workRoot: join(paths.root(), "memory", "WORK"),
  };
}
