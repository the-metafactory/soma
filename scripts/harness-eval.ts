/**
 * Harness eval + regression gate.
 *
 * Computes the harness's north-star metrics from live Soma data (algorithm-run
 * corpus + memory event stream) and compares them against a committed baseline.
 *
 *   bun run harness-eval                  # print metrics (trailing window + all-time)
 *   bun run harness-eval --json           # machine-readable output
 *   bun run harness-eval --explain        # include each metric's Goodhart mode + countermeasure
 *   bun run harness-eval --check          # write receipt; exit 1 on regression, 3 on incomplete coverage
 *   bun run harness-eval --trend          # print dated receipts, oldest first
 *   bun run harness-eval --write-baseline # capture current window metrics as the new baseline
 *   bun run harness-eval --window 30      # trailing window in days (default 60)
 *
 * The regression gate evaluates the TRAILING WINDOW only: all-time aggregates
 * dilute fresh degradation under months of healthy history, which would defeat
 * the gate's purpose. The baseline lives at scripts/harness-eval-baseline.json
 * and is committed so drift is reviewable in git history.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createEvalReceipt, EvalInputs, parseEvalBaseline, readEvalTrend, writeEvalReceipt, type EvalReceipt } from "./harness-eval-receipt";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { homedir } from "node:os";
import { join } from "node:path";
import { streamEventLines } from "../src/events/index";
import type { ErrataPassedBy } from "../src/flows/types";

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
  /** Errata ledger lines; absent or null when the ledger is missing or unreadable. */
  errata?: ErrataLedgerLine[] | null;
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

export function loadRuns(runsDir: string, inputs?: EvalInputs): RunDoc[] {
  const runs: RunDoc[] = [];
  let files: string[];
  try {
    files = readdirSync(runsDir);
  } catch {
    if (inputs) {
      inputs.runsAvailable = false;
      inputs.inputs.push({ source: runsDir, sha256: null });
    }
    return runs;
  }
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const path = join(runsDir, file);
      runs.push(JSON.parse(inputs ? inputs.read(path) : readFileSync(path, "utf8")) as RunDoc);
    } catch {
      if (inputs) inputs.runsAvailable = false;
      // unreadable run files are a doctor concern, not an eval concern
    }
  }
  return runs;
}

/**
 * Stream the append-only event log line by line, retaining ONLY events at or
 * after `sinceMs` while tracking the earliest valid timestamp. The live log is tens of MiB and grows without bound, but
 * every metric works on a trailing window — so loading and holding the whole
 * history (the previous `readFileSync` + `split`) wasted memory that scales with
 * all-time history, not the window. Streaming bounds peak memory to one line and
 * retention to the window. Events older than the cutoff, and events with an
 * unparseable timestamp, are dropped here — `inWindow()` would drop both anyway,
 * so per-metric results are unchanged; only out-of-window rows never get held.
 * The earliest timestamp lets the CLI detect when the log starts after the
 * requested window, even though older rows are not retained.
 */
interface LoadedEvents {
  events: EventDoc[];
  firstEventAt: string | null;
  readError: boolean;
  coversWindow: boolean;
  sha256: string;
}

export async function loadEventsWithCoverage(
  eventsPath: string,
  sinceMs: number,
  input?: Readable,
): Promise<LoadedEvents> {
  const events: EventDoc[] = [];
  let firstEventMs = Number.POSITIVE_INFINITY;
  let readError = false;
  const hash = createHash("sha256");
  const rl = input ? createInterface({ input, crlfDelay: Infinity }) : streamEventLines(eventsPath);
  try {
    for await (const line of rl) {
      hash.update(`${line}\n`);
      if (!line.trim()) continue;
      let event: EventDoc;
      try {
        event = JSON.parse(line) as EventDoc;
      } catch {
        continue; // skip torn lines
      }
      const t = event.timestamp ? Date.parse(event.timestamp) : Number.NaN;
      if (Number.isFinite(t)) firstEventMs = Math.min(firstEventMs, t);
      if (sinceMs !== Number.NEGATIVE_INFINITY && (!Number.isFinite(t) || t < sinceMs)) continue;
      events.push(event);
    }
  } catch {
    // A partial stream cannot establish complete coverage, even if an old event was seen.
    readError = true;
  }
  return {
    events,
    firstEventAt: Number.isFinite(firstEventMs) ? new Date(firstEventMs).toISOString() : null,
    readError,
    coversWindow: !readError && firstEventMs <= sinceMs,
    sha256: hash.digest("hex"),
  };
}

