import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { somaMemoryEventsPath } from "./memory";
import type {
  AlgorithmPhase,
  SomaMemoryEvent,
  SomaTelemetryQueryOptions,
  SomaTelemetryQueryResult,
  SomaTelemetrySummary,
  SomaTelemetrySummaryOptions,
  SubstrateId,
} from "./types";

const ALGORITHM_PHASES = new Set<AlgorithmPhase>([
  "observe",
  "think",
  "plan",
  "build",
  "execute",
  "verify",
  "learn",
  "complete",
  "abandoned",
]);

function resolveSomaHome(options: Pick<SomaTelemetryQueryOptions, "homeDir" | "somaHome"> = {}): string {
  const home = resolve(options.homeDir ?? homedir());
  return resolve(options.somaHome ?? join(home, ".soma"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSomaMemoryEvent(value: unknown): value is SomaMemoryEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.substrate === "string" &&
    typeof value.kind === "string" &&
    typeof value.summary === "string"
  );
}

function parseTelemetryLine(line: string): SomaMemoryEvent | undefined {
  try {
    const event = JSON.parse(line) as unknown;
    return isSomaMemoryEvent(event) ? event : undefined;
  } catch {
    return undefined;
  }
}

async function streamTelemetryEvents(
  somaHome: string,
  onEvent: (event: SomaMemoryEvent) => void,
): Promise<{
  eventPath: string;
  totalEvents: number;
  skippedMalformedLines: number;
}> {
  const eventPath = somaMemoryEventsPath(somaHome);
  const exists = await access(eventPath).then(
    () => true,
    (error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!exists) {
    return { eventPath, totalEvents: 0, skippedMalformedLines: 0 };
  }

  const lines = createInterface({
    input: createReadStream(eventPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let totalEvents = 0;
  let skippedMalformedLines = 0;

  for await (const line of lines) {
    if (line.trim().length === 0) continue;

    const event = parseTelemetryLine(line);
    if (event === undefined) {
      skippedMalformedLines += 1;
      continue;
    }

    totalEvents += 1;
    onEvent(event);
  }

  return { eventPath, totalEvents, skippedMalformedLines };
}

function matchesTelemetryQuery(event: SomaMemoryEvent, options: SomaTelemetryQueryOptions): boolean {
  if (options.substrate !== undefined && event.substrate !== options.substrate) return false;
  if (options.kind !== undefined && event.kind !== options.kind) return false;
  return true;
}

function telemetryLimit(limit: number | undefined): number {
  const boundedLimit = limit ?? 20;
  if (!Number.isSafeInteger(boundedLimit) || boundedLimit < 1) {
    throw new Error("Soma telemetry limit must be a positive integer.");
  }
  return boundedLimit;
}

export async function querySomaTelemetryEvents(options: SomaTelemetryQueryOptions = {}): Promise<SomaTelemetryQueryResult> {
  const somaHome = resolveSomaHome(options);
  const events: SomaMemoryEvent[] = [];
  const boundedLimit = telemetryLimit(options.limit);
  let matchedEvents = 0;
  const read = await streamTelemetryEvents(somaHome, (event) => {
    if (!matchesTelemetryQuery(event, options)) return;
    events[matchedEvents % boundedLimit] = event;
    matchedEvents += 1;
  });
  const retainedEvents = Math.min(matchedEvents, boundedLimit);
  const oldestIndex = matchedEvents > boundedLimit ? matchedEvents % boundedLimit : 0;
  const recentEvents = Array.from({ length: retainedEvents }, (_, offset) => events[(oldestIndex + offset) % boundedLimit]).reverse();

  return {
    somaHome,
    eventPath: read.eventPath,
    totalEvents: read.totalEvents,
    skippedMalformedLines: read.skippedMalformedLines,
    events: recentEvents,
  };
}

function increment<T extends string>(record: Partial<Record<T, number>>, key: T): void {
  record[key] = (record[key] ?? 0) + 1;
}

function incrementRecord(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function eventSessionId(event: SomaMemoryEvent): string | undefined {
  const sessionId = event.metadata?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function eventPhase(event: SomaMemoryEvent): AlgorithmPhase | undefined {
  const phase = event.metadata?.phase;
  if (typeof phase === "string" && ALGORITHM_PHASES.has(phase as AlgorithmPhase)) {
    return phase as AlgorithmPhase;
  }
  return undefined;
}

function eventSkillName(event: SomaMemoryEvent): string | undefined {
  const candidates = [
    event.metadata?.skill,
    event.metadata?.skillName,
    event.metadata?.skillId,
  ];
  const name = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  return name?.trim();
}

function timestampMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface DurationStats {
  count: number;
  totalMs: number;
}

function recordDuration(stats: DurationStats, durationMs: number): void {
  stats.count += 1;
  stats.totalMs += durationMs;
}

function averageDuration(stats: DurationStats): number | null {
  return stats.count > 0 ? Math.round(stats.totalMs / stats.count) : null;
}

interface MutableSessionStats {
  started: number;
  ended: number;
  durations: DurationStats;
}

function ensureSessionStats(
  stats: Partial<Record<SubstrateId, MutableSessionStats>>,
  substrate: SubstrateId,
): MutableSessionStats {
  const existing = stats[substrate];
  if (existing !== undefined) return existing;

  const created: MutableSessionStats = {
    started: 0,
    ended: 0,
    durations: { count: 0, totalMs: 0 },
  };
  stats[substrate] = created;
  return created;
}

function publicSessionStats(stats: Partial<Record<SubstrateId, MutableSessionStats>>): SomaTelemetrySummary["sessions"]["bySubstrate"] {
  const result: SomaTelemetrySummary["sessions"]["bySubstrate"] = {};
  for (const [substrate, value] of Object.entries(stats) as [SubstrateId, MutableSessionStats][]) {
    result[substrate] = {
      started: value.started,
      ended: value.ended,
      completedWithDuration: value.durations.count,
      averageDurationMs: averageDuration(value.durations),
    };
  }
  return result;
}

interface SessionAggregationState {
  starts: Map<string, number>;
  bySubstrate: Partial<Record<SubstrateId, MutableSessionStats>>;
  totalDurations: DurationStats;
  started: number;
  ended: number;
}

function isSessionStartEvent(event: SomaMemoryEvent): boolean {
  return event.kind === "lifecycle.session_start";
}

function isSessionEndEvent(event: SomaMemoryEvent): boolean {
  return event.kind === "lifecycle.session_end" || event.kind.startsWith("lifecycle.session_end.");
}

function recordSessionEvent(event: SomaMemoryEvent, sessions: SessionAggregationState): void {
  if (isSessionStartEvent(event)) {
    sessions.started += 1;
    ensureSessionStats(sessions.bySubstrate, event.substrate).started += 1;
    const sessionId = eventSessionId(event);
    const startedAt = timestampMs(event.timestamp);
    if (sessionId !== undefined && startedAt !== undefined) {
      sessions.starts.set(`${event.substrate}\0${sessionId}`, startedAt);
    }
  }

  if (isSessionEndEvent(event)) {
    sessions.ended += 1;
    const substrateStats = ensureSessionStats(sessions.bySubstrate, event.substrate);
    substrateStats.ended += 1;
    const sessionId = eventSessionId(event);
    const endedAt = timestampMs(event.timestamp);
    const sessionKey = sessionId === undefined ? undefined : `${event.substrate}\0${sessionId}`;
    const startedAt = sessionKey === undefined ? undefined : sessions.starts.get(sessionKey);
    if (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt) {
      const duration = endedAt - startedAt;
      recordDuration(sessions.totalDurations, duration);
      recordDuration(substrateStats.durations, duration);
      if (sessionKey !== undefined) {
        sessions.starts.delete(sessionKey);
      }
    }
  }
}

function recordSkillEvent(event: SomaMemoryEvent, skillByName: Record<string, number>): boolean {
  const skillName = eventSkillName(event);
  if (!event.kind.includes("skill") && skillName === undefined) return false;
  if (skillName !== undefined) {
    incrementRecord(skillByName, skillName);
  }
  return true;
}

function recordAlgorithmEvent(event: SomaMemoryEvent, algorithmByPhase: Partial<Record<AlgorithmPhase, number>>): boolean {
  if (!event.kind.includes("algorithm")) return false;
  const phase = eventPhase(event);
  if (phase !== undefined) {
    increment(algorithmByPhase, phase);
  }
  return true;
}

function isWritebackEvent(event: SomaMemoryEvent): boolean {
  return event.kind.includes("writeback") || event.kind.endsWith(".failed") || event.kind.includes("registry-write");
}

function isWritebackFailureEvent(event: SomaMemoryEvent): boolean {
  return event.kind.endsWith(".failed") || event.kind.includes("failed");
}

export async function summarizeSomaTelemetry(options: SomaTelemetrySummaryOptions = {}): Promise<SomaTelemetrySummary> {
  const somaHome = resolveSomaHome(options);
  const bySubstrate: Partial<Record<SubstrateId, number>> = {};
  const byKind: Record<string, number> = {};
  const algorithmByPhase: Partial<Record<AlgorithmPhase, number>> = {};
  const skillByName: Record<string, number> = {};
  const sessions: SessionAggregationState = {
    starts: new Map<string, number>(),
    bySubstrate: {},
    totalDurations: { count: 0, totalMs: 0 },
    started: 0,
    ended: 0,
  };
  let skillEventCount = 0;
  let algorithmEventCount = 0;
  let writebackEventCount = 0;
  let writebackFailureCount = 0;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  const read = await streamTelemetryEvents(somaHome, (event) => {
    firstTimestamp ??= event.timestamp;
    lastTimestamp = event.timestamp;
    increment(bySubstrate, event.substrate);
    incrementRecord(byKind, event.kind);

    recordSessionEvent(event, sessions);
    if (recordSkillEvent(event, skillByName)) {
      skillEventCount += 1;
    }
    if (recordAlgorithmEvent(event, algorithmByPhase)) {
      algorithmEventCount += 1;
    }
    if (isWritebackEvent(event)) {
      writebackEventCount += 1;
      if (isWritebackFailureEvent(event)) {
        writebackFailureCount += 1;
      }
    }
  });

  return {
    somaHome,
    eventPath: read.eventPath,
    totalEvents: read.totalEvents,
    skippedMalformedLines: read.skippedMalformedLines,
    firstTimestamp,
    lastTimestamp,
    bySubstrate,
    byKind,
    sessions: {
      started: sessions.started,
      ended: sessions.ended,
      completedWithDuration: sessions.totalDurations.count,
      averageDurationMs: averageDuration(sessions.totalDurations),
      bySubstrate: publicSessionStats(sessions.bySubstrate),
    },
    skills: {
      events: skillEventCount,
      byName: skillByName,
    },
    algorithm: {
      events: algorithmEventCount,
      byPhase: algorithmByPhase,
    },
    writeback: {
      events: writebackEventCount,
      failures: writebackFailureCount,
    },
  };
}
