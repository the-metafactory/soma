import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Baseline, ErrataReport, MetricResult, Regression } from "./harness-eval";

const receiptSchema = z.object({
  version: z.literal(1),
  evaluatedAt: z.iso.datetime(),
  windowDays: z.number().positive(),
  result: z.enum(["ok", "regressed", "could-not-run"]),
  coverageComplete: z.boolean(),
  inputs: z.array(z.object({ source: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() })),
  metrics: z.array(z.object({
    id: z.string(),
    value: z.union([z.number(), z.object({ checks: z.array(z.object({ check: z.string(), count: z.number() })), unlinked: z.number() })]).nullable(),
    baseline: z.number().nullable(),
    tolerance: z.number().nullable(),
    status: z.enum(["pass", "fail", "unavailable"]),
  })),
  regressions: z.array(z.object({ id: z.string(), message: z.string() })),
});

export type EvalReceipt = z.infer<typeof receiptSchema>;

export function parseEvalBaseline(text: string): Baseline {
  return z.object({
    capturedAt: z.string(),
    windowDays: z.number().positive(),
    metrics: z.record(z.string(), z.object({ value: z.number().nullable(), denominator: z.number() })),
  }).parse(JSON.parse(text));
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export class EvalInputs {
  readonly inputs: EvalReceipt["inputs"] = [];
  runsAvailable = true;

  read(source: string): string {
    try {
      const text = readFileSync(source, "utf8");
      this.inputs.push({ source, sha256: sha256(text) });
      return text;
    } catch (error) {
      this.inputs.push({ source, sha256: null });
      throw error;
    }
  }
}

export function createEvalReceipt(options: {
  now: Date;
  windowDays: number;
  results: MetricResult[];
  specs: { id: string; tolerance: number; minSample: number }[];
  errata: ErrataReport;
  baseline: Baseline | null;
  regressions: Regression[];
  coverageComplete: boolean;
  runsAvailable: boolean;
  result: EvalReceipt["result"];
  inputs: EvalReceipt["inputs"];
}): EvalReceipt {
  const { baseline, coverageComplete, errata, regressions } = options;
  const metrics: EvalReceipt["metrics"] = options.results.map((metric) => {
    const spec = options.specs.find((candidate) => candidate.id === metric.id);
    const base = baseline?.windowDays === options.windowDays ? baseline.metrics[metric.id]?.value ?? null : null;
    const available = coverageComplete && (options.runsAvailable || metric.id === "memory_loop_closure") &&
      metric.value !== null && base !== null && spec !== undefined && metric.denominator >= spec.minSample;
    return {
      id: metric.id,
      value: metric.value,
      baseline: base,
      tolerance: spec?.tolerance ?? null,
      status: !available ? "unavailable" : regressions.some((regression) => regression.id === metric.id) ? "fail" : "pass",
    };
  });
  metrics.push(
    {
      id: "rejected_passes",
      value: errata.rejected_passes === "n/a" || errata.errata_unlinked === "n/a"
        ? null : { checks: errata.rejected_passes, unlinked: errata.errata_unlinked },
      baseline: null, tolerance: null, status: "unavailable",
    },
    {
      id: "errata_fix_closure",
      value: errata.errata_fix_closure === "n/a" ? null : errata.errata_fix_closure.value,
      baseline: null, tolerance: null, status: "unavailable",
    },
  );
  return {
    version: 1,
    evaluatedAt: options.now.toISOString(),
    windowDays: options.windowDays,
    result: options.result,
    coverageComplete,
    inputs: options.inputs,
    metrics,
    regressions: regressions.map(({ id, message }) => ({ id, message })),
  };
}

export function writeEvalReceipt(stateDir: string, receipt: EvalReceipt): string {
  const directory = join(stateDir, "harness-eval");
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${receipt.evaluatedAt.slice(0, 10)}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}

export function readEvalTrend(stateDir: string): string[] {
  const directory = join(stateDir, "harness-eval");
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return files.filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort().map((file) => {
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(join(directory, file), "utf8")));
    return `${file.slice(0, 10)} RESULT ${receipt.result} ` + receipt.metrics.map((metric) =>
      `${metric.id}=${JSON.stringify(metric.value)} (${metric.status})`).join("; ");
  });
}
