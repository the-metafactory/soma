import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listGoalRecords } from "../goal-records";
import { localDate } from "./workdays";
import { publishRunFinished, type RunFinishedPublisher, type RunFinishedResult, type RunLedgerEnv } from "./run-ledger";
import type { GoalRecord } from "../goal-records";
import type { GraphStore } from "../graph/index";

const DAY_MS = 86_400_000;
export type GoalSweepValue = "ok" | "regressed";
export interface GoalSweepVsa { serves?: string; phase: string; updated: string }
export interface GoalSweepBlueprint {
  id: string;
  serves?: { goal?: string };
  policy?: "auto" | "approval" | "disabled";
  when?: { schedule?: string };
}
export type GoalSweepGraphStore = Pick<GraphStore, "listOpenRoots" | "readSubtree">;
export interface GoalSweepDeps {
  somaHome: string;
  activationsDir: string;
  goals?: readonly GoalRecord[];
  listVsas?: () => Promise<readonly GoalSweepVsa[]>;
  readBlueprints?: () => Promise<readonly GoalSweepBlueprint[]>;
  /** Undefined means sweep.yaml is absent, as distinct from an empty allowlist. */
  readRepos?: () => Promise<readonly string[] | undefined>;
  graphStore?: (repo: string) => GoalSweepGraphStore;
  now?: () => Date;
  runId?: () => string;
  env?: RunLedgerEnv;
  publish?: RunFinishedPublisher;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}
export interface GoalSweepCheck {
  subject: string;
  outcome: "succeeded" | "failed";
  value?: GoalSweepValue;
  publication: RunFinishedResult;
}
export interface GoalSweepResult { exitCode: 0 | 1; checks: GoalSweepCheck[] }

export async function readGoalSweepRepos(somaHome: string): Promise<string[] | undefined> {
  let content: string;
  try {
    content = await readFile(join(somaHome, "profile", "goals", "sweep.yaml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read sweep.yaml", { cause: error });
  }
  const { z } = await import("zod");
  const { parseRepoRef } = await import("../graph/index");
  const graphRepo = z.string().superRefine((text, ctx) => {
    try {
      parseRepoRef(graphRepoRef(text));
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid graph ref" });
    }
  });
  try {
    const schema = z.object({ repos: z.array(graphRepo) }).strict();
    return [...new Set(schema.parse(Bun.YAML.parse(content)).repos)];
  } catch {
    throw new Error("Invalid sweep.yaml: expected repos: [owner/name | forge:host/path, ...]");
  }
}

/** A bare `owner/name` is a github.com repository; anything else must already be a qualified ref. */
function graphRepoRef(repo: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) ? `github:github.com/${repo}` : repo;
}

/** Read only the fields the sweep consumes; never return blueprint payloads. */
export async function readGoalSweepBlueprints(dir: string): Promise<GoalSweepBlueprint[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    // A missing directory is a failed read, not an empty one: an empty one would
    // publish a regression for every goal's sensor and pursuit.
    throw new Error("Cannot read Reflex blueprints", { cause: error });
  }
  const { z } = await import("zod");
  const schema = z.object({
    schema: z.literal("metafactory/activation/v1"),
    activations: z.array(z.object({
      id: z.string().min(1),
      serves: z.object({ goal: z.string().regex(/^G\d+$/).optional() }).optional(),
      policy: z.enum(["auto", "approval", "disabled"]).optional(),
      when: z.object({ schedule: z.string().min(1).optional() }).optional(),
    })),
  });
  const blueprints: GoalSweepBlueprint[] = [];
  for (const file of files.filter((file) => file.endsWith(".yaml")).sort()) {
    try {
      blueprints.push(...schema.parse(Bun.YAML.parse(await readFile(join(dir, file), "utf8"))).activations);
    } catch {
      // YAML/Zod errors can quote private payloads. Keep diagnostics structural.
      throw new Error("Cannot read or parse Reflex blueprint");
    }
  }
  return blueprints;
}

async function readGoalSweepVsas(somaHome: string): Promise<GoalSweepVsa[]> {
  const { listVsas, readVsaRecordedFields } = await import("../vsa/index");
  return Promise.all((await listVsas({ somaHome })).map(async ({ slug }) => {
    const { serves, phase, updated } = await readVsaRecordedFields(slug, { somaHome });
    // Measurements use the recorded timestamp: a missing date must not imply pursuit.
    return { ...(serves === undefined ? {} : { serves }), phase, updated: updated ?? "" };
  }));
}

interface PursuitSources {
  vsas: PromiseSettledResult<readonly GoalSweepVsa[]>;
  blueprints: PromiseSettledResult<readonly GoalSweepBlueprint[]>;
  repos: PromiseSettledResult<readonly string[] | undefined>;
  store: (repo: string) => GoalSweepGraphStore;
  started: Date;
  stderr: (line: string) => void;
}