export async function loadEvents(eventsPath: string, sinceMs = Number.NEGATIVE_INFINITY): Promise<EventDoc[]> {
  return (await loadEventsWithCoverage(eventsPath, sinceMs)).events;
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
      "Pad evidence strings with paths and numbers that were never actually observed — the evidenceKind label is caller-asserted (`EvidenceKind` in src/core/types.ts) and this text heuristic can be fooled the same way.",
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
        detail: `${violations} gate refusals vs ${passed} passed verifications (${denominator} verification outcomes) in window`,
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
          (e.kind === "memory.recall" ||
            e.kind === "memory.resurface" ||
            e.kind === "memory.promotion" ||
            e.kind === "memory.verify") &&
          inWindow(data, e.timestamp),
      ).length;
      return {
        numerator: reads,
        denominator: writes,
        detail: `${reads} instrumented recalls/resurfaces/promotions/verifies vs ${writes} memory writes in window`,
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

// ---------------------------------------------------------------------------
// Errata metrics (soma#785 Q18) — derived from the private Errata ledger only.
// Reported, not gated: they have no baseline yet, and alerts on them are out of
// scope (proposals already spend the attention budget).
// ---------------------------------------------------------------------------

/**
 * One raw ledger line, duck-typed: the harness counts, it never reads complaint
 * text. `created` and `dropped` come from `soma errata triage` (src/errata.ts).
 * The cluster lifecycle the closure metric reads is appended downstream:
 * `proposed` when a ripe cluster goes out as a Vigil proposal (node #852),
 * `answered` with the principal's `answer: "yes" | "no"`, and `node-closed` when
 * the node a yes filed closes. Unknown kinds are skipped, so a new ledger event
 * never breaks the eval.
 */
export interface ErrataLedgerLine {
  kind?: string;
  id?: string;
  clusterId?: string;
  at?: string;
  answer?: string;
  record?: { id?: string; complaintAt?: string; passedBy?: ErrataPassedBy | null };
}

/** The ledger `soma errata` writes (src/errata.ts `errataLedgerPath`). */
export function errataLedgerFile(somaHome: string): string {
  return join(somaHome, "memory", "STATE", "errata", "ledger.jsonl");
}

/** null when the ledger is missing or unreadable, so its metrics read n/a rather than zero. */
export function loadErrataLedger(ledgerPath: string, inputs?: EvalInputs): ErrataLedgerLine[] | null {
  let text: string;
  try {
    text = inputs ? inputs.read(ledgerPath) : readFileSync(ledgerPath, "utf8");
  } catch {
    return null;
  }
  const lines: ErrataLedgerLine[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null) lines.push(parsed);
    } catch {
      // skip torn lines
    }
  }
  return lines;
}

/** The check that passed a rejected output: `<run>/<criterion>` or `<repo>#<node>/<receipt>`. */
export function errataCheckKey(passedBy: ErrataPassedBy): string {
  return passedBy.kind === "algorithm-verify"
    ? `${passedBy.runId}/${passedBy.criterionId}`
    : `${passedBy.repo}#${passedBy.nodeId}/${passedBy.receiptCommentId}`;
}

export interface ErrataReport {
  rejected_passes: { check: string; count: number }[] | "n/a";
  errata_unlinked: number | "n/a";
  errata_fix_closure: { value: number; fixed: number; proposed: number; detail: string } | "n/a";
}

