/**
 * The generative half of the meta-reflection layer (#333): turn accumulated
 * per-run meta-reflections into a ranked improvement backlog.
 *
 * Design (steered with JC): **gates rank, prose enriches.** Each category maps,
 * where possible, to a real enforced Soma gate. The deterministic `gatesFired`
 * flags drive the ranking — a gate recurrently unmet across runs is the
 * empirical case for a runner/prompt fix. P2 / #331 is the proof of the SIGNAL:
 * it was found by a manual 188-run dig (this digest did not exist yet), and this
 * digest re-surfaces that same recurring signal automatically over the corpus.
 * The free-text `smarterRun` q-signals are keyword-bucketed into the
 * same categories to ENRICH each entry with human-readable evidence, but they do
 * not by themselves outrank a real gate-miss.
 *
 * SCOPE of "deterministic": the gate-miss spine is deterministic over the set of
 * recorded meta-reflections — it is NOT a census of all runs. A meta-reflection
 * requires at least one `smarterRun` signal by construction (the recorder rejects
 * an empty one; the importer skips a prose-less record), so a run whose gate was
 * missed but which produced no reflection contributes nothing. The digest ranks
 * the signal the agent chose to record, not every gate event that ever occurred.
 *
 * Pure module — no IO. The CLI collects reflections (live runs + imported PAI
 * corpus) and renders the result.
 */
import type { AlgorithmGatesFired, AlgorithmMetaReflection, AlgorithmPhase } from "./types";

// A gate-flag is only a MISS if the run reached the phase where that gate is
// enforced — otherwise a `false` flag just means "not there yet", not "failed".
// Without this, an early-phase reflection (everything still `false`) would flood
// the backlog with phantom misses. Each gate maps to the phase it guards entry to.
const GATE_ENFORCED_AT: Record<keyof AlgorithmGatesFired, AlgorithmPhase> = {
  currentStateFloor: "think", // OBSERVE→THINK floor (#331)
  learnGateClean: "learn", // →LEARN evidence gate (#330)
  completeness: "learn", // →LEARN: every criterion resolved
};
// The linear progress axis only — `abandoned` is deliberately ABSENT. It is a
// terminal status orthogonal to progress (a run can abandon at any phase), so it
// must not read as "past everything". An abandoned-phase reflection therefore
// resolves to index -1 below and counts no gate as reached — we cannot claim an
// abandoned run reached a gate it may have abandoned before.
const PHASE_ORDER: AlgorithmPhase[] = ["observe", "think", "plan", "build", "execute", "verify", "learn", "complete"];
function gateReached(reflectionPhase: AlgorithmPhase, gate: keyof AlgorithmGatesFired): boolean {
  const phaseIndex = PHASE_ORDER.indexOf(reflectionPhase);
  return phaseIndex >= 0 && phaseIndex >= PHASE_ORDER.indexOf(GATE_ENFORCED_AT[gate]);
}

export type ReflectionCategoryKey =
  | "current-state"
  | "verification"
  | "completeness"
  | "parallelization"
  | "other";

interface CategoryDefinition {
  key: ReflectionCategoryKey;
  label: string;
  /** The Soma gate this category maps to, if any. Categories with no gate are pure-prose signal classes (no enforcement exists yet — candidate future gates). */
  gate?: keyof AlgorithmGatesFired;
  keywords: string[];
}

// Order matters: a signal is bucketed into the FIRST category whose keywords
// match, so the gate-backed categories are listed before the gateless ones.
//
// The keyword lists are seeded from observed reflection phrasings and WILL be
// incomplete. Gate-miss count is the PRIMARY sort key, so a gateless prose bucket
// can never outrank a real gate-miss; signal count is only a TIE-BREAKER between
// categories with equal gate-miss counts. So overfit/incomplete keywords can
// reorder gate-tied peers, but cannot lift a category above one with more
// gate-misses. Grow the keywords as new phrasings appear.
const CATEGORIES: CategoryDefinition[] = [
  {
    key: "current-state",
    label: "Current-state verification (gate: OBSERVE floor, #331)",
    gate: "currentStateFloor",
    keywords: ["current state", "current-state", "current assumption", "existence", "exist", "exists", "probe", "verify all", "verified all", "before asking", "before interview", "before proceeding", "n_by field", "signed_by", "field existence", "zero-traffic", "traffic"],
  },
  {
    key: "verification",
    label: "Verification / evidence (gate: LEARN evidence, #330)",
    gate: "learnGateClean",
    keywords: ["verification doctrine", "isc evidence", "concrete evidence", "evidence", "verify", "proof", "confirm", "tested", "test the"],
  },
  {
    key: "completeness",
    label: "Completeness (gate: every criterion resolved)",
    gate: "completeness",
    keywords: ["completeness", "all criteria", "unresolved", "incomplete", "missed criterion", "finish"],
  },
  {
    key: "parallelization",
    label: "Parallelization / sequencing (no gate yet)",
    keywords: ["parallel", "sequential", "concurrent", "launch", "in parallel", "first wave", "earlier"],
  },
];

const OTHER: Pick<CategoryDefinition, "key" | "label"> = { key: "other", label: "Other (no gate yet)" };