/** undefined means a source could not be read, which is not a regression. */
async function evaluatePursuit(goal: GoalRecord, sources: PursuitSources): Promise<GoalSweepValue | undefined> {
  const { vsas, blueprints, repos, store, started, stderr } = sources;
  let failed = vsas.status === "rejected" || blueprints.status === "rejected" || repos.status === "rejected";
  const cutoff = started.getTime() - (goal.pursuitWindow ?? 14) * DAY_MS;
  const recent = (updated: string) => {
    const time = Date.parse(updated);
    if (!Number.isFinite(time)) throw new Error("Invalid update timestamp");
    return time >= cutoff && time <= started.getTime();
  };
  let pursued = false;
  try {
    pursued = vsas.status === "fulfilled" && vsas.value.some((vsa) =>
      vsa.serves === goal.id && vsa.phase !== "complete" && recent(vsa.updated));
  } catch {
    failed = true;
    stderr(`soma goal sweep: invalid VSA update for ${goal.id}; pursuit check failed`);
  }
  if (blueprints.status === "fulfilled") {
    pursued ||= blueprints.value.some((blueprint) => blueprint.serves?.goal === goal.id
      && blueprint.id !== goal.sensor && blueprint.policy !== "disabled" && Boolean(blueprint.when?.schedule));
  }
  if (repos.status === "fulfilled") {
    for (const repo of new Set(repos.value ?? [])) {
      try {
        pursued = await repoPursues(store(repo), goal, recent) || pursued;
      } catch {
        failed = true;
        stderr(`soma goal sweep: cannot read map roots in ${repo} for ${goal.id}; pursuit check failed`);
      }
    }
  }
  return failed ? undefined : pursued ? "ok" : "regressed";
}

/**
 * Every listed root is read even once pursuit is proven: a positive link must
 * not hide a read outage, so the sweep keeps scanning to surface it.
 */
async function repoPursues(graph: GoalSweepGraphStore, goal: GoalRecord, recent: (updated: string) => boolean): Promise<boolean> {
  if (!graph.listOpenRoots) throw new Error("GraphStore cannot list roots");
  let pursued = false;
  for (const root of await graph.listOpenRoots(goal.id)) {
    if (root.status !== "open" || root.node.serves !== goal.id) continue;
    const subtree = await graph.readSubtree(root.ref, { includeCurrentCloseReceipt: false });
    pursued ||= [root, ...subtree].some((node) => recent(node.updatedAt));
  }
  return pursued;
}

/** Three independent checks per active goal; failed reads never become regressions. */
export async function runGoalSweep(deps: GoalSweepDeps): Promise<GoalSweepResult> {
  const now = deps.now ?? (() => new Date());
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const env = deps.env ?? process.env;
  const goals = (deps.goals ?? await listGoalRecords(join(deps.somaHome, "profile", "goals")))
    .filter((goal) => goal.status === "active");
  const checks: GoalSweepCheck[] = [];
  if (goals.length === 0) return { exitCode: 0, checks };

  const started = now();
  const today = localDate("Europe/Zurich", started);
  const [vsas, blueprints, repos] = await Promise.allSettled([
    Promise.resolve().then(() => deps.listVsas?.() ?? readGoalSweepVsas(deps.somaHome)),
    Promise.resolve().then(() => deps.readBlueprints?.() ?? readGoalSweepBlueprints(deps.activationsDir)),
    Promise.resolve().then(() => deps.readRepos?.() ?? readGoalSweepRepos(deps.somaHome)),
  ]);
  if (vsas.status === "rejected") stderr("soma goal sweep: cannot read VSAs; pursuit checks failed");
  if (blueprints.status === "rejected") stderr("soma goal sweep: cannot read Reflex blueprints; pursuit and sensor checks failed");
  if (repos.status === "rejected") stderr("soma goal sweep: cannot read sweep.yaml; pursuit checks failed");
  if (repos.status === "fulfilled" && repos.value === undefined) {
    stderr("soma goal sweep: sweep.yaml is missing; map roots are not scanned");
  }
  const graph = !deps.graphStore && repos.status === "fulfilled" && repos.value?.length
    ? await import("../graph/index") : undefined;
  const store = deps.graphStore ?? ((repo: string) => {
    if (!graph) throw new Error("GraphStore unavailable");
    return graph.createGraphStore(graph.parseRepoRef(graphRepoRef(repo)));
  });

  for (const goal of goals) {
    const pursuit = await evaluatePursuit(goal, { vsas, blueprints, repos, store, started, stderr });
    const values: [string, GoalSweepValue | undefined][] = [
      ["pursuit", pursuit],
      ["review", goal.reviewBy !== undefined && goal.reviewBy >= today ? "ok" : "regressed"],
      ["sensor", blueprints.status === "rejected" ? undefined
        : blueprints.value.some((blueprint) => blueprint.id === goal.sensor) ? "ok" : "regressed"],
    ];
    for (const [check, value] of values) {
      const subject = `${goal.id}.${check}`;
      const outcome = value === undefined ? "failed" : "succeeded";
      const publication = await publishRunFinished({
        kind: "job", ref: `goal-sweep/${goal.id}`, runId: (deps.runId ?? randomUUID)(),
        serves: { goal: goal.id }, outcome,
        startedAt: started.toISOString(), endedAt: now().toISOString(),
        ...(value === undefined ? {} : { state: { subject, value } }),
      }, { somaHome: deps.somaHome, substrate: "custom", env, publish: deps.publish });
      checks.push({ subject, outcome, ...(value === undefined ? {} : { value }), publication });
      stdout(`${subject}\t${value ?? "failed"}`);
    }
  }
  // With no principal this is a read-only inspection, even when facts are missing.
  const failed = checks.some((check) => check.outcome === "failed" || check.publication === "failed");
  return { exitCode: env.SOMA_PRINCIPAL && failed ? 1 : 0, checks };
}
