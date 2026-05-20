export interface AlgorithmRunSnapshotSeenPhase {
  readonly marker: {
    readonly phase: string;
    readonly position: number;
    readonly total: number;
    readonly lineIndex: number;
    readonly rawLine: string;
  };
  readonly body: string[];
}

export interface AlgorithmRunSnapshotState {
  readonly runId: string;
  readonly carry: string;
  readonly lineCount: number;
  readonly lastSnapshotLength: number;
  readonly seenPhases: readonly AlgorithmRunSnapshotSeenPhase[];
  readonly currentPhase?: string;
  readonly isaCriteria: readonly unknown[];
}

export interface AlgorithmRunSnapshot extends AlgorithmRunSnapshotState {
  readonly schemaVersion: 1;
  readonly reason: string;
  readonly timestamp: string;
}

export function snapshotAlgorithmRunState(run: AlgorithmRunSnapshotState, reason: string): AlgorithmRunSnapshot {
  return {
    schemaVersion: 1,
    runId: run.runId,
    carry: run.carry,
    lineCount: run.lineCount,
    lastSnapshotLength: run.lastSnapshotLength,
    seenPhases: run.seenPhases.map((seen) => ({ marker: seen.marker, body: [...seen.body] })),
    currentPhase: run.currentPhase,
    isaCriteria: [...run.isaCriteria],
    reason,
    timestamp: new Date().toISOString(),
  };
}

export function hydrateAlgorithmRunSnapshot(snapshot: unknown): AlgorithmRunSnapshotState | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const s = snapshot as Partial<AlgorithmRunSnapshot>;
  if (s.schemaVersion !== 1) return undefined;
  if (typeof s.runId !== "string" || !Array.isArray(s.seenPhases)) return undefined;
  return {
    runId: s.runId,
    carry: typeof s.carry === "string" ? s.carry : "",
    lineCount: typeof s.lineCount === "number" ? s.lineCount : 0,
    lastSnapshotLength: typeof s.lastSnapshotLength === "number" ? s.lastSnapshotLength : 0,
    seenPhases: s.seenPhases
      .filter(isAlgorithmRunSnapshotSeenPhase)
      .map((seen) => ({ marker: seen.marker, body: [...seen.body] })),
    currentPhase: typeof s.currentPhase === "string" ? s.currentPhase : undefined,
    isaCriteria: Array.isArray(s.isaCriteria) ? s.isaCriteria : [],
  };
}

export function isAlgorithmRunSnapshotComplete(run: { readonly currentPhase?: string }): boolean {
  return run.currentPhase === "summary";
}

function isAlgorithmRunSnapshotSeenPhase(seen: unknown): seen is AlgorithmRunSnapshotSeenPhase {
  if (!seen || typeof seen !== "object") return false;
  const candidate = seen as { marker?: unknown; body?: unknown };
  if (!candidate.marker || typeof candidate.marker !== "object" || !Array.isArray(candidate.body)) return false;
  const marker = candidate.marker as { phase?: unknown; position?: unknown; total?: unknown; lineIndex?: unknown; rawLine?: unknown };
  return (
    typeof marker.phase === "string" &&
    typeof marker.position === "number" &&
    typeof marker.total === "number" &&
    typeof marker.lineIndex === "number" &&
    typeof marker.rawLine === "string"
  );
}
