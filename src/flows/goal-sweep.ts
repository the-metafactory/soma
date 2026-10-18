import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { listGoalRecords } from "../goal-records";
import { localDate } from "./workdays";
import { publishRunFinished, type RunFinishedPublisher, type RunFinishedResult, type RunLedgerEnv } from "./run-ledger";
import type { GoalRecord } from "../types";
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
  try {
    const schema = z.object({ repos: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)) }).strict();
    return [...new Set(schema.parse(Bun.YAML.parse(content)).repos)];
  } catch {
    throw new Error("Invalid sweep.yaml: expected repos: [owner/name, ...]");
  }
}

/** Read only the fields the sweep consumes; never return blueprint payloads. */
export async function readGoalSweepBlueprints(dir: string): Promise<GoalSweepBlueprint[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
  const { listVsas, vsaPath } = await import("../vsa/index");
  const { z } = await import("zod");
  const schema = z.object({
    serves: z.string().optional(), phase: z.string().default("observe"), updated: z.string().default(""),
  });
  return Promise.all((await listVsas({ somaHome })).map(async ({ slug }) => {
    const raw = await readFile(vsaPath(somaHome, slug), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)?.[1];
    // The general VSA parser defaults an absent update to now. Measurements
    // must use the recorded timestamp so a missing date cannot imply pursuit.
    return schema.parse(frontmatter === undefined ? {} : Bun.YAML.parse(frontmatter));
  }));
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
  const createStore = !deps.graphStore && repos.status === "fulfilled" && repos.value?.length
    ? (await import("../graph/index")).createGitHubGraphStore : undefined;
  const store = deps.graphStore ?? ((repo: string) => {
    if (!createStore) throw new Error("GraphStore unavailable");
    return createStore({ repo });
  });

  for (const goal of goals) {
    let pursuitFailed = vsas.status === "rejected" || blueprints.status === "rejected" || repos.status === "rejected";
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
      pursuitFailed = true;
      stderr(`soma goal sweep: invalid VSA update for ${goal.id}; pursuit check failed`);
    }
    if (blueprints.status === "fulfilled") {
      pursued ||= blueprints.value.some((blueprint) => blueprint.serves?.goal === goal.id
        && blueprint.id !== goal.sensor && blueprint.policy !== "disabled" && Boolean(blueprint.when?.schedule));
    }
    if (repos.status === "fulfilled") {
      for (const repo of new Set(repos.value ?? [])) {
        try {
          const graph = store(repo);
          if (!graph.listOpenRoots) throw new Error("GraphStore cannot list roots");
          for (const root of await graph.listOpenRoots(goal.id)) {
            if (root.status !== "open" || root.node.serves !== goal.id) continue;
            const subtree = await graph.readSubtree(root.ref, { includeCurrentCloseReceipt: false });
            const active = [root, ...subtree].some((node) => recent(node.updatedAt));
            pursued ||= active;
          }
        } catch {
          pursuitFailed = true;
          stderr(`soma goal sweep: cannot read map roots in ${repo} for ${goal.id}; pursuit check failed`);
        }
      }
    }
    const values: [string, GoalSweepValue | undefined][] = [
      ["pursuit", pursuitFailed ? undefined : pursued ? "ok" : "regressed"],
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