export interface ReflectionDigestEntry {
  category: ReflectionCategoryKey;
  label: string;
  gate?: keyof AlgorithmGatesFired;
  /** Reflections that REACHED this gate's enforcement phase but did not satisfy it. The deterministic ranking spine. 0 for gateless categories. */
  gateMissCount: number;
  /** Free-text q-signals bucketed into this category. Enrichment. */
  signalCount: number;
  /** Distinct runs contributing a gate-miss or a signal here. */
  runCount: number;
  /** Up to {@link EXAMPLE_LIMIT} representative q-signals. */
  examples: string[];
}

export interface ReflectionForDigest {
  runId: string;
  reflection: AlgorithmMetaReflection;
}

/**
 * Trim and drop empty signals to build a compact `smarterRun`. Single source of
 * truth for that shape — shared by the recorder, the CLI, and the PAI importer so
 * the three cannot drift.
 */
export function compactSmarterRun(input: {
  missedEarlyStep?: string;
  missedVerifyOrParallel?: string;
  highestValueMove?: string;
}): AlgorithmMetaReflection["smarterRun"] {
  const trim = (s?: string): string | undefined => (s !== undefined && s.trim().length > 0 ? s.trim() : undefined);
  const missedEarlyStep = trim(input.missedEarlyStep);
  const missedVerifyOrParallel = trim(input.missedVerifyOrParallel);
  const highestValueMove = trim(input.highestValueMove);
  return {
    ...(missedEarlyStep ? { missedEarlyStep } : {}),
    ...(missedVerifyOrParallel ? { missedVerifyOrParallel } : {}),
    ...(highestValueMove ? { highestValueMove } : {}),
  };
}

const EXAMPLE_LIMIT = 3;

function bucketSignal(text: string): ReflectionCategoryKey {
  const lower = text.toLowerCase();
  for (const category of CATEGORIES) {
    if (category.keywords.some((kw) => lower.includes(kw))) return category.key;
  }
  return "other";
}

function signalsOf(reflection: AlgorithmMetaReflection): string[] {
  const { missedEarlyStep, missedVerifyOrParallel, highestValueMove } = reflection.smarterRun;
  return [missedEarlyStep, missedVerifyOrParallel, highestValueMove].filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

/**
 * Build the ranked digest. Sort order: gate-miss count first (gates rank), then
 * signal count, then label — so a category backed by a recurrently-unmet gate
 * always outranks a louder but gateless prose cluster.
 */
export function buildReflectionDigest(reflections: readonly ReflectionForDigest[]): ReflectionDigestEntry[] {
  const acc = new Map<ReflectionCategoryKey, { gateMissRuns: Set<string>; runs: Set<string>; signalCount: number; examples: string[] }>();
  const ensure = (key: ReflectionCategoryKey) => {
    let entry = acc.get(key);
    if (!entry) {
      entry = { gateMissRuns: new Set(), runs: new Set(), signalCount: 0, examples: [] };
      acc.set(key, entry);
    }
    return entry;
  };

  for (const { runId, reflection } of reflections) {
    // Deterministic spine: a gate counts as missed only if the run REACHED the
    // gate's enforcement phase and still did not satisfy it (false ≠ not-reached).
    for (const category of CATEGORIES) {
      if (category.gate && gateReached(reflection.phase, category.gate) && !reflection.gatesFired[category.gate]) {
        const e = ensure(category.key);
        e.gateMissRuns.add(runId);
        e.runs.add(runId);
      }
    }
    // Prose enrichment: bucket each q-signal.
    for (const signal of signalsOf(reflection)) {
      const e = ensure(bucketSignal(signal));
      e.signalCount += 1;
      e.runs.add(runId);
      if (e.examples.length < EXAMPLE_LIMIT) e.examples.push(signal);
    }
  }

  const labelOf = (key: ReflectionCategoryKey): { label: string; gate?: keyof AlgorithmGatesFired } => {
    const def = CATEGORIES.find((c) => c.key === key);
    return def ? { label: def.label, gate: def.gate } : { label: OTHER.label };
  };

  return [...acc.entries()]
    .map(([category, e]): ReflectionDigestEntry => {
      const { label, gate } = labelOf(category);
      return {
        category,
        label,
        ...(gate ? { gate } : {}),
        gateMissCount: e.gateMissRuns.size,
        signalCount: e.signalCount,
        runCount: e.runs.size,
        examples: e.examples,
      };
    })
    .sort((a, b) => b.gateMissCount - a.gateMissCount || b.signalCount - a.signalCount || a.label.localeCompare(b.label));
}

/** Render the digest as human-readable text for the CLI. */
export function renderReflectionDigest(entries: readonly ReflectionDigestEntry[]): string {
  if (entries.length === 0) return "No meta-reflections found.";
  const lines = ["Algorithm meta-reflection digest — most-repeated 'a smarter run would have…' signals:", ""];
  entries.forEach((e, i) => {
    const gateNote = e.gate ? `gate-miss ×${e.gateMissCount}` : "no gate yet";
    lines.push(`${i + 1}. ${e.label} — ${gateNote}, ${e.signalCount} signal(s) across ${e.runCount} run(s)`);
    for (const ex of e.examples) lines.push(`   • ${ex}`);
  });
  return lines.join("\n");
}
