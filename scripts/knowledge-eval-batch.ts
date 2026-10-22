/** Repeated hint ladders over the isolated B1 trial; never compare separate batches. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  canonicalSubstrate, defaultTrialDeps, loadFixture, parseArgs as parseTrialArgs,
  resolveInsideStore, runTrial, storeRoot, TrialUsageError, validateTrialOptions,
  type LoadedFixture, type Measured, type TrialOptions, type TrialRecord, type TrialResult,
} from "./knowledge-eval-trial";

export type Score = 0 | 1 | 2 | 3 | "fail" | "errored";
type Hint = Extract<Score, number>;

export interface BatchArm { label: string; homeSource: string }
export interface BatchOptions extends Omit<TrialOptions, "fixture" | "arm" | "hint" | "homeSource"> {
  fixtures: readonly string[];
  arms: readonly BatchArm[];
}
export interface BatchDeps { trial(options: TrialOptions): Promise<TrialResult> }

export interface BatchTrial {
  fixture_id: string;
  arm: string;
  repeat: number;
  hint_level: Hint;
  record_path: string | null;
  record: TrialRecord | null;
  error: string | null;
}
export interface RepeatResult {
  repeat: number;
  score: Score;
  /** Indices into the batch's ordered trial log. */
  trials: number[];
  error: string | null;
}
export interface ArmReport {
  arm: string;
  repeats: RepeatResult[];
  scores: Score[];
  median: number | "fail" | "unmeasured";
  spread: Measured;
  errored: number;
  start_of_session_tokens_median: Measured;
  total_tokens_median: Measured;
  duplicates_created_counts: Measured[];
  sources_read_counts: Measured[];
  duplicates_created: Measured;
  sources_read: Measured;
}
export interface ScenarioReport {
  fixture_id: string;
  fixture_sha: string;
  fixture_path: string;
  snapshot_path: string;
  extra_repeats: boolean;
  arms: ArmReport[];
}
export interface BatchReport {
  status: "completed" | "aborted";
  abort_reason: string | null;
  started_at: string;
  finished_at: string;
  substrate: string;
  requested_model: string;
  model: string | null;
  cli: TrialRecord["cli"] | null;
  scenarios: ScenarioReport[];
  trials: BatchTrial[];
}
export interface BatchResult { report: BatchReport; outDir: string }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function median(values: readonly number[]): Measured {
  if (values.length === 0) return "unmeasured";
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Fail is the ordinal step beyond H3; errors are missing evidence, never fail. */
function hintStats(scores: readonly Score[]): Pick<ArmReport, "median" | "spread"> {
  const ranked = scores.flatMap((score) => score === "errored" ? [] : [score === "fail" ? 4 : score]);
  const center = median(ranked);
  return {
    median: center === 4 ? "fail" : center,
    spread: ranked.length === 0 ? "unmeasured" : Math.max(...ranked) - Math.min(...ranked),
  };
}

function sumMeasured(values: readonly Measured[]): Measured {
  if (values.some((value) => value === "unmeasured")) return "unmeasured";
  return (values as number[]).reduce((sum, value) => sum + value, 0);
}

function summarize(arm: ArmReport, trials: readonly BatchTrial[]): void {
  arm.scores = arm.repeats.map((repeat) => repeat.score);
  Object.assign(arm, hintStats(arm.scores));
  arm.errored = arm.scores.filter((score) => score === "errored").length;
  const attempted = arm.repeats.flatMap((repeat) => repeat.trials.map((index) => trials[index]));
  const tokenMedian = (key: "start_of_session_tokens" | "total_tokens"): Measured => {
    const values = attempted.map((trial) => trial.record?.[key] ?? "unmeasured");
    return values.some((value) => value === "unmeasured") ? "unmeasured" : median(values as number[]);
  };
  arm.start_of_session_tokens_median = tokenMedian("start_of_session_tokens");
  arm.total_tokens_median = tokenMedian("total_tokens");
  const counts = (key: "duplicates_created" | "sources_read"): Measured[] => arm.repeats.map((repeat) =>
    sumMeasured(repeat.trials.map((index) => trials[index].record?.[key].length ?? "unmeasured")));
  arm.duplicates_created_counts = counts("duplicates_created");
  arm.sources_read_counts = counts("sources_read");
  arm.duplicates_created = sumMeasured(arm.duplicates_created_counts);
  arm.sources_read = sumMeasured(arm.sources_read_counts);
}

function emptyArm(arm: string): ArmReport {
  return {
    arm, repeats: [], scores: [], median: "unmeasured", spread: "unmeasured", errored: 0,
    start_of_session_tokens_median: "unmeasured", total_tokens_median: "unmeasured",
    duplicates_created_counts: [], sources_read_counts: [], duplicates_created: 0, sources_read: 0,
  };
}

function drift(report: BatchReport, record: TrialRecord, loaded: LoadedFixture, arm: string, hint: Hint): string | null {
  if (record.fixture_id !== loaded.fixture.id || record.fixture_sha !== loaded.sha || record.arm !== arm || record.hint_level !== hint || record.substrate !== report.substrate) {
    return "Trial identity differs from its frozen batch request";
  }
  if (!record.model || !record.cli.version || record.cli.version === "unknown") return "Trial model or CLI version is unmeasured";
  if (report.model !== null && record.model !== report.model) return `Model drift: ${report.model} -> ${record.model}`;
  if (report.cli !== null && (record.cli.name !== report.cli.name || record.cli.version !== report.cli.version)) {
    return `CLI drift: ${report.cli.name}@${report.cli.version} -> ${record.cli.name}@${record.cli.version}`;
  }
  report.model ??= record.model;
  report.cli ??= { ...record.cli };
  return null;
}

function cell(value: unknown): string { return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>").replaceAll("\r", ""); }

export function renderMarkdown(report: BatchReport): string {
  const lines = [
    "# Knowledge-orientation batch", "", `Status: ${report.status}`,
    `Model: ${cell(report.model ?? "unmeasured")}; CLI: ${cell(report.cli === null ? "unmeasured" : `${report.cli.name}@${report.cli.version}`)}`,
    `Substrate: ${cell(report.substrate)}`, `Started: ${report.started_at}; finished: ${report.finished_at}`, "",
    "Scores: lowest passing H0–H3; fail ranks 4 (beyond H3) for median/spread. Errored repeats are excluded from hint statistics and counted separately. Fractional medians are ordinal midpoints.",
    "Token medians cover all attempted fresh trials, including failed hint levels. Any missing measurement makes that median unmeasured. Counts sum all attempted hints; per-repeat counts are in parentheses. Separate batches are not arm comparisons.", "",
    "| Fixture | Arm | Scores | Median | Spread | Errored | Start tokens median | Total tokens median | Duplicates | Sources read |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const scenario of report.scenarios) for (const arm of scenario.arms) {
    lines.push(`| ${[
      scenario.fixture_id, arm.arm, arm.scores.join(", "), arm.median, arm.spread, arm.errored,
      arm.start_of_session_tokens_median, arm.total_tokens_median,
      `${arm.duplicates_created} (${arm.duplicates_created_counts.join(", ")})`,
      `${arm.sources_read} (${arm.sources_read_counts.join(", ")})`,
    ].map(cell).join(" | ")} |`);
  }
  if (report.abort_reason !== null) lines.push("", `Aborted: ${cell(report.abort_reason)}`);
  const errors = report.trials.filter((trial) => trial.error !== null);
  if (errors.length > 0) {
    lines.push("", "## Errors", "");
    for (const trial of errors) lines.push(`- ${cell(trial.fixture_id)} / ${cell(trial.arm)} / repeat ${trial.repeat} / H${trial.hint_level}: ${cell(trial.error)}`);
  }
  return `${lines.join("\n")}\n`;
}

function writeReports(outDir: string, report: BatchReport): void {
  for (const [file, content] of [["report.json", `${JSON.stringify(report, null, 2)}\n`], ["report.md", renderMarkdown(report)]]) {
    writeFileSync(join(outDir, `${file}.tmp`), content);
    renameSync(join(outDir, `${file}.tmp`), join(outDir, file));
  }
}

export async function runBatch(options: BatchOptions, deps: BatchDeps): Promise<BatchResult> {
  if (options.arms.length < 1 || options.arms.length > 2 || new Set(options.arms.map((arm) => arm.label)).size !== options.arms.length) {
    throw new TrialUsageError("--arms requires one or two distinct arm labels");
  }
  if (options.fixtures.length === 0) throw new TrialUsageError("No fixtures selected");
  const substrate = canonicalSubstrate(options.substrate);
  for (const arm of options.arms) validateTrialOptions({ ...options, substrate, fixture: "", arm: arm.label, homeSource: arm.homeSource, hint: 0 });
  const store = storeRoot(options.somaHome);
  const loaded = options.fixtures.map((ref) => loadFixture(ref, store));
  if (new Set(loaded.map((item) => item.fixture.id)).size !== loaded.length) throw new TrialUsageError("Duplicate fixture id selected");
  let outDir: string;
  if (options.out !== undefined) {
    outDir = resolveInsideStore(options.out, store, "batch output path");
    // Never reuse a batch directory: separate batches cannot silently share evidence.
    mkdirSync(dirname(outDir), { recursive: true });
    mkdirSync(outDir, { recursive: false });
  } else {
    const batches = resolveInsideStore(join(store, "batches"), store, "batch output path");
    mkdirSync(batches, { recursive: true });
    outDir = mkdtempSync(join(batches, "batch-"));
  }
  mkdirSync(join(outDir, "fixtures"));
  const report: BatchReport = {
    status: "completed", abort_reason: null, started_at: new Date().toISOString(), finished_at: "",
    substrate, requested_model: options.model, model: null, cli: null, trials: [],
    scenarios: loaded.map((item) => {
      const snapshot = join(outDir, "fixtures", `${item.fixture.id}.json`);
      // Keep the exact fixture bytes (and their hash), not a reserialized copy.
      writeFileSync(snapshot, readFileSync(item.path));
      if (loadFixture(snapshot, store).sha !== item.sha) throw new TrialUsageError(`Fixture changed while freezing: ${item.path}`);
      return {
        fixture_id: item.fixture.id, fixture_sha: item.sha, fixture_path: item.path, snapshot_path: snapshot,
        extra_repeats: false, arms: options.arms.map((arm) => emptyArm(arm.label)),
      };
    }),
  };
  async function runRepeat(scenario: ScenarioReport, fixture: LoadedFixture, repeat: number): Promise<boolean> {
    const pending = scenario.arms.map((arm) => {
      const result: RepeatResult = { repeat, score: "errored", trials: [], error: null };
      arm.repeats.push(result);
      return { arm, result, done: false };
    });
    for (const hint of [0, 1, 2, 3] as const) {
      for (const [index, state] of pending.entries()) {
        if (state.done) continue;
        const attempt: BatchTrial = {
          fixture_id: scenario.fixture_id, arm: state.arm.arm, repeat, hint_level: hint,
          record_path: null, record: null, error: null,
        };
        state.result.trials.push(report.trials.length);
        report.trials.push(attempt);
        try {
          const trial = await deps.trial({
            ...options, substrate, fixture: scenario.snapshot_path, arm: state.arm.arm,
            homeSource: options.arms[index].homeSource, hint, out: join(outDir, "trials"),
          });
          attempt.record = trial.record;
          attempt.record_path = trial.recordPath;
        } catch (error) {
          attempt.error = message(error);
        }
        if (attempt.record !== null) {
          const mismatch = drift(report, attempt.record, fixture, state.arm.arm, hint);
          if (mismatch !== null) {
            report.status = "aborted";
            report.abort_reason = mismatch;
            attempt.error = mismatch;
          } else if (attempt.record.outcome === "errored") {
            attempt.error = attempt.record.error ?? "Trial errored";
          } else if (attempt.record.probe_exit === null) {
            attempt.error = "Acceptance probe did not exit normally";
          }
        }
        if (attempt.error !== null) {
          state.result.error = attempt.error;
          state.done = true;
        } else if (attempt.record?.probe_exit === 0) {
          state.result.score = hint;
          state.done = true;
        } else if (hint === 3) {
          state.result.score = "fail";
          state.done = true;
        }
        if (report.status === "aborted") {
          // Do not leave phantom errored repeats for arms that were never attempted.
          for (const other of pending) {
            if (other.result.trials.length === 0) other.arm.repeats.pop();
            else if (!other.done) other.result.error = `Batch aborted: ${report.abort_reason}`;
          }
          return true;
        }
      }
    }
    return false;
  }
  scenarios: for (const [index, scenario] of report.scenarios.entries()) {
    for (let repeat = 1; repeat <= 3; repeat += 1) {
      if (await runRepeat(scenario, loaded[index], repeat)) break scenarios;
    }
    scenario.extra_repeats = scenario.arms.some((arm) => {
      const spread = hintStats(arm.repeats.map((repeat) => repeat.score)).spread;
      return typeof spread === "number" && spread > 1;
    });
    if (scenario.extra_repeats) for (let repeat = 4; repeat <= 5; repeat += 1) {
      if (await runRepeat(scenario, loaded[index], repeat)) break scenarios;
    }
  }
  for (const scenario of report.scenarios) for (const arm of scenario.arms) summarize(arm, report.trials);
  report.finished_at = new Date().toISOString();
  writeReports(outDir, report);
  return { report, outDir };
}

const USAGE = "Usage: bun run knowledge-eval batch --arms <a>[,<b>] --home-source <dir> --substrate claude " +
  "[--fixtures <id,...>] [--arm-home <label>=<dir>] [--model <id>] [--soma-home <dir>] [--out <new-dir>] " +
  "[--timeout-ms <n>] [--probe-timeout-ms <n>] [--claude-bin <path>] [--keep]";

export function parseArgs(argv: readonly string[]): { options: BatchOptions; claudeBin: string } {
  if (argv[0] !== "batch") throw new TrialUsageError(USAGE);
  const trialArgs = ["trial", "--fixture", "batch", "--arm", "batch"];
  let labels: string[] = [];
  let fixtures: string[] | undefined;
  const homes = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--arms" || flag === "--fixtures" || flag === "--arm-home") {
      const value = argv.at(++index);
      if (value === undefined || value.startsWith("--")) throw new TrialUsageError(`${flag} requires a value.\n${USAGE}`);
      if (flag === "--arms") labels = value.split(",");
      if (flag === "--fixtures") fixtures = value.split(",");
      if (flag === "--arm-home") {
        const equal = value.indexOf("=");
        if (equal <= 0 || equal === value.length - 1) throw new TrialUsageError("--arm-home requires <label>=<dir>");
        const label = value.slice(0, equal);
        if (homes.has(label)) throw new TrialUsageError(`Duplicate --arm-home: ${label}`);
        homes.set(label, value.slice(equal + 1));
      }
    } else if (flag === "--hint" || flag === "--fixture" || flag === "--arm") {
      throw new TrialUsageError(`Batch does not take ${flag}.\n${USAGE}`);
    } else {
      trialArgs.push(flag);
      if (flag !== "--keep") {
        const value = argv.at(++index);
        if (value === undefined || value.startsWith("--")) throw new TrialUsageError(`${flag} requires a value.\n${USAGE}`);
        trialArgs.push(value);
      }
    }
  }
  if (labels.length < 1 || labels.length > 2 || labels.some((label) => label === "") || new Set(labels).size !== labels.length) {
    throw new TrialUsageError(`--arms requires one or two distinct arm labels.\n${USAGE}`);
  }
  for (const label of homes.keys()) if (!labels.includes(label)) throw new TrialUsageError(`--arm-home names an unselected arm: ${label}`);
  const parsed = parseTrialArgs(trialArgs);
  if (fixtures === undefined) {
    const directory = resolveInsideStore(join(storeRoot(parsed.options.somaHome), "fixtures"), storeRoot(parsed.options.somaHome), "fixtures path");
    fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => join(directory, name));
  }
  return {
    claudeBin: parsed.claudeBin,
    options: { ...parsed.options, fixtures, arms: labels.map((label) => ({ label, homeSource: resolve(homes.get(label) ?? parsed.options.homeSource) })) },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    const deps = defaultTrialDeps(parsed.claudeBin);
    const { report, outDir } = await runBatch(parsed.options, { trial: (options) => runTrial(options, deps) });
    console.log(`${report.status}: ${join(outDir, "report.json")}\n${join(outDir, "report.md")}`);
    return report.status === "aborted" || report.scenarios.some((scenario) => scenario.arms.some((arm) => arm.errored > 0)) ? 1 : 0;
  } catch (error) {
    console.error(message(error));
    return error instanceof TrialUsageError ? 2 : 1;
  }
}
