import { createHash } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { isEnoent } from "./core";
import { goalKinds } from "./goal-kinds/registry";
import type { GoalKind } from "./goal-kinds/types";
import { addGoalRecord } from "./goal-records";
import { loadGoalResources, parseGoalResources, resolveGoalResource, type GoalResource } from "./home/index";

const DAY_MS = 86_400_000;
const RESOURCE_REF = /^<resource:([a-z][a-z0-9_-]*)>$/;
const line = z.string().refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value));
const selectionSchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
  params: z.record(z.string(), z.unknown()),
  schedule: z.strictObject({ schedule: z.string().min(1), timezone: z.string().min(1) }),
  state_rule: z.string().optional(),
});
const proposalSchema = z.strictObject({
  version: z.literal(1),
  outcome: z.enum(["fit", "no_fit"]),
  created_at: z.iso.datetime(),
  wording: line,
  supports: z.array(z.string().regex(/^M\d+$/)),
  review_by: z.iso.date(),
  drop: line,
  sensor: selectionSchema.nullable().optional(),
  mechanisms: z.array(selectionSchema),
  rationale: z.string(),
  overlaps: z.array(z.string()).optional(),
  mechanism_gap: z.string().optional(),
  needed_kind: z.string().optional(),
  resources: z.array(z.unknown()).default([]),
  warnings: z.array(z.string()).default([]),
});

export interface GoalAcceptDeps {
  clock?: () => Date;
  resources?: readonly GoalResource[];
  registry?: Readonly<Record<string, GoalKind>>;
}

export interface GoalAcceptResult {
  goalId: string;
  activationIds: string[];
}

/** Only controlled diagnostics may cross the CLI boundary. */
class GoalAcceptError extends Error {}

type Selection = z.output<typeof selectionSchema>;

function resolveSelection(selection: Selection, role: GoalKind["role"], registry: Readonly<Record<string, GoalKind>>, resources: readonly GoalResource[]) {
  const kind = Object.hasOwn(registry, selection.kind) ? registry[selection.kind] : undefined;
  if (kind?.id !== selection.kind || kind.role !== role) throw new GoalAcceptError("Invalid goal proposal: unregistered kind or role");
  const params: Record<string, unknown> = { ...selection.params, goal: "G0" };
  for (const [name, type] of Object.entries(kind.private)) {
    if (!type || params[name] === undefined) continue;
    const ref = typeof params[name] === "string" ? RESOURCE_REF.exec(params[name])?.[1] : undefined;
    if (!ref) throw new GoalAcceptError("Invalid goal proposal: private parameters must name resources");
    const value = resolveGoalResource(resources, ref, type);
    if (value === undefined) throw new GoalAcceptError("Goal proposal resource is missing or has the wrong type");
    params[name] = value;
  }
  // Some schemas also permit placeholders for catalog display; staging must not.
  if (Object.values(params).some((value) => typeof value === "string" && RESOURCE_REF.test(value))) {
    throw new GoalAcceptError("Goal proposal contains an unresolved resource");
  }
  const parsed = kind.params.safeParse(params);
  if (!parsed.success) throw new GoalAcceptError("Invalid goal proposal: kind parameters");
  return { selection, kind, params: parsed.data };
}

/** Consume a content-bound private design; never install or publish anything. */
export async function acceptGoalProposal(goalsDir: string, hash: string, deps: GoalAcceptDeps = {}): Promise<GoalAcceptResult> {
  try {
    return await accept(goalsDir, hash, deps);
  } catch (error) {
    if (error instanceof GoalAcceptError) throw error;
    // Filesystem and YAML/Zod diagnostics can quote private values.
    throw new GoalAcceptError("Goal acceptance failed; check the private proposal and local resources");
  }
}

