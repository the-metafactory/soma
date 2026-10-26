import { z } from "zod";
import type { GoalRecord } from "../src/goal-records";

export const DEFAULT_VIGIL_URL = "http://127.0.0.1:8767/api/vigil/subjects";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 3000;
const CLOCK_SKEW_MS = 60_000;
const measurementSchema = z.enum(["on-track", "at-risk", "off-track"]);
type MeasurementState = z.infer<typeof measurementSchema>;
// Pinned local copy of Vigil's subjects contract; import it from Vigil's package before this leaves prototype.
const subjectSchema = z.object({
  subjectKey: z.string().min(1),
  kind: z.enum(["run", "state"]),
  vocab: z.string().nullable(),
  ref: z.string(),
  goalId: z.string().nullable(),
  value: z.string().min(1),
  lastRunId: z.string().min(1),
  lastEndedAt: z.number().int().positive().max(8_640_000_000_000_000),
  expectedBy: z.number().int().positive().max(8_640_000_000_000_000).nullable(),
});
type Subject = z.infer<typeof subjectSchema>;
const sourceSchema = z.object({ enabled: z.boolean().optional(), subjects: z.array(subjectSchema) });

export interface SensorSourceOptions {
  vigilUrl?: string;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  now?: () => Date;
}

export interface SensorSource {
  status: "available" | "unavailable" | "disabled" | "not-connected";
  message?: string;
  checkedAt: string;
  subjects: Subject[];
}

export interface DashboardSensorReading {
  status: "measured" | "failed" | "stale" | "unknown" | "no-reading" | "not-configured" | "unavailable";
  state?: MeasurementState;
  observedAt?: string;
  expectedBy?: string;
  runId?: string;
  runOutcome?: string;
  overdue?: boolean;
  freshnessKnown?: boolean;
  message?: string;
  previous?: { state: MeasurementState; observedAt: string; runId: string };
}

export function validateVigilUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/api/vigil/subjects") {
    throw new Error("Vigil URL must be a numeric loopback HTTP /api/vigil/subjects URL without credentials or query parameters.");
  }
  return url;
}

/** GET only; no imports from Cortex internals, bus writes or sensor execution. */
export async function readSensorSource(options: SensorSourceOptions = {}): Promise<SensorSource> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  if (!options.vigilUrl) return { status: "not-connected", checkedAt, subjects: [], message: "No Vigil source connected." };
  const url = validateVigilUrl(options.vigilUrl);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { status: "unavailable", checkedAt, subjects: [], message: timeout ? "Vigil request timed out." : "Could not reach local Vigil." };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { status: "unavailable", checkedAt, subjects: [], message: `Vigil returned HTTP ${response.status}.` };
  }
  try {
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Vigil response exceeds size limit.");
    if (!response.body) throw new Error("Vigil response has no body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) throw new Error("Vigil response exceeds size limit.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const content = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length; }
    const source = sourceSchema.parse(JSON.parse(new TextDecoder().decode(content)) as unknown);
    if (source.enabled === false) return { status: "disabled", checkedAt, subjects: [], message: "Vigil is disabled." };
    const now = Date.parse(checkedAt);
    const keys = new Set<string>();
    for (const subject of source.subjects) {
      if (subject.lastEndedAt > now + CLOCK_SKEW_MS) throw new Error("Vigil observation is in the future.");
      if (subject.expectedBy !== null && subject.expectedBy <= subject.lastEndedAt) throw new Error("Invalid Vigil cadence.");
      if (keys.has(subject.subjectKey)) throw new Error("Duplicate Vigil subjects.");
      keys.add(subject.subjectKey);
    }
    return { status: "available", checkedAt, subjects: source.subjects };
  } catch (error) {
    // Never expose parser diagnostics, which may quote other private subjects.
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { status: "unavailable", checkedAt, subjects: [], message: timeout ? "Vigil response timed out." : "Vigil returned invalid or incomplete sensor data." };
  }
}

function freshness(subject: Subject, now: number) {
  const cadence = subject.expectedBy === null ? undefined : subject.expectedBy - subject.lastEndedAt;
  return {
    stale: subject.value === "stale" || (cadence !== undefined && now - subject.lastEndedAt > 2 * cadence),
    overdue: subject.expectedBy !== null && now > subject.expectedBy,
    freshnessKnown: cadence !== undefined,
  };
}

export function sensorReading(goal: Pick<GoalRecord, "id" | "sensor">, source: SensorSource): DashboardSensorReading {
  if (!goal.sensor) return { status: "not-configured", message: "No sensor configured." };
  if (source.status !== "available") return { status: "unavailable", message: source.message };
  const state = source.subjects.find((row) => row.subjectKey === `state:goal:${goal.id}`
    && row.kind === "state" && row.vocab === "goal" && row.ref === goal.id && row.goalId === goal.id);
  const run = source.subjects.find((row) => row.subjectKey === `run:job:goal-sense/${goal.id}`
    && row.kind === "run" && row.ref === `goal-sense/${goal.id}` && row.goalId === goal.id);
  if (!run && !state) return { status: "no-reading", message: "No recorded sensor observation." };
  const now = Date.parse(source.checkedAt);
  const stateValue = measurementSchema.safeParse(state?.value);
  const previous = state && stateValue.success && run && state.lastEndedAt < run.lastEndedAt
    ? { state: stateValue.data, observedAt: new Date(state.lastEndedAt).toISOString(), runId: state.lastRunId } : undefined;
  if (!run) return { status: "unknown", message: "Goal state exists without a matching sensor run." };
  const timing = freshness(run, now);
  const base = {
    observedAt: new Date(run.lastEndedAt).toISOString(), runId: run.lastRunId, runOutcome: run.value,
    ...(run.expectedBy === null ? {} : { expectedBy: new Date(run.expectedBy).toISOString() }),
    overdue: timing.overdue, freshnessKnown: timing.freshnessKnown,
    ...(previous ? { previous } : {}),
  };
  if (run.value !== "succeeded" && run.value !== "stale") {
    return { ...base, status: "failed", message: `Latest sensor run: ${run.value}. No new measurement.` };
  }
  const correlated = state?.lastRunId === run.lastRunId && state.lastEndedAt === run.lastEndedAt;
  if (timing.stale || (correlated && freshness(state, now).stale)) {
    return { ...base, status: "stale", ...(correlated && stateValue.success ? { state: stateValue.data } : {}), message: "Latest observation is stale." };
  }
  if (!correlated || !stateValue.success) {
    return { ...base, status: "unknown", message: "Run completed; no matching goal reading." };
  }
  return { ...base, status: "measured", state: stateValue.data };
}
