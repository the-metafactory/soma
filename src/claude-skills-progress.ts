/**
 * #125 — per-skill progress emitter for `soma migrate claude-skills`.
 *
 * The migrator's apply path can block for minutes when `--rewrite-
 * descriptions <agent>` is set against a real PAI tree (10× LLM calls
 * × 5-30s each). Without progress, principals can't tell whether the
 * dispatcher hung, which skill is mid-rewrite, or how many remain.
 *
 * Design contract (issue #125 ACs):
 *   - Progress streams to **stderr**, leaving stdout byte-stable for
 *     scripts that parse the summary table.
 *   - `quiet=true` → no-op; nothing on stderr at all.
 *   - TTY detection — `\r` overwrite for the fast classification phase
 *     so a 97-skill scan doesn't scrollback-blow the terminal; `\n`-
 *     terminated lines for slow phases (rewrite, write, smoke verify)
 *     so the audit trail is grep-able. Non-TTY → append-only with
 *     `\n` for every line so piped output stays clean.
 *   - `finishTimingSummary` returns the multi-line "Timing" block the
 *     caller appends to **stdout** (the timing block IS part of the
 *     summary, not stderr noise; it's stable across re-runs).
 *
 * The emitter is a pure transducer over `NodeJS.WritableStream` so the
 * unit tests can inject a capturing buffer. No real TTY handling in
 * this module — the caller passes `isatty` based on
 * `stream.isTTY === true`.
 */
import { Writable as NodeWritable } from "node:stream";

export interface PhaseTiming {
  /** Human-readable phase name (e.g. "read + classify"). */
  name: string;
  /** Elapsed time in milliseconds. */
  elapsedMs: number;
  /** Count of items processed in this phase (skills, files, calls...). */
  count: number;
  /**
   * Unit label printed after the count (e.g. "skills", "files",
   * "LLM calls via claude", "(not requested)"). When the phase
   * wasn't run, callers pass `count: 0, unit: "(not requested)"` so
   * the renderer omits the leading count entirely.
   */
  unit: string;
}

export interface PhaseTimings {
  totalMs: number;
  phases: PhaseTiming[];
}

export interface ProgressEmitter {
  /**
   * Banner line: `[discovering skills ... <total> ...]`. Called once
   * before any `step()` invocation. Drives the `[N/total]` prefix on
   * subsequent step lines.
   */
  start(total: number): void;

  /**
   * Emit a per-skill phase-start line. Fast phases (classification of
   * portable/skipped) use `\r`-overwrite on TTY so the scrollback
   * stays clean. Slow phases (rewrite, write, smoke) emit a full
   * line that survives subsequent overwrites by terminating with `\n`
   * on `stepComplete`.
   *
   * `detail` is the inline tag string (e.g. "portable", "rewriting
   * via claude (1318 chars → target 900)"). Optional — for phases
   * where the start line is just `[N/total] <skill> [phase ...]`.
   */
  step(index: number, sourceName: string, phase: string, detail?: string): void;

  /**
   * Emit a phase-completion line. On TTY, this writes the elapsed
   * suffix on the SAME terminal row that `step()` started (via
   * `\r`-overwrite) and then terminates with `\n` so the next step
   * starts on a fresh row. On non-TTY, emits a separate `\n`-line.
   *
   * `elapsedMs` is rendered as `<N>s` for ≥ 1 second, `<N>ms` below.
   * `detail` overrides the prior `step()` detail (e.g. the new
   * description length after a rewrite).
   */
  stepComplete(
    index: number,
    sourceName: string,
    phase: string,
    elapsedMs: number,
    detail?: string,
  ): void;

