/**
 * Harness eval + regression gate.
 *
 * Computes the harness's north-star metrics from live Soma data (algorithm-run
 * corpus + memory event stream) and compares them against a committed baseline.
 *
 *   bun run harness-eval                  # print metrics (trailing window + all-time)
 *   bun run harness-eval --json           # machine-readable output
 *   bun run harness-eval --explain        # include each metric's Goodhart mode + countermeasure
 *   bun run harness-eval --check          # compare window metrics to baseline, exit 1 on regression
 *   bun run harness-eval --write-baseline # capture current window metrics as the new baseline
 *   bun run harness-eval --window 30      # trailing window in days (default 60)
 *
 * The regression gate evaluates the TRAILING WINDOW only: all-time aggregates
 * dilute fresh degradation under months of healthy history, which would defeat
 * the gate's purpose. The baseline lives at scripts/harness-eval-baseline.json
 * and is committed so drift is reviewable in git history.
 */

import { createReadStream, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Data model (duck-typed against the run-corpus schema versions in the wild:
// v1 `isa`, v3 `vsa`; verification entries are "C1: passed. <evidence>" text).
// ---------------------------------------------------------------------------

export interface RunDoc {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  phase?: string;
  isa?: IsaDoc;
  vsa?: IsaDoc;
  verification?: { timestamp?: string; phase?: string; text?: string }[];
  learning?: unknown[];
  planSteps?: unknown[];
}

interface IsaDoc {
  frontmatter?: { phase?: string; verified?: boolean; progress?: string };
  sections?: { name?: string; content?: string }[];
  criteria?: { status?: string }[];
}

export interface EventDoc {
  timestamp?: string;
  kind?: string;
  substrate?: string;
}

export interface HarnessData {
  runs: RunDoc[];
  events: EventDoc[];
  /** "now" for window math — injectable so tests and replays are deterministic. */
  now: Date;
  windowDays: number;
}

export interface MetricResult {
  id: string;
  name: string;
  /** null when the window had too small a sample to say anything. */
  value: number | null;
  unit: "%" | "ratio";
  direction: "higher" | "lower";
  numerator: number;
  denominator: number;
  detail: string;
}

interface MetricSpec {
  id: string;
  name: string;
  unit: "%" | "ratio";
  direction: "higher" | "lower";
  /** Gate skips the metric below this denominator — tiny samples are noise, not signal. */
  minSample: number;
  /** Allowed degradation (in metric units) before --check fails. */
  tolerance: number;
  goodhart: string;
  countermeasure: string;
  compute: (data: HarnessData) => { numerator: number; denominator: number; detail: string };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export function loadRuns(runsDir: string): RunDoc[] {
  const runs: RunDoc[] = [];
  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      runs.push(JSON.parse(readFileSync(join(runsDir, file), "utf8")) as RunDoc);
    } catch {
      // unreadable run files are a doctor concern, not an eval concern
    }
  }
  return runs;
}

/**
 * Stream the append-only event log line by line, retaining ONLY events at or
 * after `sinceMs`. The live log is tens of MiB and grows without bound, but
 * every metric works on a trailing window — so loading and holding the whole
 * history (the previous `readFileSync` + `split`) wasted memory that scales with
 * all-time history, not the window. Streaming bounds peak memory to one line and
 * retention to the window. Events older than the cutoff, and events with an
 * unparseable timestamp, are dropped here — `inWindow()` would drop both anyway,
 * so per-metric results are unchanged; only out-of-window rows never get held.
 */
export async function loadEvents(eventsPath: string, sinceMs = Number.NEGATIVE_INFINITY): Promise<EventDoc[]> {
  const events: EventDoc[] = [];
  const rl = createInterface({ input: createReadStream(eventsPath, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let event: EventDoc;
      try {
        event = JSON.parse(line) as EventDoc;
      } catch {
        continue; // skip torn lines
      }
      if (sinceMs !== Number.NEGATIVE_INFINITY) {
        const t = event.timestamp ? Date.parse(event.timestamp) : Number.NaN;
        if (!Number.isFinite(t) || t < sinceMs) continue; // out of window → never retained
      }
      events.push(event);
    }
  } catch {
    // Missing file or read error: return whatever was collected (empty on ENOENT).
  }
  return events;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function windowStart(data: HarnessData): number {
  return data.now.getTime() - data.windowDays * 24 * 60 * 60 * 1000;
}

function inWindow(data: HarnessData, iso: string | undefined): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= windowStart(data) && t <= data.now.getTime();
}

function runIsaDoc(run: RunDoc): IsaDoc | undefined {
  return run.vsa ?? run.isa;
}

/**
 * Criteria progress derived from criteria STATE (checkbox/status), never from
 * the `phase` field or the `verified` flag: the 2026-07-10 corpus audit showed
 * 118/130 "observe" runs actually had all criteria checked (phase is a dead
 * pointer that measures tracker rot), and the VSA sync path can mint
 * verified:true with enforceGate=false.
 */
export function runCriteriaState(run: RunDoc): { total: number; checked: number } {
  let total = 0;
  let checked = 0;
  const doc = runIsaDoc(run);
  for (const section of doc?.sections ?? []) {
    if (section.name !== "Checkpoints" && section.name !== "Criteria") continue;
    for (const line of (section.content ?? "").split("\n")) {
      const match = /^\s*-\s*\[([ xX])\]/.exec(line);
      if (match) {
        total++;
        if (match[1] !== " ") checked++;
      }
    }
  }
  if (total === 0 && Array.isArray(doc?.criteria)) {
    total = doc.criteria.length;
    checked = doc.criteria.filter((c) => c.status === "passed" || c.status === "checked").length;
  }
  return { total, checked };
}

function runFinished(run: RunDoc): boolean {
  const { total, checked } = runCriteriaState(run);
  return total > 0 && checked === total;
}

/** Criterion texts keyed by id (C1, C2, …) parsed from the Checkpoints/Criteria section. */
export function runCriteria(run: RunDoc): Map<string, string> {
  const criteria = new Map<string, string>();
  const sections = runIsaDoc(run)?.sections ?? [];
  for (const section of sections) {
    if (section.name !== "Checkpoints" && section.name !== "Criteria") continue;
    for (const line of (section.content ?? "").split("\n")) {
      const match = /^\s*-\s*\[[ xX]\]\s*([A-Za-z]+\d*)\s*:\s*(.+)$/.exec(line);
      if (match) criteria.set(match[1], match[2].trim());
    }
  }
  return criteria;
}

const PASSED_VERIFICATION = /^([A-Za-z]+\d*)\s*:\s*passed\.?\s*(.*)$/s;

/**
 * Evidence minted by the VSA→run sync path ("synced from ISA: <criterion>")
 * restates the criterion as its own proof and bypasses the VerificationGate
 * (enforceGate=false). It is bookkeeping, not observation — excluded from the
 * evidence-quality denominator entirely.
 */
const SYNC_MINTED = /synced from ISA:/i;

// An observable artifact must be present: a real path, quoted command/output,
// an exit/test/count statement with numbers, a commit sha, or a URL. A bare
// digit or slash is NOT enough — the 2026-07-10 audit found label-only and
// prose-only evidence passing looser checks.
const PROBE_SIGNATURES = [
  /(?:^|[\s"'`(])[\w.~-]*\/[\w.-]+\/[\w.-]+/, // a path with at least two segments
  /`[^`]+`/, // quoted command or output
  /\b(?:exit(?:\s+code)?|status)\s*[:=]?\s*\d+/i,
  /\b\d+\s*(?:tests?|pass(?:ed|ing)?|fail(?:ed|ures?)?|rows?|lines?|files?|events?|runs?|matches|errors?)\b/i,
  /\b(?:tests?|checks?)\s+(?:pass(?:ed|ing)?|green)\b/i,
  /\b[0-9a-f]{7,40}\b/, // commit sha
  /https?:\/\//,
  /\bHTTP\/?\s*\d{3}\b|\bHTTP\s+\d{3}\b/i,
  /:\d+\b/, // file:line
];

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

/**
 * Evidence is probe-backed when it carries traces of an actual observation
 * (paths, numbers, command output) AND is not a restatement of the criterion.
 * Tautology check: high token overlap with the criterion text means the
 * evidence just repeats the claim back — the top failure mode in the
 * 2026-06-22 corpus analysis.
 */
export function isProbeBacked(evidence: string, criterionText: string | undefined): boolean {
  const trimmed = evidence.trim();
  if (trimmed.length < 20) return false;
  if (!PROBE_SIGNATURES.some((p) => p.test(trimmed))) return false;
  if (criterionText) {
    const evidenceTokens = tokens(trimmed);
    const criterionTokens = tokens(criterionText);
    if (criterionTokens.size > 0 && evidenceTokens.size > 0) {
      let novel = 0;
      for (const t of evidenceTokens) if (!criterionTokens.has(t)) novel++;
      // Tautological when almost every token in the evidence already appears
      // in the criterion — nothing new was observed.
      if (novel / evidenceTokens.size < 0.35) return false;
    }
  }
  return true;
}

const STALL_IDLE_DAYS = 7;

/**
 * Passed-criterion verifications in the window, split by whether the evidence
 * is probe-backed. Sync-minted restatements are excluded (bookkeeping, not
 * observation). Factored out so probe_evidence_rate and hollow_pass_attempt_rate
 * count the same denominator from the same rules.
 */
export function countPassedVerifications(data: HarnessData): { total: number; probeBacked: number } {
  let total = 0;
  let probeBacked = 0;
  for (const run of data.runs) {
    const criteria = runCriteria(run);
    for (const entry of run.verification ?? []) {
      if (!inWindow(data, entry.timestamp)) continue;
      const match = PASSED_VERIFICATION.exec(entry.text ?? "");
      if (!match || SYNC_MINTED.test(match[2])) continue;
      total++;
      if (isProbeBacked(match[2], criteria.get(match[1]))) probeBacked++;
    }
  }
  return { total, probeBacked };
}

// ---------------------------------------------------------------------------
// Metric registry — every entry documents how it can be gamed and what keeps
// that in check. A metric without a Goodhart note does not ship.
// ---------------------------------------------------------------------------

export const METRICS: MetricSpec[] = [
  {
    id: "true_finish_rate",
    name: "True-finish rate (all criteria checked)",
    unit: "%",
    direction: "higher",
    minSample: 5,
    tolerance: 5,
    goodhart:
      "Create fewer/trivial runs so the finishing share looks high, or check boxes without doing the work. Deliberately NOT phase- or verified-flag-based: phase is a dead pointer (118/130 'observe' runs had all criteria checked) and verified:true can be minted by the enforceGate=false sync path.",
    countermeasure:
      "Gate runs alongside abandoned_run_share (fewer real runs shows up there) and probe_evidence_rate (checked boxes without probe-backed evidence drag that metric).",
    compute(data) {
      const runs = data.runs.filter((r) => inWindow(data, r.createdAt));
      const finished = runs.filter(runFinished);
      return {
        numerator: finished.length,
        denominator: runs.length,
        detail: `${finished.length}/${runs.length} runs created in window closed every criterion`,
      };
    },
  },
  {
    id: "probe_evidence_rate",
    name: "Probe-backed evidence rate",
    unit: "%",
    direction: "higher",
    minSample: 10,
    tolerance: 5,
    goodhart:
      "Pad evidence strings with paths and numbers that were never actually observed — the evidenceKind label is caller-asserted (src/types.ts:42) and this text heuristic can be fooled the same way.",
    countermeasure:
      "Heuristic checks novelty vs the criterion text, not just probe tokens; periodic manual audit of a random evidence sample stays in the Memory skill's audit workflow.",
    compute(data) {
      const { total, probeBacked } = countPassedVerifications(data);
      return {
        numerator: probeBacked,
        denominator: total,
        detail: `${probeBacked}/${total} passed-criterion verifications carry probe-backed, non-tautological evidence`,
      };
    },
  },
  {
    id: "hollow_pass_attempt_rate",
    name: "Hollow-pass attempt rate (gate refusals)",
    unit: "%",
    direction: "lower",
    minSample: 10,
    tolerance: 5,
    goodhart:
      "Bypass the harness CLI when verifying so the VerificationGate never fires — no gate_violation event, no numerator, and the hollow pass is recorded as a clean pass instead.",
    countermeasure:
      "Paired with probe_evidence_rate and true_finish_rate: an un-gated hollow pass still lands as low-quality evidence there, and CLI avoidance shrinks this denominator (fewer gate decisions) visibly rather than nudging the rate down.",
    compute(data) {
      const violations = data.events.filter(
        (e) => e.kind === "verification.gate_violation" && inWindow(data, e.timestamp),
      ).length;
      const passed = countPassedVerifications(data).total;
      const denominator = violations + passed;
      return {
        numerator: violations,
        denominator,
        detail: `${violations} gate refusals vs ${passed} passed verifications (${denominator} gate decisions) in window`,
      };
    },
  },
  {
    id: "abandoned_run_share",
    name: "Abandoned-run share (zero criteria closed)",
    unit: "%",
    direction: "lower",
    minSample: 5,
    tolerance: 10,
    goodhart:
      "Check one token criterion on a dead run so it stops counting as abandoned, or bump updatedAt with no-op touches.",
    countermeasure:
      "A token-checked criterion still needs passed-verification evidence to move probe_evidence_rate, and a run rescued this way drags true_finish_rate instead. Measured on criteria STATE, not the phase field, which mislabels finished work.",
    compute(data) {
      const runs = data.runs.filter((r) => inWindow(data, r.createdAt));
      const idleCutoff = data.now.getTime() - STALL_IDLE_DAYS * 24 * 60 * 60 * 1000;
      const abandoned = runs.filter((r) => {
        const { total, checked } = runCriteriaState(r);
        if (total === 0 || checked > 0) return false;
        const updated = Date.parse(r.updatedAt ?? r.createdAt ?? "");
        return Number.isFinite(updated) && updated < idleCutoff;
      });
      return {
        numerator: abandoned.length,
        denominator: runs.length,
        detail: `${abandoned.length}/${runs.length} runs created in window have zero criteria closed and are idle >${STALL_IDLE_DAYS}d`,
      };
    },
  },
  {
    id: "learning_capture_rate",
    name: "Learning capture rate",
    unit: "%",
    direction: "higher",
    minSample: 3,
    tolerance: 10,
    goodhart: 'Log a filler learning ("went well") on every run to keep the counter green.',
    countermeasure:
      "Paired with memory_loop_closure: learnings only matter if the promotion/recall side moves too — filler learnings never promote or resurface.",
    compute(data) {
      const completed = data.runs.filter((r) => inWindow(data, r.updatedAt) && runFinished(r));
      const withLearning = completed.filter((r) => (r.learning?.length ?? 0) > 0);
      return {
        numerator: withLearning.length,
        denominator: completed.length,
        detail: `${withLearning.length}/${completed.length} finished runs touched in window recorded at least one learning`,
      };
    },
  },
  {
    id: "feedback_closure_rate",
    name: "Feedback closure rate",
    unit: "%",
    direction: "higher",
    minSample: 5,
    tolerance: 5,
    goodhart:
      "Suppress feedback capture (fewer candidates) so the closure ratio improves without any learning happening.",
    countermeasure:
      "The gate also fails if candidate volume collapses to zero while sessions continue — silence is not closure (see check logic: feedback_candidate_volume guard).",
    compute(data) {
      const captured = data.events.filter(
        (e) => e.kind === "feedback.candidate" && inWindow(data, e.timestamp),
      ).length;
      const consumed = data.events.filter(
        (e) =>
          (e.kind === "memory.promotion" ||
            e.kind === "memory.write.create" ||
            e.kind === "memory.write.merge") &&
          inWindow(data, e.timestamp),
      ).length;
      return {
        numerator: Math.min(consumed, captured),
        denominator: captured,
        detail: `${captured} feedback candidates captured in window; ${consumed} downstream memory writes/promotions (closure proxy until feedback events carry consumption links)`,
      };
    },
  },
  {
    id: "memory_loop_closure",
    name: "Memory loop closure (reads per write)",
    unit: "ratio",
    direction: "higher",
    minSample: 5,
    tolerance: 0.1,
    goodhart:
      "Fire recall events mechanically at session start without the recalled content influencing anything.",
    countermeasure:
      "Recall events only move the metric when the instrumented recall path runs (soma memory recall); bulk MEMORY.md context loading is intentionally NOT counted — the metric tracks deliberate consultation.",
    compute(data) {
      const writes = data.events.filter(
        (e) =>
          (e.kind === "memory.write.create" ||
            e.kind === "memory.write.merge" ||
            e.kind === "memory.write.supersede") &&
          inWindow(data, e.timestamp),
      ).length;
      const reads = data.events.filter(
        (e) =>
          (e.kind === "memory.recall" || e.kind === "memory.promotion" || e.kind === "memory.verify") &&
          inWindow(data, e.timestamp),
      ).length;
      return {
        numerator: reads,
        denominator: writes,
        detail: `${reads} instrumented recalls/promotions/verifies vs ${writes} memory writes in window`,
      };
    },
  },
  {
    id: "promotion_rate",
    name: "Promotion rate (promotions per finished run)",
    unit: "%",
    direction: "higher",
    minSample: 5,
    tolerance: 5,
    goodhart:
      "Promote everything mechanically — fire a memory.promotion for every finished run regardless of whether the learning is durable, reusable, or ever read again.",
    countermeasure:
      "Paired with memory_loop_closure: promoted-but-never-resurfaced notes are writes that drag reads-per-write down, so bulk mechanical promotion surfaces there as unread inventory rather than a healthy signal.",
    compute(data) {
      const finished = data.runs.filter((r) => inWindow(data, r.updatedAt) && runFinished(r)).length;
      const promotions = data.events.filter(
        (e) => e.kind === "memory.promotion" && inWindow(data, e.timestamp),
      ).length;
      return {
        numerator: promotions,
        denominator: finished,
        detail: `${promotions} promotion events vs ${finished} finished runs in window`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Computation + gate
// ---------------------------------------------------------------------------

export function computeMetrics(data: HarnessData): MetricResult[] {
  return METRICS.map((spec) => {
    const { numerator, denominator, detail } = spec.compute(data);
    let value: number | null = null;
    if (denominator >= 1) {
      value = spec.unit === "%" ? (numerator / denominator) * 100 : numerator / denominator;
      value = Math.round(value * 100) / 100;
    }
    return {
      id: spec.id,
      name: spec.name,
      value,
      unit: spec.unit,
      direction: spec.direction,
      numerator,
      denominator,
      detail,
    };
  });
}

export interface Baseline {
  capturedAt: string;
  windowDays: number;
  metrics: Partial<Record<string, { value: number | null; denominator: number }>>;
}

export interface Regression {
  id: string;
  baseline: number;
  current: number;
  tolerance: number;
  direction: "higher" | "lower";
  message: string;
}

/**
 * `sessionStartsInWindow` — real harness activity for the silent-capture guard,
 * from in-window `lifecycle.session_start` events. When omitted (older callers,
 * unit tests), the guard falls back to the run-creation heuristic. It is passed
 * explicitly by the CLI because "runs created in window" undercounts activity:
 * a session that only touches existing runs is still active and should still be
 * producing feedback candidates.
 */
export function checkAgainstBaseline(
  results: MetricResult[],
  baseline: Baseline,
  sessionStartsInWindow?: number,
): Regression[] {
  const regressions: Regression[] = [];
  for (const result of results) {
    const spec = METRICS.find((m) => m.id === result.id);
    const base = baseline.metrics[result.id];
    if (!spec || base?.value == null || result.value === null) continue;
    if (result.denominator < spec.minSample) continue;
    const degraded =
      spec.direction === "higher"
        ? result.value < base.value - spec.tolerance
        : result.value > base.value + spec.tolerance;
    if (degraded) {
      regressions.push({
        id: result.id,
        baseline: base.value,
        current: result.value,
        tolerance: spec.tolerance,
        direction: spec.direction,
        message: `${result.name}: ${result.value}${result.unit} vs baseline ${base.value}${result.unit} (tolerance ${spec.tolerance}, want ${spec.direction})`,
      });
    }
  }
  // Anti-gaming guard for feedback_closure_rate: closure must not "improve"
  // by capture going silent while the harness is clearly still in use. "In use"
  // is measured by real session activity when the caller supplies it; otherwise
  // it falls back to the run-creation proxy (true_finish_rate's denominator).
  const closure = results.find((r) => r.id === "feedback_closure_rate");
  const harnessInUse =
    sessionStartsInWindow !== undefined
      ? sessionStartsInWindow > 0
      : (results.find((r) => r.id === "true_finish_rate")?.denominator ?? 0) > 0;
  if (closure?.denominator === 0 && harnessInUse) {
    regressions.push({
      id: "feedback_candidate_volume",
      baseline: 1,
      current: 0,
      tolerance: 0,
      direction: "higher",
      message:
        "Feedback capture went silent (0 candidates in window) while runs are still being created — capture pipeline is broken, not clean",
    });
  }
  return regressions;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const BASELINE_PATH = join(import.meta.dir, "harness-eval-baseline.json");

function formatValue(result: MetricResult): string {
  if (result.value === null) return "n/a (no data in window)";
  return result.unit === "%" ? `${result.value}%` : result.value.toFixed(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const windowArg = args.indexOf("--window");
  const windowDays = windowArg >= 0 ? Number(args[windowArg + 1]) : 60;
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error("--window expects a positive number of days");
    process.exit(2);
  }

  const somaHome = process.env.SOMA_HOME ?? join(homedir(), ".soma");
  const now = new Date();
  // Only events within the trailing window can affect any metric, so drop older
  // rows at load time (see loadEvents) rather than holding all-time history.
  const sinceMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const data: HarnessData = {
    runs: loadRuns(join(somaHome, "memory", "WORK", "algorithm-runs")),
    events: await loadEvents(join(somaHome, "memory", "STATE", "events.jsonl"), sinceMs),
    now,
    windowDays,
  };
  const results = computeMetrics(data);

  if (flag("--write-baseline")) {
    const baseline: Baseline = {
      capturedAt: data.now.toISOString(),
      windowDays,
      metrics: Object.fromEntries(
        results.map((r) => [r.id, { value: r.value, denominator: r.denominator }]),
      ),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Baseline written to ${BASELINE_PATH} (window ${windowDays}d)`);
    return;
  }

  if (flag("--json")) {
    console.log(JSON.stringify({ windowDays, results }, null, 2));
  } else {
    console.log(`Harness eval — trailing ${windowDays}d window (${data.runs.length} runs, ${data.events.length} events in window)\n`);
    for (const result of results) {
      const spec = METRICS.find((m) => m.id === result.id);
      console.log(`  ${result.name} [${result.direction} is better]`);
      console.log(`    ${formatValue(result)} — ${result.detail}`);
      if (flag("--explain") && spec) {
        console.log(`    goodhart: ${spec.goodhart}`);
        console.log(`    countermeasure: ${spec.countermeasure}`);
      }
    }
  }

  if (flag("--check")) {
    let baseline: Baseline;
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
    } catch {
      console.error(`\nNo readable baseline at ${BASELINE_PATH} — run with --write-baseline first.`);
      process.exit(2);
    }
    // A baseline captured over a different window is not comparable — 30-day
    // metrics vs a 60-day baseline would produce a meaningless verdict. Fail
    // loudly (exit 2) rather than silently comparing across windows.
    if (baseline.windowDays !== windowDays) {
      console.error(
        `\nWindow mismatch: baseline was captured over ${baseline.windowDays}d but --check ran with ${windowDays}d. ` +
          `Re-run with --window ${baseline.windowDays}, or recapture the baseline for ${windowDays}d.`,
      );
      process.exit(2);
    }
    // Harness activity for the silent-capture guard: count real sessions, not
    // newly-created runs — a session that touched existing runs still means the
    // capture pipeline should be producing candidates.
    const sessionStarts = data.events.filter(
      (e) => e.kind === "lifecycle.session_start" && inWindow(data, e.timestamp),
    ).length;
    const regressions = checkAgainstBaseline(results, baseline, sessionStarts);
    if (regressions.length > 0) {
      console.error(`\nREGRESSION: ${regressions.length} metric(s) degraded past tolerance vs baseline (${baseline.capturedAt}):`);
      for (const regression of regressions) console.error(`  ✗ ${regression.message}`);
      process.exit(1);
    }
    console.log(`\nOK: no regressions vs baseline (${baseline.capturedAt}, window ${baseline.windowDays}d)`);
  }
}

if (import.meta.main) await main();
