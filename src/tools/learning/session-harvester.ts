import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { listSomaWorkRegistryEntries, type SomaCurrentWorkPointer, type SomaWorkRegistryEntry } from "../../work-registry";
import { isoTimestamp, pathsForLearningOptions, safeFileToken } from "./paths";
import { transcriptContentToText } from "./transcript";
import type { HarvestOptions, HarvestedLearning } from "./types";

const CORRECTION_PATTERNS = [/actually,?\s+/i, /wait,?\s+/i, /no,?\s+i meant/i, /let me clarify/i, /you misunderstood/i];
const ERROR_PATTERNS = [/error:/i, /failed:/i, /exception:/i, /stderr:/i, /command failed/i, /permission denied/i, /not found/i];
const INSIGHT_PATTERNS = [/learned that/i, /realized that/i, /discovered that/i, /key insight/i, /important:/i, /for next time/i, /lesson:/i];
const HARVEST_CONCURRENCY = 4;
const CURRENT_WORK_POINTER_READ_WINDOW = 50;

interface TranscriptEntry {
  sessionId?: string;
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

export function getLearningCategory(content: string): "SYSTEM" | "ALGORITHM" {
  const text = content.toLowerCase();
  if (/over.?engineer|wrong approach|should have asked|didn't follow|too complex|approach|method|strategy|reasoning/.test(text)) {
    return "ALGORITHM";
  }
  if (/hook|crash|broken|tool|config|deploy|path|typescript|javascript|npm|bun|module|file.*not.*found/.test(text)) {
    return "SYSTEM";
  }
  return "ALGORITHM";
}

export function isLearningCapture(text: string): boolean {
  const indicators = [/problem|issue|bug|error|failed|broken/i, /fixed|solved|resolved|discovered|realized|learned/i, /debug|investigate|root cause/i, /lesson|takeaway|next time/i];
  return indicators.filter((pattern) => pattern.test(text)).length >= 2;
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  return patterns.find((pattern) => pattern.test(text))?.source;
}

export async function discoverSessionFiles(options: HarvestOptions = {}): Promise<string[]> {
  if (options.sessionDir === undefined) return [];
  const sessionDir = options.sessionDir;
  const entries = await readdir(sessionDir, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map(async (entry) => {
    const path = join(sessionDir, entry.name);
    return { path, mtime: (await stat(path)).mtimeMs };
  }));
  const sorted = files.sort((a, b) => b.mtime - a.mtime);
  if (options.sessionId) {
    const requested = safeFileToken(options.sessionId);
    return sorted
      .filter((file) => basename(file.path, ".jsonl") === requested)
      .map((file) => file.path);
  }
  if (options.all) return sorted.map((file) => file.path);
  return sorted.slice(0, options.recent ?? 10).map((file) => file.path);
}

function learningFromWorkRegistryEntry(entry: SomaWorkRegistryEntry): HarvestedLearning {
  const artifactList = Object.entries(entry.artifacts)
    .map(([kind, path]) => `${kind}: ${path}`)
    .join("\n");
  return {
    sessionId: entry.sessionUUID,
    timestamp: isoTimestamp(entry.updatedAt),
    category: "ALGORITHM",
    type: "insight",
    context: `Shared work state from ${entry.substrate}; phase ${entry.phase}; progress ${entry.progress}.`,
    content: [
      `Work registry session: ${entry.task}`,
      `Session name: ${entry.sessionName}`,
      artifactList ? `Artifacts:\n${artifactList}` : "Artifacts: none recorded",
    ].join("\n"),
    source: "work-registry",
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringField(value: Record<string, unknown>, key: keyof SomaCurrentWorkPointer): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

const CURRENT_WORK_REQUIRED_STRING_FIELDS = [
  "task",
  "sessionName",
  "sessionUUID",
  "substrate",
  "phase",
  "progress",
  "started",
  "updatedAt",
  "slug",
  "status",
] as const satisfies readonly (keyof SomaCurrentWorkPointer)[];

type CurrentWorkRequiredStrings = Record<(typeof CURRENT_WORK_REQUIRED_STRING_FIELDS)[number], string>;

function requiredStringFields(value: Record<string, unknown>): CurrentWorkRequiredStrings | null {
  const fields: Partial<CurrentWorkRequiredStrings> = {};
  for (const key of CURRENT_WORK_REQUIRED_STRING_FIELDS) {
    const field = stringField(value, key);
    if (field === undefined) return null;
    fields[key] = field;
  }
  return fields as CurrentWorkRequiredStrings;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function learningSources(value: unknown): SomaCurrentWorkPointer["learningSources"] {
  if (!isPlainRecord(value)) return undefined;
  return {
    ...(typeof value.events === "string" ? { events: value.events } : {}),
    ...(typeof value.ratings === "string" ? { ratings: value.ratings } : {}),
    ...(typeof value.feedback === "string" ? { feedback: value.feedback } : {}),
    ...(Array.isArray(value.results) ? { results: stringArray(value.results) } : {}),
    ...(typeof value.rawTranscript === "string" ? { rawTranscript: value.rawTranscript } : {}),
  };
}

function loadCurrentWorkPointer(value: unknown): SomaCurrentWorkPointer | null {
  if (!isPlainRecord(value) || value.schema !== "soma-current-work-v1") return null;

  const fields = requiredStringFields(value);
  if (fields === null) return null;
  const { status } = fields;
  if (status !== "active" && status !== "idle" && status !== "complete" && status !== "failed") return null;

  return {
    schema: "soma-current-work-v1",
    ...fields,
    status,
    artifacts: stringRecord(value.artifacts),
    ...(typeof value.isa === "string" ? { isa: value.isa } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    ...(value.learningSources !== undefined ? { learningSources: learningSources(value.learningSources) } : {}),
  };
}

function safeMemoryPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const normalized = path.replaceAll("\\", "/");
  if (normalized !== "memory" && !normalized.startsWith("memory/")) return undefined;
  if (isAbsolute(normalized) || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return normalized;
}

function safeMetadataToken(value: string | undefined, maxLength = 128): string | undefined {
  if (value === undefined || value.length > maxLength) return undefined;
  return /^[A-Za-z0-9._:-]+$/u.test(value) ? value : undefined;
}

function safeEventId(value: unknown): string | undefined {
  return typeof value === "string" ? safeMetadataToken(value) : undefined;
}

type EventIdsBySession = Map<string, string[]>;
type EventIdsByPath = Map<string, EventIdsBySession>;

async function readEventIdsBySession(eventsPath: string, sessionIds: ReadonlySet<string>, options: HarvestOptions): Promise<EventIdsBySession> {
  const paths = pathsForLearningOptions(options);
  const idsBySession: EventIdsBySession = new Map();
  let lines: ReturnType<typeof createInterface>;

  try {
    lines = createInterface({ input: createReadStream(paths.resolve(eventsPath), { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPlainRecord(event)) continue;
      const metadata = isPlainRecord(event.metadata) ? event.metadata : {};
      const sessionId = [event.sessionId, event.session_id, metadata.sessionId, metadata.session_id, metadata.sessionUUID]
        .find((candidate): candidate is string => typeof candidate === "string");
      const eventId = safeEventId(event.id);
      if (sessionId === undefined || !sessionIds.has(sessionId) || eventId === undefined) continue;
      idsBySession.set(sessionId, [...(idsBySession.get(sessionId) ?? []), eventId]);
    }
  } catch {
    return new Map();
  }

  return idsBySession;
}

async function readEventIdsByPath(pointers: SomaCurrentWorkPointer[], options: HarvestOptions): Promise<EventIdsByPath> {
  const sessionIds = new Set(pointers.map((pointer) => pointer.sessionUUID));
  const eventsPaths = Array.from(
    new Set(
      pointers
        .map((pointer) => safeMemoryPath(pointer.learningSources?.events))
        .filter((path): path is string => path !== undefined),
    ),
  );
  const entries = await Promise.all(
    eventsPaths.map(async (eventsPath) => [eventsPath, await readEventIdsBySession(eventsPath, sessionIds, options)] as const),
  );
  return new Map(entries);
}

function eventIdsForPointer(pointer: SomaCurrentWorkPointer, idsByPath: EventIdsByPath): string[] {
  const eventsPath = safeMemoryPath(pointer.learningSources?.events);
  if (eventsPath === undefined) return [];
  return idsByPath.get(eventsPath)?.get(pointer.sessionUUID) ?? [];
}

function safeMemoryRecord(record: Record<string, string>): Array<[string, string]> {
  return Object.entries(record)
    .map(([kind, path]) => [safeMetadataToken(kind, 64), safeMemoryPath(path)] as const)
    .filter((entry): entry is [string, string] => entry[0] !== undefined && entry[1] !== undefined);
}

function safeMemoryArray(paths: string[] | undefined): string[] {
  return (paths ?? []).map((path) => safeMemoryPath(path)).filter((path): path is string => path !== undefined);
}

function learningFromCurrentWorkPointer(pointer: SomaCurrentWorkPointer, pointerPath: string, eventIds: string[]): HarvestedLearning {
  const artifacts = safeMemoryRecord(pointer.artifacts)
    .map(([kind, path]) => `${kind}: ${path}`)
    .join("\n");
  const sourceFiles = [
    ["events", safeMemoryPath(pointer.learningSources?.events)],
    ["ratings", safeMemoryPath(pointer.learningSources?.ratings)],
    ["feedback", safeMemoryPath(pointer.learningSources?.feedback)],
  ] as const;
  const labelledSourceFiles = [
    ...sourceFiles.flatMap(([label, path]) => path === undefined ? [] : [`${label}: ${path}`]),
    ...safeMemoryArray(pointer.learningSources?.results).map((path) => `result: ${path}`),
  ].filter((line): line is string => line !== undefined);

  return {
    sessionId: pointer.sessionUUID,
    timestamp: isoTimestamp(pointer.updatedAt),
    category: "ALGORITHM",
    type: "insight",
    context: `Current-work snapshot from ${pointer.substrate}; status ${pointer.status}; phase ${pointer.phase}; progress ${pointer.progress}.`,
    content: [
      `Current-work session: ${pointer.task}`,
      `Session name: ${pointer.sessionName}`,
      `Pointer: ${pointerPath}`,
      artifacts ? `Artifacts:\n${artifacts}` : "Artifacts: none recorded",
      labelledSourceFiles.length > 0 ? `Learning source files:\n${labelledSourceFiles.join("\n")}` : "Learning source files: none recorded",
      eventIds.length > 0 ? `Event ids: ${eventIds.join(", ")}` : "Event ids: none recorded",
    ].join("\n"),
    source: `current-work:${pointerPath}`,
  };
}

type CurrentWorkPointerRecord = { path: string; pointer: SomaCurrentWorkPointer };

async function discoverCurrentWorkPointers(options: HarvestOptions): Promise<CurrentWorkPointerRecord[]> {
  const paths = pathsForLearningOptions(options);
  const stateDir = paths.resolve("memory", "STATE");
  const entries = await readdir(stateDir, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const files = await mapLimited(
    entries.filter((entry) => entry.isFile() && /^current-work-.+\.json$/.test(entry.name)),
    HARVEST_CONCURRENCY,
    async (entry) => ({
      entry,
      mtime: await stat(join(stateDir, entry.name)).then((file) => file.mtimeMs).catch(() => 0),
    }),
  );
  const readLimit = options.all ? files.length : Math.max(options.recent ?? 10, CURRENT_WORK_POINTER_READ_WINDOW);
  const pointers = await mapLimited(
    files
      .sort((left, right) => right.mtime - left.mtime || right.entry.name.localeCompare(left.entry.name))
      .slice(0, readLimit),
    HARVEST_CONCURRENCY,
    async ({ entry }) => {
      const relativePath = `memory/STATE/${entry.name}`;
      const raw = await readFile(join(stateDir, entry.name), "utf8").catch(() => undefined);
      if (raw === undefined) return null;
      try {
        const pointer = loadCurrentWorkPointer(JSON.parse(raw));
        return pointer === null ? null : { path: relativePath, pointer };
      } catch {
        return null;
      }
    },
  );

  return pointers
    .filter((item): item is CurrentWorkPointerRecord => item !== null)
    .sort((left, right) => right.pointer.updatedAt.localeCompare(left.pointer.updatedAt));
}

async function harvestCurrentWorkPointers(options: HarvestOptions): Promise<{ hasCurrentWork: boolean; learnings: HarvestedLearning[] }> {
  const pointers = await discoverCurrentWorkPointers(options);
  const filtered = options.sessionId
    ? pointers.filter(({ pointer }) => pointer.sessionUUID === options.sessionId)
    : pointers;
  const selected = options.all ? filtered : filtered.slice(0, options.recent ?? 10);
  const idsByPath = await readEventIdsByPath(selected.map(({ pointer }) => pointer), options);
  return {
    hasCurrentWork: filtered.length > 0,
    learnings: selected.map(({ path, pointer }) => learningFromCurrentWorkPointer(pointer, path, eventIdsForPointer(pointer, idsByPath))),
  };
}

async function harvestWorkRegistrySessions(options: HarvestOptions): Promise<HarvestedLearning[]> {
  const entries = await listSomaWorkRegistryEntries(options);
  const filtered = options.sessionId
    ? entries.filter((entry) => entry.sessionUUID === options.sessionId)
    : entries;
  const selected = options.all ? filtered : filtered.slice(0, options.recent ?? 10);
  return selected.map(learningFromWorkRegistryEntry);
}

export async function harvestSessionFile(sessionPath: string): Promise<HarvestedLearning[]> {
  const lines = createInterface({ input: createReadStream(sessionPath, { encoding: "utf8" }), crlfDelay: Infinity });
  const sessionId = safeFileToken(basename(sessionPath, ".jsonl"));
  const learnings: HarvestedLearning[] = [];
  let previousContext = "";

  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    const text = transcriptContentToText(entry.message?.content);
    if (text.length < 20) continue;
    let timestamp: string;
    try {
      timestamp = isoTimestamp(entry.timestamp);
    } catch {
      continue;
    }

    if (entry.type === "user") {
      const match = firstMatch(text, CORRECTION_PATTERNS);
      if (match) learnings.push({ sessionId, timestamp, category: getLearningCategory(text), type: "correction", context: previousContext.slice(0, 200), content: text.slice(0, 500), source: match });
    }
    if (entry.type === "assistant") {
      const error = firstMatch(text, ERROR_PATTERNS);
      if (error && isLearningCapture(text)) learnings.push({ sessionId, timestamp, category: getLearningCategory(text), type: "error", context: previousContext.slice(0, 200), content: text.slice(0, 500), source: error });
      const insight = firstMatch(text, INSIGHT_PATTERNS);
      if (insight) learnings.push({ sessionId, timestamp, category: getLearningCategory(text), type: "insight", context: previousContext.slice(0, 200), content: text.slice(0, 500), source: insight });
    }
    previousContext = text;
  }

  return learnings;
}

function formatLearning(learning: HarvestedLearning): string {
  return `# ${learning.type} learning

**Session:** ${learning.sessionId}
**Timestamp:** ${learning.timestamp}
**Category:** ${learning.category}
**Source:** ${learning.source}

## Context

${learning.context}

## Learning

${learning.content}
`;
}

async function writeLearning(learning: HarvestedLearning, options: HarvestOptions): Promise<string> {
  const paths = pathsForLearningOptions(options);
  const timestamp = isoTimestamp(learning.timestamp);
  const month = timestamp.slice(0, 7);
  const dir = paths.resolve("memory", "LEARNING", learning.category, month);
  await mkdir(dir, { recursive: true });
  const safeTime = timestamp.slice(0, 16).replace(/[:T]/g, "");
  const file = join(dir, `${safeTime}_${learning.type}_${safeFileToken(learning.sessionId).slice(0, 8)}.md`);
  await writeFile(file, formatLearning(learning), "utf8");
  return file;
}

async function mapLimited<T, U>(items: T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (let index = 0; index < items.length; index += limit) {
    results.push(...await Promise.all(items.slice(index, index + limit).map(fn)));
  }
  return results;
}

export async function harvestSessions(options: HarvestOptions = {}): Promise<HarvestedLearning[]> {
  const learnings = options.sessionDir === undefined
    ? await harvestCurrentWorkPointers(options).then((currentWork) =>
        currentWork.hasCurrentWork ? currentWork.learnings : harvestWorkRegistrySessions(options)
      )
    : (await mapLimited(await discoverSessionFiles(options), HARVEST_CONCURRENCY, harvestSessionFile)).flat();
  if (options.dryRun) return learnings;
  await mapLimited(learnings, HARVEST_CONCURRENCY, async (learning) => {
    learning.path = await writeLearning(learning, options);
  });
  return learnings;
}