export const ERRATA_METRICS: Pick<MetricSpec, "id" | "name" | "direction" | "goodhart" | "countermeasure">[] = [
  {
    id: "rejected_passes",
    name: "Rejected passes per check (plus unlinked Errata)",
    direction: "lower",
    goodhart:
      "Rejections stop reaching the ledger: capture goes quiet, triage drops real complaints, or the linker stops naming the check so rejected passes fall into errata_unlinked.",
    countermeasure:
      "--check fails when feedback candidates stop while sessions continue (feedback_candidate_volume guard); errata_unlinked is reported beside the rows so lost links show as a rising unlinked count; every triage drop is a recorded errata-triage judgment open to audit.",
  },
  {
    id: "errata_fix_closure",
    name: "Errata fix closure (proposed clusters fixed)",
    direction: "higher",
    goodhart:
      "Answer yes and close the filed node without fixing the check, or let only easy clusters reach a proposal.",
    countermeasure:
      "A check that still passes rejected output earns a new Errata on the same check key, so its rejected_passes row grows back; proposals follow the deterministic ripeness rule (soma#785 Q16), not a choice of which cluster to propose.",
  },
];

/**
 * Rejected passes: active (not dropped) Errata whose complaint falls in the window,
 * counted per check that passed them; `passedBy: null` counts as unlinked. Closure:
 * clusters proposed in the window, fixed when a `yes` answer was followed by the
 * filed node closing. Missing ledger or no data in window reads "n/a", never zero.
 */
