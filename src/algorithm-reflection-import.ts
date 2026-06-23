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
import { compactSmarterRun, type ReflectionForDigest } from "./algorithm-reflection-digest";

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

/**
 * Map a PAI record's gate signals onto Soma's gates. IMPORTANT: unlike a live
 * reflection — whose `gatesFired` is computed by `computeGatesFired` from real run
 * state — an imported record's flags are a documented, LOSSY best-effort mapping
 * from PAI's `doctrine_fired`. PAI predates #330/#331 and has no Soma run to probe,
 * so this is a historical reconstruction, not the same-predicate computation. The
 * digest reads both uniformly; the distinction is that imported flags are
 * caller-asserted history, not re-derived facts.
 *
 * Mapping decisions, kept honest rather than convenient:
 * - `currentStateFloor` ← PAI's `live_probe` (a genuine current-state-probe signal).
 * - `completeness` ← PAI's criteria counts (all passed, none failed) — independent
 *   of PAI's own `completeness_gate_met`, which we do NOT trust as a count.
 * - `learnGateClean` ← **`true`, always.** #330's evidence-kind gate did not exist
 *   in PAI; nothing in a PAI record speaks to it. We therefore decline to attribute
 *   a #330 miss to history that never measured one (filling it from PAI's unrelated
 *   `completeness_gate_met` would conflate two different gates and inflate the
 *   verification bucket). Imported records simply never count as a learn-gate miss.
 */
function gatesFromPai(record: PaiReflectionRecord): AlgorithmGatesFired {
  const doctrine = (record.doctrine_fired && typeof record.doctrine_fired === "object" ? record.doctrine_fired : {}) as {
    live_probe?: unknown;
  };
  const count = num(record.criteria_count);
  const passed = num(record.criteria_passed);
  const failed = num(record.criteria_failed);
  return {
    // Only an EXPLICIT `live_probe: false` is a current-state miss. An ABSENT
    // field is unknown, not a miss — scoring absence as a miss would manufacture
    // misses (and could fabricate the headline P2 result) from records that never
    // carried the signal. Absent/true → not-a-miss (the conservative default,
    // matching the learnGateClean decision above).
    currentStateFloor: doctrine.live_probe !== false,
    learnGateClean: true,
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
    const smarterRun = compactSmarterRun({
      missedEarlyStep: str(record.reflection_q1),
      missedVerifyOrParallel: str(record.reflection_q2),
      highestValueMove: str(record.reflection_q3),
    });
    // A record with no q-signals carries no improvement signal — skip.
    if (Object.keys(smarterRun).length === 0) continue;

    const satisfaction = num(record.satisfaction_prediction);
    // PAI reflections are END-OF-RUN artifacts — they only fired with final
    // criteria counts (+ satisfaction/budget) attached. A record carrying those
    // completion signals genuinely reached its terminal gates, so reconstructing
    // it at `learn` reflects real terminal state, not a fabricated reach. A record
    // WITHOUT completion evidence can't be placed on the gate axis, so it falls
    // back to `observe` (reaches no gate, contributes no gate-miss).
    const phase: AlgorithmMetaReflection["phase"] = num(record.criteria_count) !== undefined ? "learn" : "observe";
    const reflection: AlgorithmMetaReflection = {
      timestamp: str(record.timestamp) ?? "",
      phase,
      gatesFired: gatesFromPai(record),
      smarterRun,
      ...(satisfaction !== undefined ? { satisfaction } : {}),
      ...(typeof record.within_budget === "boolean" ? { withinBudget: record.within_budget } : {}),
    };
    out.push({ runId, reflection });
  }
  return out;
}
