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
}

export function createProgressEmitter(opts: ProgressEmitterOptions): ProgressEmitter {
  const { stderr, quiet, isatty } = opts;
  let total = 0;

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
      const body = formatStepLine(index, sourceName, phase, detail);
      if (isatty) {
        // TTY: open with `\r` to overwrite any prior fast-phase line.
        // No trailing `\n` — `stepComplete` will close the row.
        stderr.write(`\r${body}`);
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
      const elapsed = fmtElapsed(elapsedMs);
      const body = formatStepLine(index, sourceName, phase, detail);
      const closer = ` (${elapsed})`;
      if (isatty) {
        // TTY: same row as the step() open. We write `\r<body><closer>\n`
        // so the row reflects the FINAL state (overwriting any prior
        // partial), then closes with `\n` so the next step starts
        // fresh. If no prior step() was issued for this index (some
        // phases skip the open-line), the `\r` is harmless.
        stderr.write(`\r${body}${closer}\n`);
      } else {
        // Non-TTY: emit a separate `\n` line so the elapsed suffix
        // appears under the corresponding step.
        stderr.write(`${body}${closer}\n`);
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
