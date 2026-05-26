import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

async function readTelemetryEvents(somaHome: string): Promise<{
  eventPath: string;
  events: SomaMemoryEvent[];
  skippedMalformedLines: number;
}> {
  const eventPath = somaMemoryEventsPath(somaHome);
  const content = await readFile(eventPath, "utf8").catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") return "";
    throw error;
  });
  const events: SomaMemoryEvent[] = [];
  let skippedMalformedLines = 0;

  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;

    try {
      const event = JSON.parse(line) as unknown;
      if (!isSomaMemoryEvent(event)) {
        skippedMalformedLines += 1;
        continue;
      }
      events.push(event);
    } catch {
      skippedMalformedLines += 1;
    }
  }

  return { eventPath, events, skippedMalformedLines };
}

function applyTelemetryFilters(events: SomaMemoryEvent[], options: SomaTelemetryQueryOptions): SomaMemoryEvent[] {
  return events.filter((event) => {
    if (options.substrate !== undefined && event.substrate !== options.substrate) return false;
    if (options.kind !== undefined && event.kind !== options.kind) return false;
    return true;
  });
}

function recentEvents(events: SomaMemoryEvent[], limit: number | undefined): SomaMemoryEvent[] {
  const boundedLimit = limit ?? 20;
  if (boundedLimit < 1) {
    throw new Error("Soma telemetry limit must be a positive integer.");
  }

  return events.slice(-boundedLimit).reverse();
}

export async function querySomaTelemetryEvents(options: SomaTelemetryQueryOptions = {}): Promise<SomaTelemetryQueryResult> {
  const somaHome = resolveSomaHome(options);
  const read = await readTelemetryEvents(somaHome);
  const filtered = applyTelemetryFilters(read.events, options);

  return {
    somaHome,
    eventPath: read.eventPath,
    totalEvents: read.events.length,
    skippedMalformedLines: read.skippedMalformedLines,
    events: recentEvents(filtered, options.limit),
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

function averageDuration(durations: number[]): number | null {
  return durations.length > 0
    ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
    : null;
}

interface MutableSessionStats {
  started: number;
  ended: number;
  durations: number[];
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
    durations: [],
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
      completedWithDuration: value.durations.length,
      averageDurationMs: averageDuration(value.durations),
    };
  }
  return result;
}

export async function summarizeSomaTelemetry(options: SomaTelemetrySummaryOptions = {}): Promise<SomaTelemetrySummary> {
  const somaHome = resolveSomaHome(options);
  const read = await readTelemetryEvents(somaHome);
  const bySubstrate: Partial<Record<SubstrateId, number>> = {};
  const byKind: Record<string, number> = {};
  const algorithmByPhase: Partial<Record<AlgorithmPhase, number>> = {};
  const skillByName: Record<string, number> = {};
  const sessionStarts = new Map<string, number>();
  const sessionStatsBySubstrate: Partial<Record<SubstrateId, MutableSessionStats>> = {};
  const durations: number[] = [];
  let sessionStartCount = 0;
  let sessionEndCount = 0;
  let skillEventCount = 0;
  let algorithmEventCount = 0;
  let writebackEventCount = 0;
  let writebackFailureCount = 0;

  for (const event of read.events) {
    increment(bySubstrate, event.substrate);
    incrementRecord(byKind, event.kind);

    if (event.kind === "lifecycle.session_start") {
      sessionStartCount += 1;
      ensureSessionStats(sessionStatsBySubstrate, event.substrate).started += 1;
      const sessionId = eventSessionId(event);
      const startedAt = timestampMs(event.timestamp);
      if (sessionId !== undefined && startedAt !== undefined) {
        sessionStarts.set(`${event.substrate}\0${sessionId}`, startedAt);
      }
    }

    if (event.kind === "lifecycle.session_end") {
      sessionEndCount += 1;
      const substrateStats = ensureSessionStats(sessionStatsBySubstrate, event.substrate);
      substrateStats.ended += 1;
      const sessionId = eventSessionId(event);
      const endedAt = timestampMs(event.timestamp);
      const startedAt = sessionId === undefined ? undefined : sessionStarts.get(`${event.substrate}\0${sessionId}`);
      if (startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt) {
        const duration = endedAt - startedAt;
        durations.push(duration);
        substrateStats.durations.push(duration);
      }
    }

    const skillName = eventSkillName(event);
    if (event.kind.includes("skill") || skillName !== undefined) {
      skillEventCount += 1;
      if (skillName !== undefined) {
        incrementRecord(skillByName, skillName);
      }
    }

    if (event.kind.includes("algorithm")) {
      algorithmEventCount += 1;
      const phase = eventPhase(event);
      if (phase !== undefined) {
        increment(algorithmByPhase, phase);
      }
    }

    if (event.kind.includes("writeback") || event.kind.endsWith(".failed") || event.kind.includes("registry-write")) {
      writebackEventCount += 1;
      if (event.kind.endsWith(".failed") || event.kind.includes("failed")) {
        writebackFailureCount += 1;
      }
    }
  }

  return {
    somaHome,
    eventPath: read.eventPath,
    totalEvents: read.events.length,
    skippedMalformedLines: read.skippedMalformedLines,
    firstTimestamp: read.events[0]?.timestamp,
    lastTimestamp: read.events.at(-1)?.timestamp,
    bySubstrate,
    byKind,
    sessions: {
      started: sessionStartCount,
      ended: sessionEndCount,
      completedWithDuration: durations.length,
      averageDurationMs: averageDuration(durations),
      bySubstrate: publicSessionStats(sessionStatsBySubstrate),
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
