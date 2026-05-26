import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function malformedJsonError(label: string, path: string, detail: string): Error {
  return new Error(`Malformed ${label} JSON at ${path}: ${detail}`);
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

function findExistingSession(
  sessions: Record<string, SomaWorkRegistryEntry>,
  sessionId: string,
  baseSlug: string,
): SomaWorkRegistryEntry | undefined {
  const baseEntry = sessions[baseSlug];
  if (baseEntry?.sessionUUID === sessionId) return baseEntry;
  return Object.values(sessions).find((entry) => entry.sessionUUID === sessionId);
}

function removeSessionEntries(sessions: Record<string, SomaWorkRegistryEntry>, sessionId: string): void {
  for (const [candidateSlug, candidateEntry] of Object.entries(sessions)) {
    if (candidateEntry.sessionUUID === sessionId) {
      delete sessions[candidateSlug];
    }
  }
}

function buildRegistryEntry(
  options: UpsertSomaWorkRegistryEntryOptions,
  sessionName: string,
  timestamp: string,
  existing?: SomaWorkRegistryEntry,
): SomaWorkRegistryEntry {
  const artifacts = options.artifacts ?? existing?.artifacts ?? {};
  return {
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

function requireStringField(entry: Record<string, unknown>, path: string, slug: string, field: keyof SomaWorkRegistryEntry): string {
  const value = entry[field];
  if (typeof value !== "string") {
    throw malformedJsonError("work registry", path, `session entry ${slug}.${field} must be a string`);
  }
  return value;
}

function validateRegistryEntry(path: string, slug: string, entry: Record<string, unknown>): SomaWorkRegistryEntry {
  const artifacts = entry.artifacts;
  if (!isPlainRecord(artifacts)) {
    throw malformedJsonError("work registry", path, `session entry ${slug}.artifacts must be an object`);
  }

  for (const [artifactKey, artifactPath] of Object.entries(artifacts)) {
    if (typeof artifactPath !== "string") {
      throw malformedJsonError("work registry", path, `session entry ${slug}.artifacts.${artifactKey} must be a string`);
    }
  }

  const isa = entry.isa;
  if (isa !== undefined && typeof isa !== "string") {
    throw malformedJsonError("work registry", path, `session entry ${slug}.isa must be a string`);
  }

  return {
    ...(isa !== undefined ? { isa } : {}),
    task: requireStringField(entry, path, slug, "task"),
    sessionName: requireStringField(entry, path, slug, "sessionName"),
    sessionUUID: requireStringField(entry, path, slug, "sessionUUID"),
    substrate: requireStringField(entry, path, slug, "substrate"),
    phase: requireStringField(entry, path, slug, "phase"),
    progress: requireStringField(entry, path, slug, "progress"),
    started: requireStringField(entry, path, slug, "started"),
    updatedAt: requireStringField(entry, path, slug, "updatedAt"),
    artifacts: artifacts as Record<string, string>,
  };
}

function validateRegistrySessions(path: string, value: unknown): Record<string, SomaWorkRegistryEntry> {
  if (!isPlainRecord(value)) {
    throw malformedJsonError("work registry", path, "sessions must be an object");
  }

  const sessions: Record<string, SomaWorkRegistryEntry> = {};
  for (const [slug, entry] of Object.entries(value)) {
    if (!isPlainRecord(entry)) {
      throw malformedJsonError("work registry", path, `session entry ${slug} must be an object`);
    }
    sessions[slug] = validateRegistryEntry(path, slug, entry);
  }

  return sessions;
}

async function readSessionNames(path: string): Promise<Record<string, string>> {
  const parsed = await readJsonFile<unknown>(path, {}, "session-name registry");
  if (!isPlainRecord(parsed)) {
    throw malformedJsonError("session-name registry", path, "root must be an object");
  }

  for (const [sessionId, sessionName] of Object.entries(parsed)) {
    if (typeof sessionName !== "string") {
      throw malformedJsonError("session-name registry", path, `session name ${sessionId} must be a string`);
    }
  }

  return parsed as Record<string, string>;
}

export function normalizeSomaWorkRegistryArtifacts(
  options: SomaPathsOptions,
  artifacts: Record<string, string>,
): Record<string, string> {
  const root = resolve(createPaths(options).root());
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(artifacts)) {
    if (typeof value !== "string") {
      throw new Error(`Artifact pointer ${key} must be a string`);
    }

    const resolvedArtifact = isAbsolute(value) ? resolve(value) : resolve(root, value);
    const artifactPath = relative(root, resolvedArtifact).replaceAll("\\", "/");
    if (artifactPath === "" || artifactPath.startsWith("../") || artifactPath === ".." || isAbsolute(artifactPath)) {
      throw new Error(`Artifact pointer ${key} escapes Soma home: ${value}`);
    }
    if (!artifactPath.startsWith("memory/")) {
      throw new Error(`Artifact pointer ${key} must stay under memory/: ${value}`);
    }

    normalized[key] = artifactPath;
  }

  return normalized;
}

export async function readSomaWorkRegistry(options: SomaPathsOptions = {}): Promise<SomaWorkRegistry> {
  const path = workRegistryPath(options);
  const registry = await readJsonFile<unknown>(path, { sessions: {} }, "work registry");
  if (!isPlainRecord(registry)) {
    throw malformedJsonError("work registry", path, "root must be an object");
  }

  return { sessions: validateRegistrySessions(path, registry.sessions ?? {}) };
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
  const names = await readSessionNames(namesPath);
  const existing = findExistingSession(registry.sessions, options.sessionId, baseSlug);

  removeSessionEntries(registry.sessions, options.sessionId);
  const slug = uniqueSessionSlug(registry.sessions, baseSlug, options.sessionId);
  const rawArtifacts = options.artifacts ?? existing?.artifacts ?? {};
  const entry = buildRegistryEntry(
    { ...options, artifacts: normalizeSomaWorkRegistryArtifacts(options, rawArtifacts) },
    sessionName,
    timestamp,
    existing,
  );

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