  /**
   * #139 — open a concurrent phase. TTY output renders one rolling
   * line for the whole worker pool; non-TTY and verbose output keep
   * the append-only per-skill lines that are useful in logs.
   *
   * `concurrency` is reported in the banner so a principal tail-ing
   * stderr knows the fan-out width (`4-wide concurrent`).
   *
   * Banner line format (stable across re-runs):
   *   `[<name>: <total> skills, <concurrency>-wide concurrent ...]\n`
   *
   * Multiple concurrent phases per run are supported (begin/end
   * pairs). Nesting is NOT supported — a second `begin` before
   * `end` is a contract violation (current implementation just
   * overwrites the active-phase state; future enforcement TBD).
   */
  beginConcurrentPhase(name: string, total: number, concurrency: number): void;

  /**
   * #139 — close the active concurrent phase. Emits one summary
   * line with elapsed total + per-step avg/max ms (tracked
   * internally from suppressed `stepComplete` calls).
   *
   * Summary line format (stable across re-runs):
   *   `[<name>: <total> skills in <elapsed>s (avg <avg>ms, max <max>ms)]\n`
   *
   * `elapsedMs` is the wall-clock duration of the concurrent phase
   * (provided by the caller, NOT computed internally — the migrator
   * already tracks phase elapsed times for the Timing block).
   *
   * If no `stepComplete` calls fired between begin and end (empty
   * input), avg/max default to 0 (not NaN) so the summary stays
   * readable.
   */
  endConcurrentPhase(name: string, elapsedMs: number): void;

  /**
   * Render the Timing block. Returned for the caller to append to
   * stdout — NOT written to stderr by this helper. Stable formatting
   * across re-runs (numbers rounded to 1 decimal place).
   */
  finishTimingSummary(timings: PhaseTimings): string;
}

interface ProgressEmitterOptions {
  stderr: NodeJS.WritableStream;
  /** When true, every method is a no-op (except `finishTimingSummary`
   * which still returns the string — the Timing block is part of the
   * stdout summary, not stderr progress). */
  quiet: boolean;
  /**
   * Whether the underlying stream is a TTY. When true, fast phases
   * use `\r` overwrite. When false, every line is append-only. The
   * caller derives this from `stream.isTTY === true` (or a test
   * override).
   */
  isatty: boolean;
  /**
   * Preserve append-only per-skill output even for concurrent phases.
   * This is intentionally separate from `quiet`: quiet suppresses all
   * stderr progress, verbose asks for the most detailed stderr form.
   */
  verbose?: boolean;
}