export function computeErrataMetrics(data: HarnessData): ErrataReport {
  const records = new Map<string, { complaintAt?: string; passedBy: ErrataPassedBy | null }>();
  const dropped = new Set<string>();
  const clusters = new Map<string, { proposed: boolean; yes: boolean; closed: boolean }>();
  for (const line of data.errata ?? []) {
    if (line.kind === "created" && line.record?.id) {
      records.set(line.record.id, { complaintAt: line.record.complaintAt, passedBy: line.record.passedBy ?? null });
    } else if (line.kind === "dropped" && line.id) {
      dropped.add(line.id);
    } else if (line.clusterId && (line.kind === "proposed" || line.kind === "answered" || line.kind === "node-closed")) {
      const cluster = clusters.get(line.clusterId) ?? { proposed: false, yes: false, closed: false };
      if (line.kind === "proposed" && inWindow(data, line.at)) cluster.proposed = true;
      if (line.kind === "answered" && line.answer === "yes") cluster.yes = true;
      // A close counts only for a node a yes filed.
      if (line.kind === "node-closed" && cluster.yes) cluster.closed = true;
      clusters.set(line.clusterId, cluster);
    }
  }

  const active = [...records].filter(([id, record]) => !dropped.has(id) && inWindow(data, record.complaintAt));
  let rejected: ErrataReport["rejected_passes"] = "n/a";
  let unlinked: ErrataReport["errata_unlinked"] = "n/a";
  if (active.length > 0) {
    const counts = new Map<string, number>();
    unlinked = 0;
    for (const [, record] of active) {
      if (record.passedBy === null) unlinked++;
      else {
        const check = errataCheckKey(record.passedBy);
        counts.set(check, (counts.get(check) ?? 0) + 1);
      }
    }
    rejected = [...counts]
      .map(([check, count]) => ({ check, count }))
      .sort((a, b) => b.count - a.count || a.check.localeCompare(b.check));
  }

  const proposed = [...clusters.values()].filter((c) => c.proposed);
  const fixed = proposed.filter((c) => c.yes && c.closed).length;
  const closure: ErrataReport["errata_fix_closure"] =
    proposed.length === 0
      ? "n/a"
      : {
          value: Math.round((fixed / proposed.length) * 10000) / 100,
          fixed,
          proposed: proposed.length,
          detail: `${fixed}/${proposed.length} Errata clusters fixed`,
        };
  return { rejected_passes: rejected, errata_unlinked: unlinked, errata_fix_closure: closure };
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

/** In-window `feedback.candidate` events: the input Errata triage promotes from. */
export function countFeedbackCandidates(data: HarnessData): number {
  return data.events.filter((e) => e.kind === "feedback.candidate" && inWindow(data, e.timestamp)).length;
}

export interface CaptureActivity {
  /** In-window feedback candidates (`countFeedbackCandidates`). */
  feedbackCandidates: number;
  /**
   * Real harness activity, from in-window `lifecycle.session_start` events. When
   * omitted (unit tests), the guard falls back to the run-creation heuristic. The
   * CLI passes it because "runs created in window" undercounts activity: a session
   * that only touches existing runs is still active and should still be producing
   * feedback candidates.
   */
  sessionStarts?: number;
}

/**
 * `activity` feeds the silent-capture guard: rejected passes and Errata closure
 * must not "improve" because capture went quiet, since every Errata starts as a
 * feedback candidate.
 */
export function checkAgainstBaseline(
  results: MetricResult[],
  baseline: Baseline,
  activity: CaptureActivity,
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
  // Anti-gaming guard for the Errata metrics: fewer rejected passes must not come
  // from capture going silent while the harness is clearly still in use. "In use"
  // is measured by real session activity when the caller supplies it; otherwise
  // it falls back to the run-creation proxy (true_finish_rate's denominator).
  const harnessInUse =
    activity.sessionStarts !== undefined
      ? activity.sessionStarts > 0
      : (results.find((r) => r.id === "true_finish_rate")?.denominator ?? 0) > 0;
  if (activity.feedbackCandidates === 0 && harnessInUse) {
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

function printErrata(report: ErrataReport, explain: boolean): void {
  const lines: Record<string, string[]> = {
    rejected_passes:
      report.rejected_passes === "n/a"
        ? ["n/a (no Errata in window)"]
        : [
            ...report.rejected_passes.map((row) => `${row.check}: ${row.count}`),
            `unlinked Errata: ${report.errata_unlinked}`,
          ],
    errata_fix_closure: [
      report.errata_fix_closure === "n/a"
        ? "n/a (no Errata cluster proposed in window)"
        : `${report.errata_fix_closure.value}% — ${report.errata_fix_closure.detail}`,
    ],
  };
  for (const spec of ERRATA_METRICS) {
    console.log(`  ${spec.name} [${spec.direction} is better]`);
    for (const line of lines[spec.id] ?? []) console.log(`    ${line}`);
    if (explain) {
      console.log(`    goodhart: ${spec.goodhart}`);
      console.log(`    countermeasure: ${spec.countermeasure}`);
    }
  }
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
  const stateDir = join(somaHome, "memory", "STATE");
  if (flag("--trend")) {
    for (const line of readEvalTrend(stateDir)) console.log(line);
    return;
  }
  const inputs = new EvalInputs();
  const now = new Date();
  // Only events within the trailing window can affect any metric, so drop older
  // rows at load time (see loadEvents) rather than holding all-time history.
  const sinceMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const loaded = await loadEventsWithCoverage(join(somaHome, "memory", "STATE", "events.jsonl"), sinceMs);
  inputs.inputs.push({ source: "events:ordered-logical-lines", sha256: loaded.sha256 });
  const firstEventMs = loaded.firstEventAt ? Date.parse(loaded.firstEventAt) : null;
  const gapMs = firstEventMs === null ? null : Math.max(0, firstEventMs - sinceMs);
  const coverageComplete = loaded.coversWindow;
  const coverage = {
    windowStart: new Date(sinceMs).toISOString(),
    firstEvent: loaded.firstEventAt,
    gapDays: gapMs === null ? null : Number((gapMs / (24 * 60 * 60 * 1000)).toFixed(1)),
    readError: loaded.readError,
    complete: coverageComplete,
  };
  const coverageLine =
    `Window start: ${coverage.windowStart} | First event: ${coverage.firstEvent ?? "none"} | ` +
    `Gap: ${coverage.gapDays === null ? "unknown" : coverage.gapDays === 0 ? "none" : `${coverage.gapDays} days`}` +
    (loaded.readError
      ? " (event log read failed before EOF)"
      : gapMs !== 0
        ? ` (earlier events may be in ${join(somaHome, "memory", "STATE", "events-snapshots")})`
        : "");
  const data: HarnessData = {
    runs: loadRuns(join(somaHome, "memory", "WORK", "algorithm-runs"), inputs),
    events: loaded.events,
    errata: loadErrataLedger(errataLedgerFile(somaHome), inputs),
    now,
    windowDays,
  };
  const results = computeMetrics(data);
  const errata = computeErrataMetrics(data);
  let baseline: Baseline | null = null;
  if (flag("--check")) {
    try {
      baseline = parseEvalBaseline(inputs.read(BASELINE_PATH));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  const finishCheck = (result: EvalReceipt["result"], regressions: Regression[] = []) => {
    writeEvalReceipt(stateDir, createEvalReceipt({
      now, windowDays, results, specs: METRICS, errata, baseline, regressions,
      coverageComplete, runsAvailable: inputs.runsAvailable, result, inputs: inputs.inputs,
    }));
    const print = flag("--json") ? console.error : console.log;
    print(`RESULT ${result}`);
  };

  if (flag("--check") || flag("--write-baseline")) {
    if (!coverageComplete) {
      if (flag("--json")) console.log(JSON.stringify({ windowDays, coverage, results, errata }, null, 2));
      else console.error(coverageLine);
      console.error(
        loaded.readError
          ? "INCOMPLETE COVERAGE: event log read failed before EOF. Cannot measure this window."
          : `INCOMPLETE COVERAGE: window starts ${coverage.windowStart}, first event ${coverage.firstEvent ?? "none"}; ` +
              `gap ${coverage.gapDays ?? "unknown"} days. Earlier events may be in ` +
              `${join(somaHome, "memory", "STATE", "events-snapshots")}. Cannot measure this window.`,
      );
      if (flag("--check")) finishCheck("could-not-run");
      process.exit(3);
    }
  }

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
    console.log(JSON.stringify({ windowDays, coverage, results, errata }, null, 2));
  } else {
    console.log(`Harness eval — trailing ${windowDays}d window (${data.runs.length} runs, ${data.events.length} events in window)\n`);
    console.log(`${coverageLine}\n`);
    for (const result of results) {
      const spec = METRICS.find((m) => m.id === result.id);
      console.log(`  ${result.name} [${result.direction} is better]`);
      console.log(`    ${formatValue(result)} — ${result.detail}`);
      if (flag("--explain") && spec) {
        console.log(`    goodhart: ${spec.goodhart}`);
        console.log(`    countermeasure: ${spec.countermeasure}`);
      }
    }
    printErrata(errata, flag("--explain"));
  }

  if (flag("--check")) {
    if (baseline === null) {
      console.error(`\nNo readable baseline at ${BASELINE_PATH} — run with --write-baseline first.`);
      finishCheck("could-not-run");
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
      finishCheck("could-not-run");
      process.exit(2);
    }
    // Harness activity for the silent-capture guard: count real sessions, not
    // newly-created runs — a session that touched existing runs still means the
    // capture pipeline should be producing candidates.
    const sessionStarts = data.events.filter(
      (e) => e.kind === "lifecycle.session_start" && inWindow(data, e.timestamp),
    ).length;
    const regressions = checkAgainstBaseline(results, baseline, {
      feedbackCandidates: countFeedbackCandidates(data),
      sessionStarts,
    });
    if (regressions.length > 0) {
      console.error(`\nREGRESSION: ${regressions.length} metric(s) degraded past tolerance vs baseline (${baseline.capturedAt}):`);
      for (const regression of regressions) console.error(`  ✗ ${regression.message}`);
      finishCheck("regressed", regressions);
      process.exit(1);
    }
    console.log(`\nOK: no regressions vs baseline (${baseline.capturedAt}, window ${baseline.windowDays}d)`);
    finishCheck("ok");
  }
}

if (import.meta.main) await main();
