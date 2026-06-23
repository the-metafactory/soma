/**
 * One-time importer for PAI's historical meta-reflection corpus
 * (`~/.soma/memory/LEARNING/REFLECTIONS/algorithm-reflections.jsonl`), the layer
 * that ended at the PAI→Soma boundary (2026-05-07) and was never ported. Feeds
 * the digest so the recurring-signal surfacing (#333 acceptance) can be
 * demonstrated on the real corpus — where "verify current-state assumptions
 * before proceeding" recurs and surfaces P2 (#331).
 *
 * Pure parse over the jsonl content (the CLI reads the file). Malformed lines are
 * skipped, not fatal — the corpus is a historical artifact, not a contract.
 */
import type { AlgorithmGatesFired, AlgorithmMetaReflection } from "./types";
import type { ReflectionForDigest } from "./algorithm-reflection-digest";

interface PaiReflectionRecord {
  timestamp?: unknown;
  prd_id?: unknown;
  reflection_q1?: unknown;
  reflection_q2?: unknown;
  reflection_q3?: unknown;
  satisfaction_prediction?: unknown;
  within_budget?: unknown;
  criteria_count?: unknown;
  criteria_passed?: unknown;
  criteria_failed?: unknown;
  doctrine_fired?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean {
  return value === true;
}

/**
 * Map a PAI record's gate signals onto Soma's gates. The mapping is documented
 * and lossy — PAI predates #330, so `learnGateClean` borrows PAI's nearest
 * "gate clean" signal (`completeness_gate_met`) rather than inventing evidence
 * data that never existed.
 */
function gatesFromPai(record: PaiReflectionRecord): AlgorithmGatesFired {
  const doctrine = (record.doctrine_fired && typeof record.doctrine_fired === "object" ? record.doctrine_fired : {}) as {
    live_probe?: unknown;
    completeness_gate_met?: unknown;
  };
  const count = num(record.criteria_count);
  const passed = num(record.criteria_passed);
  const failed = num(record.criteria_failed);
  return {
    currentStateFloor: bool(doctrine.live_probe),
    learnGateClean: bool(doctrine.completeness_gate_met),
    completeness: count !== undefined && count > 0 && passed === count && (failed ?? 0) === 0,
  };
}

/** Parse PAI reflection jsonl content into digest-ready reflections. */
export function parsePaiReflections(jsonl: string): ReflectionForDigest[] {
  const out: ReflectionForDigest[] = [];
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let record: PaiReflectionRecord;
    try {
      record = JSON.parse(line) as PaiReflectionRecord;
    } catch {
      continue; // skip malformed line
    }
    const runId = str(record.prd_id) ?? `pai-reflection-${out.length}`;
    const smarterRun: AlgorithmMetaReflection["smarterRun"] = {
      ...(str(record.reflection_q1) ? { missedEarlyStep: str(record.reflection_q1) } : {}),
      ...(str(record.reflection_q2) ? { missedVerifyOrParallel: str(record.reflection_q2) } : {}),
      ...(str(record.reflection_q3) ? { highestValueMove: str(record.reflection_q3) } : {}),
    };
    // A record with no q-signals carries no improvement signal — skip.
    if (Object.keys(smarterRun).length === 0) continue;

    const satisfaction = num(record.satisfaction_prediction);
    const reflection: AlgorithmMetaReflection = {
      timestamp: str(record.timestamp) ?? "",
      phase: "learn",
      gatesFired: gatesFromPai(record),
      smarterRun,
      ...(satisfaction !== undefined ? { satisfaction } : {}),
      ...(typeof record.within_budget === "boolean" ? { withinBudget: record.within_budget } : {}),
    };
    out.push({ runId, reflection });
  }
  return out;
}