export function createProgressEmitter(opts: ProgressEmitterOptions): ProgressEmitter {
  const { stderr, quiet, isatty, verbose = false } = opts;
  let total = 0;

  // #139 — concurrent-phase state. Nesting is not supported (a
  // second begin overwrites state).
  let activeConcurrentPhase: {
    name: string;
    total: number;
    concurrency: number;
    completedCount: number;
    completedItems: Set<string>;
    inFlight: Set<string>;
    latestCompleted: string | null;
    elapsedSamples: number[]; // ms per stepComplete inside the phase
  } | null = null;

  // Per-step elapsed: under 1 second → `<N>ms` (live progress wants
  // millisecond resolution so a 12ms classify doesn't read as `0s`).
  // The timing block uses `fmtElapsedSeconds` so the summary table
  // always speaks in seconds (matches the issue spec, e.g.
  // `read + classify: 0.8s (97 skills)`).
  function fmtElapsed(ms: number): string {
    if (ms >= 1000) {
      const s = ms / 1000;
      // 1 decimal place; trim trailing `.0` so `2.0s` becomes `2s`.
      const r = s.toFixed(1);
      return r.endsWith(".0") ? `${r.slice(0, -2)}s` : `${r}s`;
    }
    return `${ms}ms`;
  }

  function fmtElapsedSeconds(ms: number): string {
    const s = ms / 1000;
    return `${s.toFixed(1)}s`;
  }

  function formatStepLine(
    index: number,
    sourceName: string,
    phase: string,
    detail?: string,
  ): string {
    const prefix = `[${index}/${total}]`;
    const tail = detail ? `[${phase} ... ${detail}]` : `[${phase} ...]`;
    return `${prefix} ${sourceName}  ${tail}`;
  }

  function shouldAppendConcurrentLines(): boolean {
    return !isatty || verbose;
  }

  function writeTtyRewrite(body: string, close = false): void {
    stderr.write(`\r${body}\x1b[K${close ? "\n" : ""}`);
  }

  function renderConcurrentLine(phase: NonNullable<typeof activeConcurrentPhase>): void {
    const active = phase.latestCompleted ?? phase.inFlight.values().next().value ?? "skills";
    const visibleInFlight = phase.inFlight.has(active) ? phase.inFlight.size - 1 : phase.inFlight.size;
    const others = visibleInFlight > 0 ? ` + ${visibleInFlight} others` : "";
    writeTtyRewrite(`[${phase.completedCount}/${phase.total}] processing ${active}${others}...`);
  }

  return {
    start(t: number): void {
      total = t;
      if (quiet) return;
      // Discovery banner. Append-only line so it survives any
      // subsequent `\r`-overwrites by the per-skill step lines.
      stderr.write(`[discovering ${t} skill(s) ...]\n`);
    },

    step(index: number, sourceName: string, phase: string, detail?: string): void {
      if (quiet) return;
      if (activeConcurrentPhase) {
        activeConcurrentPhase.inFlight.add(sourceName);
        if (shouldAppendConcurrentLines()) {
          stderr.write(`${formatStepLine(index, sourceName, phase, detail)}\n`);
        } else {
          renderConcurrentLine(activeConcurrentPhase);
        }
        return;
      }
      const body = formatStepLine(index, sourceName, phase, detail);
      if (isatty) {
        // TTY: open with `\r` to overwrite any prior fast-phase line.
        // No trailing `\n` — `stepComplete` will close the row.
        writeTtyRewrite(body);
      } else {
        // Non-TTY: append-only with `\n`.
        stderr.write(`${body}\n`);
      }
    },

    stepComplete(
      index: number,
      sourceName: string,
      phase: string,
      elapsedMs: number,
      detail?: string,
    ): void {
      if (quiet) return;
      if (activeConcurrentPhase) {
        const current = activeConcurrentPhase;
        if (!current.completedItems.has(sourceName)) {
          current.completedItems.add(sourceName);
          current.completedCount += 1;
          current.elapsedSamples.push(elapsedMs);
        }
        current.latestCompleted = sourceName;
        current.inFlight.delete(sourceName);
        if (shouldAppendConcurrentLines()) {
          const elapsed = fmtElapsed(elapsedMs);
          const body = formatStepLine(index, sourceName, phase, detail);
          stderr.write(`${body} (${elapsed})\n`);
        } else {
          renderConcurrentLine(current);
        }
        return;
      }
      const elapsed = fmtElapsed(elapsedMs);
      const body = formatStepLine(index, sourceName, phase, detail);
      const closer = ` (${elapsed})`;
      if (isatty) {
        // TTY: same row as the step() open. We write `\r<body><closer>\n`
        // so the row reflects the FINAL state (overwriting any prior
        // partial), then closes with `\n` so the next step starts
        // fresh. If no prior step() was issued for this index (some
        // phases skip the open-line), the `\r` is harmless.
        writeTtyRewrite(`${body}${closer}`, true);
      } else {
        // Non-TTY: emit a separate `\n` line so the elapsed suffix
        // appears under the corresponding step.
        stderr.write(`${body}${closer}\n`);
      }
    },

    beginConcurrentPhase(name: string, totalSteps: number, concurrency: number): void {
      // Open phase state regardless of `quiet` so the matching
      // suppression in step/stepComplete still triggers (otherwise a
      // quiet emitter would fall through to per-skill emission paths
      // — though both paths are no-ops under quiet, keeping state in
      // sync avoids surprise from future changes).
      activeConcurrentPhase = {
        name,
        total: totalSteps,
        concurrency,
        completedCount: 0,
        completedItems: new Set(),
        inFlight: new Set(),
        latestCompleted: null,
        elapsedSamples: [],
      };
      if (quiet) return;
      if (shouldAppendConcurrentLines()) {
        stderr.write(
          `[${name}: ${totalSteps} skills, ${concurrency}-wide concurrent ...]\n`,
        );
      } else {
        renderConcurrentLine(activeConcurrentPhase);
      }
    },

    endConcurrentPhase(name: string, elapsedMs: number): void {
      const phase = activeConcurrentPhase;
      // Always clear state — even on quiet — so a subsequent
      // sequential `step` call is no longer suppressed.
      activeConcurrentPhase = null;
      if (quiet) return;
      // Defensive: end called without a matching begin. Emit
      // nothing and don't crash — the migrator should never trigger
      // this, but a misuse shouldn't blow up the run.
      if (!phase) return;
      const samples = phase.elapsedSamples;
      const count = phase.total;
      let avgMs = 0;
      let maxMs = 0;
      if (samples.length > 0) {
        const sum = samples.reduce((a, b) => a + b, 0);
        avgMs = Math.round(sum / samples.length);
        maxMs = samples.reduce((a, b) => (b > a ? b : a), 0);
      }
      const elapsed = fmtElapsedSeconds(elapsedMs);
      const summary = `[${name}: ${count} skills in ${elapsed} (avg ${avgMs}ms, max ${maxMs}ms)]`;
      if (isatty && !verbose) {
        writeTtyRewrite(summary, true);
      } else {
        stderr.write(`${summary}\n`);
      }
    },

    finishTimingSummary(timings: PhaseTimings): string {
      // Timing block — formatting stable across re-runs so the
      // string is grep-able. We DON'T write to stderr here; the
      // caller appends to stdout.
      const lines: string[] = [];
      lines.push(`Timing: ${fmtElapsedSeconds(timings.totalMs)} total`);
      for (const phase of timings.phases) {
        const elapsed = fmtElapsedSeconds(phase.elapsedMs);
        // (not requested) is the canonical "phase didn't run" tag.
        // The unit string is rendered as-is; phases that did run
        // pass plain units like "skills" or "files".
        if (phase.unit === "(not requested)") {
          lines.push(`  - ${phase.name}: (not requested)`);
        } else {
          lines.push(`  - ${phase.name}: ${elapsed} (${phase.count} ${phase.unit})`);
        }
      }
      return lines.join("\n");
    },
  };
}

