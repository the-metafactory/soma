import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createPaths, type SomaPathsOptions } from "./paths";

export interface SomaWorkRegistryEntry {
  // soma#329 slice 3: pointer to the session's active VSA. On read we dual-read a
  // legacy `isa` key (pre-rename work.json); on write we always emit `vsa`.
  vsa?: string;
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

export type SomaCurrentWorkPointerStatus = "active" | "idle" | "complete" | "failed";

export interface SomaCurrentWorkPointerLearningSources {
  events?: string;
  ratings?: string;
  feedback?: string;
  results?: string[];
  rawTranscript?: string;
}

export interface SomaCurrentWorkPointerSignals {
  mode?: "minimal" | "native" | "algorithm";
  classifier?: string;
  cwd?: string;
}

export interface SomaCurrentWorkPointer extends SomaWorkRegistryEntry {
  schema: "soma-current-work-v1";
  slug: string;
  status: SomaCurrentWorkPointerStatus;
  completedAt?: string;
  learningSources?: SomaCurrentWorkPointerLearningSources;
  signals?: SomaCurrentWorkPointerSignals;
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
  /** Optional caller-owned deadline for acquiring the shared registry lock. */
  workRegistryLockTimeoutMs?: number;
}

export interface UpsertSomaCurrentWorkPointerOptions extends UpsertSomaWorkRegistryEntryOptions {
  status?: SomaCurrentWorkPointerStatus;
  learningSources?: SomaCurrentWorkPointerLearningSources;
  signals?: SomaCurrentWorkPointerSignals;
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

function safeFilenameToken(value: string): string {
  return safeToken(value).slice(0, 64);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function malformedJsonError(label: string, path: string, detail: string): Error {
  return new Error(`Malformed ${label} JSON at ${path}: ${detail}`);
}

function createRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function setRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

type SparseRegistrySessions = Record<string, SomaWorkRegistryEntry | undefined>;

function uniqueSessionSlug(sessions: SparseRegistrySessions, baseSlug: string, sessionId: string): string {
  const occupied = sessions[baseSlug];
  if (occupied === undefined || occupied.sessionUUID === sessionId) return baseSlug;

  const sessionSuffix = safeToken(sessionId);
  let candidate = `${baseSlug}-${sessionSuffix}`;
  let counter = 2;
  for (;;) {
    const candidateEntry = sessions[candidate];
    if (candidateEntry === undefined || candidateEntry.sessionUUID === sessionId) break;
    candidate = `${baseSlug}-${sessionSuffix}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function findExistingSession(
  sessions: SparseRegistrySessions,
  sessionId: string,
  baseSlug: string,
): SomaWorkRegistryEntry | undefined {
  const baseEntry = sessions[baseSlug];
  if (baseEntry?.sessionUUID === sessionId) return baseEntry;
  return Object.values(sessions).find((entry) => entry?.sessionUUID === sessionId);
}

function removeSessionEntries(sessions: Record<string, SomaWorkRegistryEntry>, sessionId: string): void {
  for (const [candidateSlug, candidateEntry] of Object.entries(sessions)) {
    if (candidateEntry.sessionUUID === sessionId) {
      Reflect.deleteProperty(sessions, candidateSlug);
    }
  }
}

function boundedMetadataLine(value: string, fallback: string, maxLength = 160): string {
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const normalized = (firstLine ?? fallback).replace(/\s+/g, " ").trim() || fallback;
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trimEnd();
}

function buildRegistryEntry(
  options: UpsertSomaCurrentWorkPointerOptions,
  sessionName: string,
  timestamp: string,
  existing?: SomaWorkRegistryEntry,
): SomaWorkRegistryEntry {
  const artifacts = options.artifacts ?? existing?.artifacts ?? {};
  const vsaPointer = artifacts.vsa || artifacts.isa;
  return {
    ...(vsaPointer ? { vsa: vsaPointer } : {}),
    task: boundedMetadataLine(options.task ?? existing?.task ?? sessionName, sessionName),
    sessionName,
    sessionUUID: options.sessionId,
    substrate: options.substrate,
    phase: boundedMetadataLine(options.phase ?? existing?.phase ?? "native", "native", 64),
    progress: boundedMetadataLine(options.progress ?? existing?.progress ?? "0/0", "0/0", 32),
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
  return createPaths(options).resolve("memory", "STATE", `current-work-${safeFilenameToken(sessionId)}-${shortHash(sessionId)}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${shortHash(`${path}:${Date.now()}:${Math.random()}`)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

const DEFAULT_WORK_REGISTRY_LOCK_TIMEOUT_MS = 30_000;
const STALE_WORK_REGISTRY_LOCK_MS = 30_000;
const WORK_REGISTRY_LOCK_OWNER_FILE = "owner.json";
const WORK_REGISTRY_LOCK_RECLAIM_SUFFIX = ".reclaim";

function resolveWorkRegistryLockTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_WORK_REGISTRY_LOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`work registry lock timeout must be a positive integer, got ${timeoutMs}`);
  }
  return timeoutMs;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function isReclaimableWorkRegistryLock(lockPath: string): Promise<boolean> {
  try {
    const lock = await stat(lockPath);
    if (!lock.isDirectory() || Date.now() - lock.mtimeMs < STALE_WORK_REGISTRY_LOCK_MS) return false;

    try {
      const owner = JSON.parse(await readFile(join(lockPath, WORK_REGISTRY_LOCK_OWNER_FILE), "utf8")) as unknown;
      return isPlainRecord(owner) && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
        ? !isProcessAlive(owner.pid)
        : false;
    } catch {
      // An ownerless pre-metadata lock may still be held by an older process.
      return false;
    }
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function acquireReclaimGuard(reclaimPath: string): Promise<boolean> {
  for (;;) {
    try {
      await mkdir(reclaimPath);
      try {
        await writeFile(join(reclaimPath, WORK_REGISTRY_LOCK_OWNER_FILE), `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
      } catch (error) {
        await rm(reclaimPath, { recursive: true, force: true });
        throw error;
      }
      return true;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (!(await isReclaimableWorkRegistryLock(reclaimPath))) return false;
      await rm(reclaimPath, { recursive: true, force: true });
    }
  }
}

async function reclaimStaleWorkRegistryLock(lockPath: string): Promise<boolean> {
  const reclaimPath = `${lockPath}${WORK_REGISTRY_LOCK_RECLAIM_SUFFIX}`;
  if (!(await acquireReclaimGuard(reclaimPath))) return false;

  try {
    if (!(await isReclaimableWorkRegistryLock(lockPath))) return false;

    // The reclaim guard serializes stale-lock inspection and rename. Once moved,
    // later writers may acquire a fresh lock at `lockPath`; only this retired
    // directory is removed, so a fresh owner cannot be deleted by a reclaimer.
    const retiredPath = `${lockPath}.stale-${process.pid}-${shortHash(`${lockPath}:${Date.now()}:${Math.random()}`)}`;
    try {
      await rename(lockPath, retiredPath);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    await rm(retiredPath, { recursive: true, force: true });
    return true;
  } finally {
    await rm(reclaimPath, { recursive: true, force: true });
  }
}

async function withRegistryFileLock<T>(
  registryPath: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  await mkdir(dirname(registryPath), { recursive: true });
  const lockPath = `${registryPath}.lock`;
  const started = Date.now();
  const timeout = resolveWorkRegistryLockTimeout(timeoutMs);
  let nextReclaimAttemptAt = started;

  for (;;) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(
          join(lockPath, WORK_REGISTRY_LOCK_OWNER_FILE),
          `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
          "utf8",
        );
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() >= nextReclaimAttemptAt) {
        nextReclaimAttemptAt = Date.now() + 1_000;
        if (await reclaimStaleWorkRegistryLock(lockPath)) continue;
      }
      if (Date.now() - started > timeout) {
        throw new Error(`Timed out waiting for work registry lock at ${lockPath}`, { cause: error });
      }
      await sleep(10);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function readJsonFile<T>(path: string, fallback: T, label: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Malformed ${label} JSON at ${path}: ${error.message}`, { cause: error });
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

  // soma#329 slice 3: dual-read the legacy `isa` key, validate, persist as `vsa`.
  const vsa = entry.vsa ?? entry.isa;
  if (vsa !== undefined && typeof vsa !== "string") {
    throw malformedJsonError("work registry", path, `session entry ${slug}.vsa must be a string`);
  }

  return {
    ...(vsa !== undefined ? { vsa } : {}),
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

  const sessions = createRecord<SomaWorkRegistryEntry>();
  for (const [slug, entry] of Object.entries(value)) {
    if (!isPlainRecord(entry)) {
      throw malformedJsonError("work registry", path, `session entry ${slug} must be an object`);
    }
    setRecordValue(sessions, slug, validateRegistryEntry(path, slug, entry));
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

  const names = createRecord<string>();
  for (const [sessionId, sessionName] of Object.entries(parsed)) {
    setRecordValue(names, sessionId, sessionName);
  }

  return names;
}

export function normalizeSomaWorkRegistryArtifacts(
  options: SomaPathsOptions,
  artifacts: Record<string, string>,
): Record<string, string> {
  const root = resolve(createPaths(options).root());
  const normalized = createRecord<string>();

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

    setRecordValue(normalized, key, artifactPath);
  }

  return normalized;
}

function normalizeSomaCurrentWorkLearningSources(
  options: SomaPathsOptions,
  sources?: SomaCurrentWorkPointerLearningSources,
): SomaCurrentWorkPointerLearningSources | undefined {
  if (sources === undefined) return undefined;

  const raw: Record<string, string> = {};
  if (sources.events !== undefined) raw.events = sources.events;
  if (sources.ratings !== undefined) raw.ratings = sources.ratings;
  if (sources.feedback !== undefined) raw.feedback = sources.feedback;
  if (sources.rawTranscript !== undefined) raw.rawTranscript = sources.rawTranscript;

  const normalized = normalizeSomaWorkRegistryArtifacts(options, raw) as Partial<Record<"events" | "ratings" | "feedback" | "rawTranscript", string>>;
  const results =
    sources.results === undefined
      ? undefined
      : Object.values(
          normalizeSomaWorkRegistryArtifacts(
            options,
            Object.fromEntries(sources.results.map((path, index) => [`result${index}`, path])),
          ),
        );

  return {
    ...(normalized.events !== undefined ? { events: normalized.events } : {}),
    ...(normalized.ratings !== undefined ? { ratings: normalized.ratings } : {}),
    ...(normalized.feedback !== undefined ? { feedback: normalized.feedback } : {}),
    ...(results !== undefined ? { results } : {}),
    ...(normalized.rawTranscript !== undefined ? { rawTranscript: normalized.rawTranscript } : {}),
  };
}

export async function readSomaWorkRegistry(options: SomaPathsOptions = {}): Promise<SomaWorkRegistry> {
  const path = workRegistryPath(options);
  const registry = await readJsonFile<unknown>(path, { sessions: {} }, "work registry");
  if (!isPlainRecord(registry)) {
    throw malformedJsonError("work registry", path, "root must be an object");
  }

  return { sessions: validateRegistrySessions(path, registry.sessions === undefined ? {} : registry.sessions) };
}

export async function listSomaWorkRegistryEntries(options: SomaPathsOptions = {}): Promise<SomaWorkRegistryEntry[]> {
  const registry = await readSomaWorkRegistry(options);
  return Object.values(registry.sessions).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function upsertSomaWorkRegistryEntry(
  options: UpsertSomaWorkRegistryEntryOptions,
): Promise<UpsertSomaWorkRegistryEntryResult> {
  return withRegistryFileLock(
    workRegistryPath(options),
    () => upsertSomaWorkRegistryEntryLocked(options),
    options.workRegistryLockTimeoutMs,
  );
}

async function upsertSomaWorkRegistryEntryLocked(
  options: UpsertSomaCurrentWorkPointerOptions,
): Promise<UpsertSomaWorkRegistryEntryResult> {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const sessionName = boundedMetadataLine(options.sessionName ?? options.task ?? options.sessionId, options.sessionId);
  const baseSlug = safeToken(boundedMetadataLine(options.slug ?? sessionName, sessionName));
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
  const pointer = buildCurrentWorkPointer(options, slug, entry, timestamp);

  setRecordValue(registry.sessions, slug, entry);
  setRecordValue(names, options.sessionId, sessionName);

  await writeJson(registryPath, registry);
  await writeJson(namesPath, names);
  await writeJson(pointerPath, pointer);

  return {
    slug,
    entry,
    files: [registryPath, namesPath, pointerPath],
  };
}

function buildCurrentWorkPointer(
  options: UpsertSomaCurrentWorkPointerOptions,
  slug: string,
  entry: SomaWorkRegistryEntry,
  timestamp: string,
): SomaCurrentWorkPointer {
  const status = options.status ?? "active";
  return {
    schema: "soma-current-work-v1",
    slug,
    ...entry,
    status,
    ...(status === "complete" || status === "failed" ? { completedAt: timestamp } : {}),
    ...(options.learningSources !== undefined
      ? { learningSources: normalizeSomaCurrentWorkLearningSources(options, options.learningSources) }
      : {}),
    ...(options.signals !== undefined ? { signals: options.signals } : {}),
  };
}

export async function upsertSomaCurrentWorkPointer(
  options: UpsertSomaCurrentWorkPointerOptions,
): Promise<UpsertSomaWorkRegistryEntryResult> {
  return withRegistryFileLock(
    workRegistryPath(options),
    () => upsertSomaWorkRegistryEntryLocked(options),
    options.workRegistryLockTimeoutMs,
  );
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