async function accept(goalsDir: string, hash: string, deps: GoalAcceptDeps): Promise<GoalAcceptResult> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new GoalAcceptError("Goal proposal hash must be a SHA-256 hex digest");
  const proposalPath = join(goalsDir, "proposals", `${hash}.yaml`);
  let content: string;
  let modifiedAt: number;
  try {
    content = await readFile(proposalPath, "utf8");
    modifiedAt = (await stat(proposalPath)).mtimeMs;
  } catch (error) {
    if (isEnoent(error)) throw new GoalAcceptError("Goal proposal does not exist");
    throw error;
  }
  if (createHash("sha256").update(content).digest("hex") !== hash) throw new GoalAcceptError("Goal proposal hash mismatch: file changed");
  const parsed = proposalSchema.safeParse(Bun.YAML.parse(content));
  if (!parsed.success) throw new GoalAcceptError("Invalid goal proposal structure");
  const proposal = parsed.data;
  const now = (deps.clock ?? (() => new Date()))().getTime();
  const age = now - Date.parse(proposal.created_at);
  if (!Number.isFinite(age) || age < 0) throw new GoalAcceptError("Invalid goal proposal creation time");
  if (age > DAY_MS || now - modifiedAt > DAY_MS) throw new GoalAcceptError("Goal proposal is older than 24 h; propose again");
  if ((proposal.outcome === "fit") !== Boolean(proposal.sensor)) throw new GoalAcceptError("Invalid goal proposal: sensor does not match outcome");

  // Proposal-local overrides win over resources.yaml by exact name/type pair.
  const overrides = parseGoalResources(stringify(proposal.resources), "proposal");
  const resources = [...overrides, ...(deps.resources ?? await loadGoalResources({ somaHome: dirname(dirname(goalsDir)) }))];
  const registry = deps.registry ?? goalKinds;
  const selections = [
    ...(proposal.sensor ? [resolveSelection(proposal.sensor, "sensor", registry, resources)] : []),
    ...proposal.mechanisms.map((mechanism) => resolveSelection(mechanism, "mechanism", registry, resources)),
  ];
  if (new Set(selections.map(({ kind }) => kind.id)).size !== selections.length) {
    throw new GoalAcceptError("Invalid goal proposal: duplicate kind");
  }

  // Serialize consumption of this proposal, including across CLI processes.
  const lockPath = `${proposalPath}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GoalAcceptError("Goal proposal is already being accepted");
    throw error;
  }
  try {
    // A competing accept may have finished after our initial read.
    let current: string;
    try {
      current = await readFile(proposalPath, "utf8");
    } catch (error) {
      if (isEnoent(error)) throw new GoalAcceptError("Goal proposal does not exist");
      throw error;
    }
    if (current !== content) throw new GoalAcceptError("Goal proposal hash mismatch: file changed");
    return await writeAcceptedGoal(goalsDir, proposalPath, proposal, selections);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

async function writeAcceptedGoal(
  goalsDir: string, proposalPath: string, proposal: z.output<typeof proposalSchema>,
  selections: ReturnType<typeof resolveSelection>[],
): Promise<GoalAcceptResult> {
  const goalId = await addGoalRecord(goalsDir, (id) => ({
    wording: proposal.wording, supports: proposal.supports, reviewBy: proposal.review_by,
    ...(proposal.sensor ? { sensor: `${id.toLowerCase()}-${proposal.sensor.kind}` } : {}),
    body: `\nDrop: ${proposal.drop}\n\nMechanisms:\n${proposal.mechanisms.map((mechanism) =>
      `- ${id.toLowerCase()}-${mechanism.kind}: ${JSON.stringify(mechanism.params)}`,
    ).join("\n") || "None."}\n`,
  }));
  const activations = selections.map(({ selection, kind, params }) => ({
    id: `${goalId.toLowerCase()}-${kind.id}`, target: kind.target,
    serves: { goal: goalId }, when: selection.schedule,
    payload: { ...params, goal: goalId },
  }));
  const stagePath = join(goalsDir, `${goalId}.activations.yaml`);
  let stageCreated = false;
  try {
    const file = await open(stagePath, "wx", 0o600);
    stageCreated = true;
    try {
      await file.writeFile(stringify({ schema: "metafactory/activation/v1", activations }), "utf8");
    } finally {
      await file.close();
    }
    await unlink(proposalPath);
  } catch (error) {
    // Keep a retryable proposal and avoid leaving a partially accepted design.
    if (stageCreated) await unlink(stagePath);
    await unlink(join(goalsDir, `${goalId}.md`));
    throw error;
  }
  return { goalId, activationIds: activations.map(({ id }) => id) };
}