/**
 * No-op emitter for code paths that don't want progress (default for
 * library callers; the CLI overrides with a real stderr emitter).
 * Intentionally NOT exported as the default in createProgressEmitter
 * — explicit no-op is clearer at the callsite than `quiet: true` with
 * a real stream.
 */
// A `/dev/null`-style writable stream — used by the no-op emitter so
// the formatter still receives a valid stream for the `quiet: true`
// short-circuit (every write returns without touching the stream).
// Module-scope so `createNoopProgressEmitter` doesn't allocate one
// per call.
const NULL_STREAM: NodeJS.WritableStream = new NodeWritable({
  write(_chunk: unknown, _enc: unknown, cb: (e?: Error | null) => void): void {
    cb();
  },
});

export function createNoopProgressEmitter(): ProgressEmitter {
  return {
    start: noop,
    step: noop,
    stepComplete: noop,
    beginConcurrentPhase: noop,
    endConcurrentPhase: noop,
    finishTimingSummary: (timings) => {
      // Even the no-op renders the Timing block — it's stdout
      // content the formatter wants regardless of stderr behavior.
      const real = createProgressEmitter({
        stderr: NULL_STREAM,
        quiet: true,
        isatty: false,
      });
      return real.finishTimingSummary(timings);
    },
  };
}

// Shared no-op stub for the no-op emitter's start/step/stepComplete.
// Inline arrow functions trip `no-empty-function` per the lint rule;
// a named function avoids the false positive without altering behavior.
function noop(): void {
  // intentionally empty
}
