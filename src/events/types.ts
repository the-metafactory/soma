import type { AlgorithmPhase, SubstrateId } from "../types";

export interface SomaMemoryEventInput {
  id?: string;
  timestamp?: string;
  substrate: SubstrateId;
  kind: string;
  summary: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface SomaMemoryEvent {
  id: string;
  timestamp: string;
  substrate: SubstrateId;
  kind: string;
  summary: string;
  artifactPaths?: string[];
  metadata?: Record<string, unknown>;
}

export interface SomaTelemetryQueryOptions {
  homeDir?: string;
  somaHome?: string;
  substrate?: SubstrateId;
  kind?: string;
  limit?: number;
}

export interface SomaTelemetryQueryResult {
  somaHome: string;
  eventPath: string;
  totalEvents: number;
  skippedMalformedLines: number;
  events: SomaMemoryEvent[];
}

export interface SomaTelemetrySummaryOptions {
  homeDir?: string;
  somaHome?: string;
}

export interface SomaTelemetrySummary {
  somaHome: string;
  eventPath: string;
  totalEvents: number;
  skippedMalformedLines: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  bySubstrate: Partial<Record<SubstrateId, number>>;
  byKind: Record<string, number>;
  sessions: {
    started: number;
    ended: number;
    completedWithDuration: number;
    averageDurationMs: number | null;
    bySubstrate: Partial<Record<SubstrateId, {
      started: number;
      ended: number;
      completedWithDuration: number;
      averageDurationMs: number | null;
    }>>;
  };
  skills: {
    events: number;
    byName: Record<string, number>;
  };
  algorithm: {
    events: number;
    byPhase: Partial<Record<AlgorithmPhase, number>>;
  };
  writeback: {
    events: number;
    failures: number;
  };
}

export type SomaFeedbackKind = "correction" | "missed-surface" | "preference" | "relationship-note" | "task-learning" | "none";

export interface SomaFeedbackClassification {
  kind: SomaFeedbackKind;
  confidence: "low" | "medium" | "high";
  reason: string;
}

export type SomaFeedbackActor = "interactive" | "sdk" | "automated";
