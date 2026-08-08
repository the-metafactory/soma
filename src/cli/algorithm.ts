import {
  applyAlgorithmBatch,
  advanceAlgorithmRunUntil,
  advanceAlgorithmRun,
  algorithmPhaseOrder,
  buildReflectionDigest,
  classifyAlgorithmPrompt,
  createAlgorithmRun,
  listAlgorithmRuns,
  listAlgorithmRunSummaries,
  parsePaiReflections,
  readAlgorithmRunById,
  recordAlgorithmCapabilityInvocation,
  recordAlgorithmChange,
  recordAlgorithmDecision,
  recordAlgorithmMetaReflection,
  recordAlgorithmObservation,
  recordAlgorithmLearning,
  removeAlgorithmCapabilitySelection,
  renderReflectionDigest,
  runSomaLifecycleAlgorithmUpdated,
  requirePlanStep,
  setAlgorithmPlan,
  selectAlgorithmCapability,
  syncBridgedPlanStep,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
  writeAlgorithmRun,
  appendSomaMemoryEvent,
} from "../index";
import type { BridgedNodeReport, ReflectionForDigest } from "../index";
// VerificationGateError is a CLI-only classification detail — imported straight
// from its defining module, deliberately NOT re-exported through the public
// barrel (Sage review, PR #455): keeping it off ../index leaves the internal
// error shape free to change without a public-API break.
import { VerificationGateError } from "../algorithm";
import { readFile } from "node:fs/promises";
import { loadSomaHomeAlgorithmCapabilityRegistry, mergedAlgorithmCapabilityRegistry, registerSomaHomeAlgorithmCapabilities } from "../algorithm-capabilities";
import type { SomaHomeAlgorithmCapabilityRegistry } from "../algorithm-capabilities";
import { defaultSomaHome } from "../paths";
import { syncAlgorithmRunFromVsa, formatSyncResult } from "../algorithm-vsa-sync";
import { algorithmTouchedBy } from "../algorithm-provenance";
import { datePrefixSlug } from "../dated-slug";
import { defaultEvidenceKind, getCriteria, getGoal } from "../vsa-accessors";
import { getRunPhase } from "../algorithm-lifecycle";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";
import { readNodeForBridge } from "../work-graph-bridge";
import type {
  AlgorithmBatchOperation,
  AlgorithmEffortTier,
  AlgorithmPhase,
  AlgorithmPlanStep,
  AlgorithmRun,
  AlgorithmRunInput,
  EvidenceKind,
  SubstrateId,
} from "../types";

export const ALGORITHM_ACTIONS = [
  "new",
  "classify",
  "list",
  "show",
  "capabilities",
  "invoke",
  "remove-capability",
  "plan",
  "observe",
  "decision",
  "change",
  "step",
  "verify",
  "learn",
  "reflect",
  "reflections",
  "batch",
  "advance",
  "resume",
  "sync-from-isa",
] as const;

export type AlgorithmCliAction = (typeof ALGORITHM_ACTIONS)[number];

export const ALGORITHM_COMMAND_HELP: { usage: string; subcommands: Record<AlgorithmCliAction, string> } = {
  usage: `Usage: soma algorithm <${ALGORITHM_ACTIONS.join("|")}> ...`,
  subcommands: {
    new: "Usage: soma algorithm new --prompt <text> --intent <text> --current-state <text> --goal <text> --criterion <id:text> [--effort <E1|E2|E3|E4|E5>] [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    classify: "Usage: soma algorithm classify --prompt <text> [--json]",
    batch: "Usage: soma algorithm batch --id <run-id> --op <kind:...> [--op <kind:...>] [--substrate <id>]",
    list: "Usage: soma algorithm list [--home-dir <dir>] [--soma-home <dir>]",
    show: "Usage: soma algorithm show --id <run-id> [--home-dir <dir>] [--soma-home <dir>]",
    capabilities: "Usage: soma algorithm capabilities (--list [--substrate <id>] [--json] | --id <run-id> --capability <name> [--phase <phase>] [--reason <text>]) [--home-dir <dir>] [--soma-home <dir>]. --list shows the resolved registry (the closed vocabulary for THIS machine) plus any rows that resolved to nothing.",
    invoke: "Usage: soma algorithm invoke --id <run-id> --capability <name> --evidence <text> [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    "remove-capability": "Usage: soma algorithm remove-capability --id <run-id> --capability <name> --reason <text> [--home-dir <dir>] [--soma-home <dir>]",
    plan: "Usage: soma algorithm plan --id <run-id> --step <id:criteria:text> [--home-dir <dir>] [--soma-home <dir>]",
    observe:
      "Usage: soma algorithm observe --id <run-id> --claim <text> --evidence <text> [--evidence-kind <probed|tested|specified>] [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>] (kind defaults to specified; assert probed/tested to clear the OBSERVE floor)",
    decision: "Usage: soma algorithm decision --id <run-id> --text <text> [--home-dir <dir>] [--soma-home <dir>]",
    change: "Usage: soma algorithm change --id <run-id> --text <text> [--home-dir <dir>] [--soma-home <dir>]",
    step:
      "Usage: soma algorithm step --id <run-id> --step-id <id> (--status <open|done|blocked> [--evidence <text>] | (--node <node-id> | --sync) [--repo <owner/name>]). " +
      "--node bridges the step to a work-graph node and derives its status from it; --sync re-derives an already-bridged step. " +
      "The bridged arm takes NEITHER --status nor --evidence — both are derived from the node, which is the step's one authoritative home (docs/work-graph.md §2.7).",
    verify: "Usage: soma algorithm verify --id <run-id> --criterion-id <id> --status <passed|failed|dropped|deferred-probe> --evidence <text> [--evidence-kind <specified|probed|tested>] [--substrate <id>]",
    learn: "Usage: soma algorithm learn --id <run-id> --text <text> [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    reflect:
      "Usage: soma algorithm reflect --id <run-id> [--missed-early-step <text>] [--missed-verify-or-parallel <text>] [--highest-value-move <text>] [--satisfaction <0-10>] [--within-budget|--over-budget] [--substrate <id>] (at least one smarterRun signal required; gate-flags are computed from the run)",
    reflections:
      "Usage: soma algorithm reflections [--id <run-id>] [--digest] [--pai-source <jsonl-path>] [--home-dir <dir>] [--soma-home <dir>] (--id lists one run's reflections; --digest ranks the cross-run improvement backlog, optionally folding in a PAI reflections jsonl)",
    advance: "Usage: soma algorithm advance --id <run-id> [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    resume: "Usage: soma algorithm resume --id <run-id> --until-phase <phase> [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    "sync-from-isa":
      "Usage: soma algorithm sync-from-isa --isa <path> --substrate <id> [--soma-home <dir>] [--home-dir <dir>] [--promote-on-complete] [--principal-authority]. " +
      "--promote-on-complete requires --principal-authority (a deliberate, logged escalation) to mint the promotion's principal-trust durable note — omitting it refuses (fail-closed).",
  },
};

export interface ParsedAlgorithmArgs {
  command: "algorithm";
  action: AlgorithmCliAction;
  options: AlgorithmCliOptions;
}

interface AlgorithmCliOptions {
  homeDir?: string;
  somaHome?: string;
  run?: AlgorithmRunInput;
  id?: string;
  prompt?: string;
  capabilities?: string[];
  capabilityPhase?: AlgorithmPhase;
  capabilityReason?: string;
  planSteps?: AlgorithmPlanStep[];
  text?: string;
  claim?: string;
  stepId?: string;
  stepStatus?: AlgorithmPlanStep["status"];
  /** Work-graph node to bridge the step to (§2.7). */
  stepNodeId?: string;
  /** Re-derive an already-bridged step's status from its node. */
  stepSync?: boolean;
  /** Which repository backs the graph, when the bridge cannot infer it. */
  repo?: string;
  criterionId?: string;
  criterionStatus?: "passed" | "failed" | "dropped" | "deferred-probe";
  evidence?: string;
  evidenceKind?: EvidenceKind;
  substrate?: SubstrateId;
  untilPhase?: AlgorithmPhase;
  batchOperations?: AlgorithmBatchOperation[];
  json?: boolean;
  listCapabilities?: boolean;
  vsaPath?: string;
  promoteOnComplete?: boolean;
  principalAuthority?: boolean;
  missedEarlyStep?: string;
  missedVerifyOrParallel?: string;
  highestValueMove?: string;
  satisfaction?: number;
  withinBudget?: boolean;
  digest?: boolean;
  paiSource?: string;
}

function isAlgorithmAction(value: string | undefined): value is AlgorithmCliAction {
  return value !== undefined && (ALGORITHM_ACTIONS as readonly string[]).includes(value);
}

function parseCriterion(value: string): { id: string; text: string; verification?: string } {
  const separator = value.indexOf(":");

  if (separator === -1) {
    throw new Error("--criterion requires id:text.");
  }

  return {
    id: value.slice(0, separator).trim(),
    text: value.slice(separator + 1).trim(),
  };
}

function isAntiCriterion(criterion: { id: string }): boolean {
  return criterion.id.toLowerCase() === "anti" || criterion.id.toLowerCase().startsWith("anti-");
}

function validateAlgorithmRunInput(run: Partial<AlgorithmRunInput> & { criteria: AlgorithmRunInput["criteria"] }): void {
  const missing: string[] = [];

  if (!run.prompt) missing.push("--prompt");
  if (!run.intent) missing.push("--intent");
  if (!run.currentState) missing.push("--current-state");
  if (!run.goal) missing.push("--goal");
  if (run.criteria.length === 0) missing.push("--criterion");

  if (missing.length > 0) {
    throw new Error(`soma algorithm new is missing required option(s): ${missing.join(", ")}.`);
  }
}

function parseEffort(value: string): AlgorithmEffortTier {
  if (value === "E1" || value === "E2" || value === "E3" || value === "E4" || value === "E5") {
    return value;
  }

  throw new Error("--effort must be one of E1, E2, E3, E4, or E5.");
}

function parseStepStatus(value: string): AlgorithmPlanStep["status"] {
  if (value === "open" || value === "done" || value === "blocked") {
    return value;
  }

  throw new Error("--status must be one of open, done, or blocked.");
}

function parseCriterionStatus(value: string): "passed" | "failed" | "dropped" | "deferred-probe" {
  if (value === "passed" || value === "failed" || value === "dropped" || value === "deferred-probe") {
    return value;
  }

  throw new Error("--status must be one of passed, failed, dropped, or deferred-probe.");
}

function parseEvidenceKind(value: string): EvidenceKind {
  if (value === "specified" || value === "probed" || value === "tested") {
    return value;
  }

  throw new Error("--evidence-kind must be one of specified, probed, or tested.");
}

function parseSatisfaction(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    throw new Error("--satisfaction must be an integer between 0 and 10.");
  }
  return n;
}

function parsePlanStep(value: string): AlgorithmPlanStep {
  const [id, criteria, ...textParts] = value.split(":");
  const text = textParts.join(":").trim();

  if (!id || !criteria || !text) {
    throw new Error("--step requires id:criterion[,criterion]:text.");
  }

  return {
    id: id.trim(),
    criteriaIds: criteria
      .split(",")
      .map((criterionId) => criterionId.trim())
      .filter((criterionId) => criterionId.length > 0),
    text,
    status: "open",
  };
}

function parseBatchOperation(value: string): AlgorithmBatchOperation {
  const [kind, ...rest] = value.split(":");
  const payload = rest.join(":").trim();

  if (kind === "decision" || kind === "change" || kind === "learn") {
    if (!payload) throw new Error(`--op ${kind} requires text.`);
    return { kind, text: payload };
  }

  if (kind === "observe") {
    // `observe:<claim>:<kind>:<evidence>` — the claim must not contain ':'.
    // Evidence is REQUIRED and not auto-derived from the claim. (Like every
    // evidence surface, the content is caller-asserted: nothing here can confirm
    // the evidence is more than a restatement — the gate makes the claim explicit
    // and auditable, it does not verify it.)
    const parts = payload.split(":");
    const claim = parts[0].trim();
    const evidence = parts.slice(2).join(":").trim();
    if (parts.length < 3 || !claim || !evidence) {
      throw new Error("--op observe requires observe:<claim>:<kind>:<evidence> (the claim must not contain ':').");
    }
    return { kind, claim, evidence, evidenceKind: parseEvidenceKind(parts[1].trim()) };
  }

  if (kind === "capability") {
    if (!payload) throw new Error("--op capability requires a capability name.");
    return { kind, capability: payload };
  }

  if (kind === "capability-invocation") {
    return parseCapabilityInvocationOperation(payload);
  }

  if (kind === "capability-removal") {
    const [capability, ...reasonParts] = payload.split(":");
    const reason = reasonParts.join(":").trim();
    if (!capability || !reason) {
      throw new Error("--op capability-removal requires capability-removal:<name>:<reason>.");
    }
    return {
      kind,
      capability: capability.trim(),
      reason,
    };
  }

  if (kind === "advance") {
    return { kind };
  }

  if (kind === "step") {
    const [stepId, status, ...evidenceParts] = payload.split(":");
    if (!stepId || !status) throw new Error("--op step requires step:<step-id>:<open|done|blocked>[:evidence].");
    return {
      kind,
      stepId: stepId.trim(),
      status: parseStepStatus(status.trim()),
      evidence: evidenceParts.join(":").trim() || undefined,
    };
  }

  if (kind === "verify") {
    const [criterionId, status, ...evidenceParts] = payload.split(":");
    const evidence = evidenceParts.join(":").trim();
    if (!criterionId || !status || !evidence) {
      throw new Error("--op verify requires verify:<criterion-id>:<passed|failed|dropped>:<evidence>.");
    }
    return {
      kind,
      criterionId: criterionId.trim(),
      status: parseCriterionStatus(status.trim()),
      evidence,
    };
  }

  throw new Error("--op must start with observe, decision, change, learn, capability, capability-invocation, capability-removal, step, verify, or advance.");
}

function parseCapabilityInvocationOperation(payload: string): AlgorithmBatchOperation {
  const parts = payload.split(":");
  const capability = parts[0];
  const restParts = parts.slice(2);
  const maybeSubstrateValue = parts.length > 1 ? parts[1].trim() : "";
  const explicitSubstrate = maybeSubstrateValue.startsWith("substrate=")
    ? maybeSubstrateValue.slice("substrate=".length)
    : undefined;
  const evidence = (explicitSubstrate ? restParts : parts.slice(1)).join(":").trim();

  if (!capability || !evidence) {
    throw new Error("--op capability-invocation requires capability-invocation:<name>:<evidence> or capability-invocation:<name>:substrate=<id>:<evidence>.");
  }

  return {
    kind: "capability-invocation",
    capability: capability.trim(),
    substrate: explicitSubstrate ? parseSubstrate(explicitSubstrate) : undefined,
    evidence,
  };
}

function parseBatchOperationsJson(value: string): AlgorithmBatchOperation[] {
  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("--ops-json must be a JSON array.");
  }

  return parsed.map((operation) => {
    if (!operation || typeof operation !== "object" || !("kind" in operation)) {
      throw new Error("--ops-json entries must be objects with kind.");
    }

    return operation as AlgorithmBatchOperation;
  });
}

function parseAlgorithmPhase(value: string, optionName = "--phase"): AlgorithmPhase {
  const phases = algorithmPhaseOrder();
  if (phases.includes(value as AlgorithmPhase)) {
    return value as AlgorithmPhase;
  }

  throw new Error(`${optionName} must be one of ${phases.join(", ")}.`);
}

export function parseAlgorithmArgs(args: string[]): ParsedAlgorithmArgs {
  const [command, action, ...rest] = args;

  if (command !== "algorithm" || !isAlgorithmAction(action)) {
    throw new Error(ALGORITHM_COMMAND_HELP.usage);
  }

  const run: Partial<AlgorithmRunInput> & { criteria: AlgorithmRunInput["criteria"] } = {
    criteria: [],
    antiCriteria: [],
  };
  const options: AlgorithmCliOptions = {};
  const capabilities: string[] = [];
  const planSteps: AlgorithmPlanStep[] = [];
  const batchOperations: AlgorithmBatchOperation[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--id":
        options.id = readOption(rest, index, arg);
        index += 1;
        break;
      case "--prompt":
        run.prompt = readOption(rest, index, arg);
        options.prompt = run.prompt;
        index += 1;
        break;
      case "--intent":
        run.intent = readOption(rest, index, arg);
        index += 1;
        break;
      case "--current-state":
        run.currentState = readOption(rest, index, arg);
        index += 1;
        break;
      case "--goal":
        run.goal = readOption(rest, index, arg);
        index += 1;
        break;
      case "--effort":
        run.effort = parseEffort(readOption(rest, index, arg));
        index += 1;
        break;
      case "--criterion":
        {
          const criterion = parseCriterion(readOption(rest, index, arg));
          if (isAntiCriterion(criterion)) {
            run.antiCriteria?.push(criterion);
          } else {
            run.criteria.push(criterion);
          }
        }
        index += 1;
        break;
      case "--anti-criterion":
        run.antiCriteria?.push(parseCriterion(readOption(rest, index, arg)));
        index += 1;
        break;
      case "--capability":
        capabilities.push(readOption(rest, index, arg));
        index += 1;
        break;
      case "--phase":
        options.capabilityPhase = parseAlgorithmPhase(readOption(rest, index, arg));
        index += 1;
        break;
      case "--until-phase":
        options.untilPhase = parseAlgorithmPhase(readOption(rest, index, arg), arg);
        index += 1;
        break;
      case "--reason":
        options.capabilityReason = readOption(rest, index, arg);
        index += 1;
        break;
      case "--substrate":
        options.substrate = parseSubstrate(readOption(rest, index, arg));
        index += 1;
        break;
      case "--step":
        planSteps.push(parsePlanStep(readOption(rest, index, arg)));
        index += 1;
        break;
      case "--text":
        options.text = readOption(rest, index, arg);
        index += 1;
        break;
      case "--claim":
        options.claim = readOption(rest, index, arg);
        index += 1;
        break;
      case "--step-id":
        options.stepId = readOption(rest, index, arg);
        index += 1;
        break;
      // Scoped to `step`, matching the `--status` arm below: an unguarded arm
      // accepts the flag on every algorithm subcommand, and two conventions in one
      // switch make the next flag's correct shape a guess.
      case "--node":
        if (action !== "step") throw new Error("--node is only valid for step.");
        options.stepNodeId = readOption(rest, index, arg);
        index += 1;
        break;
      case "--sync":
        if (action !== "step") throw new Error("--sync is only valid for step.");
        options.stepSync = true;
        break;
      case "--repo":
        if (action !== "step") throw new Error("--repo is only valid for step.");
        options.repo = readOption(rest, index, arg);
        index += 1;
        break;
      case "--status":
        if (action === "step") {
          options.stepStatus = parseStepStatus(readOption(rest, index, arg));
        } else if (action === "verify") {
          options.criterionStatus = parseCriterionStatus(readOption(rest, index, arg));
        } else {
          throw new Error("--status is only valid for step or verify.");
        }
        index += 1;
        break;
      case "--criterion-id":
        options.criterionId = readOption(rest, index, arg);
        index += 1;
        break;
      case "--evidence":
        options.evidence = readOption(rest, index, arg);
        index += 1;
        break;
      case "--evidence-kind":
        options.evidenceKind = parseEvidenceKind(readOption(rest, index, arg));
        index += 1;
        break;
      case "--op":
        batchOperations.push(parseBatchOperation(readOption(rest, index, arg)));
        index += 1;
        break;
      case "--ops-json":
        batchOperations.push(...parseBatchOperationsJson(readOption(rest, index, arg)));
        index += 1;
        break;
      case "--list":
        options.listCapabilities = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--isa":
        options.vsaPath = readOption(rest, index, arg);
        index += 1;
        break;
      case "--promote-on-complete":
        options.promoteOnComplete = true;
        break;
      case "--principal-authority":
        options.principalAuthority = true;
        break;
      case "--missed-early-step":
        options.missedEarlyStep = readOption(rest, index, arg);
        index += 1;
        break;
      case "--missed-verify-or-parallel":
        options.missedVerifyOrParallel = readOption(rest, index, arg);
        index += 1;
        break;
      case "--highest-value-move":
        options.highestValueMove = readOption(rest, index, arg);
        index += 1;
        break;
      case "--satisfaction":
        options.satisfaction = parseSatisfaction(readOption(rest, index, arg));
        index += 1;
        break;
      case "--within-budget":
        options.withinBudget = true;
        break;
      case "--over-budget":
        options.withinBudget = false;
        break;
      case "--digest":
        options.digest = true;
        break;
      case "--pai-source":
        options.paiSource = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (action === "new") {
    validateAlgorithmRunInput(run);
    const idBase = run.intent ?? run.goal ?? run.prompt;
    if (idBase === undefined) {
      throw new Error("soma algorithm new requires at least one of --intent, --goal, or --prompt.");
    }
    run.id = options.id ?? datePrefixSlug(idBase);
    run.substrate = options.substrate;
    options.run = run as AlgorithmRunInput;
  }

  if (capabilities.length > 0) {
    options.capabilities = capabilities;
  }

  if (planSteps.length > 0) {
    options.planSteps = planSteps;
  }

  if (batchOperations.length > 0) {
    options.batchOperations = batchOperations;
  }

  return {
    command,
    action,
    options,
  };
}

function formatAlgorithmRunResult(result: { path: string; run: AlgorithmRun }): string {
  return [
    "Soma Algorithm run created",
    `id: ${result.run.id}`,
    `phase: ${getRunPhase(result.run)}`,
    `effort: ${result.run.effort}`,
    `path: ${result.path}`,
  ].join("\n");
}

function formatAlgorithmCapabilityRegistry(
  registry: SomaHomeAlgorithmCapabilityRegistry,
  shadowed: readonly string[] = [],
): string {
  const lines = [`Soma Algorithm capability registry — ${registry.definitions.length} resolved`, ""];

  for (const definition of [...registry.definitions].sort((a, b) => a.name.localeCompare(b.name))) {
    // Flag CONTRACT rows so "resolved" is not read as "invocable here". Keyed on
    // the `contract` kind, not on `adapter` (Sage review): a skill manifest may
    // declare `adapter` for a capability that targets a real skill and invokes
    // fine, and flagging it would contradict what `algorithm invoke` does.
    const suffix = definition.kind === "contract" ? "  ← needs a local binding" : "";
    lines.push(`- ${definition.name} [${definition.kind}] ${definition.phases.join(",")} → ${definition.invoke.target}${suffix}`);
  }

  if (shadowed.length > 0) {
    lines.push(
      "",
      `Row did not resolve, capability still available from a built-in — ${shadowed.length}:`,
      ...shadowed.map((name) => `- ${name}`),
      "",
      "The capability above is usable, but NOT from the row you wrote: that row",
      "resolved to nothing and a compiled-in definition is answering instead.",
    );
  }

  if (registry.unsupported.length > 0) {
    lines.push(
      "",
      `Unsupported — ${registry.unsupported.length} row(s) resolved to nothing and were dropped:`,
      ...registry.unsupported.map((name) => `- ${name}`),
      "",
      "A dropped row is not selectable. Usual causes: a Skill(\"…\") target this home",
      "does not have, or an invoke cell in none of the recognised shapes.",
    );
  }

  return lines.join("\n");
}

function formatAlgorithmClassification(prompt: string): string {
  const classification = classifyAlgorithmPrompt(prompt);

  return [
    "Soma Algorithm prompt classification",
    `mode: ${classification.mode}`,
    `effort: ${classification.effort ?? "none"}`,
    `source: ${classification.source}`,
    `reason: ${classification.reason}`,
  ].join("\n");
}

function formatAlgorithmClassificationJson(prompt: string): string {
  return `${JSON.stringify(classifyAlgorithmPrompt(prompt))}\n`;
}

function formatAlgorithmRun(run: AlgorithmRun, path: string): string {
  const touchedBy = algorithmTouchedBy(run);
  return [
    "Soma Algorithm run",
    `id: ${run.id}`,
    `phase: ${getRunPhase(run)}`,
    `effort: ${run.effort}`,
    `effortSource: ${run.effortSource}`,
    `mode: ${run.mode}`,
    `classificationReason: ${run.classificationReason}`,
    `path: ${path}`,
    `goal: ${getGoal(run.vsa) ?? ""}`,
    `touched by: ${touchedBy.length > 0 ? touchedBy.join(", ") : "none"}`,
    "",
    "Criteria:",
    ...getCriteria(run.vsa).map((criterion) => `- [${criterion.status}] ${criterion.id}: ${criterion.text}${criterion.verification ? ` | ${criterion.verification}` : ""}`),
    "",
    "Plan:",
    ...(run.planSteps.length > 0
      ? run.planSteps.map(
          (step) =>
            `- [${step.status}] ${step.id}: ${step.text} (${step.criteriaIds.join(",")})` +
            // Naming the node makes the status's authority visible: without it a
            // derived status reads exactly like a hand-written one.
            (step.nodeId === undefined ? "" : ` → node ${step.nodeId}`),
        )
      : ["- none"]),
    "",
    "Capabilities:",
    ...((run.capabilitySelections ?? []).length > 0
      ? (run.capabilitySelections ?? []).map((selection) =>
          `- [${selection.status}] ${selection.name} (${selection.phase})${selection.invocation ? ` | ${selection.invocation.evidence}` : ""}`,
        )
      : run.capabilities.length > 0
        ? run.capabilities.map((capability) => `- [legacy] ${capability}`)
        : ["- none"]),
  ].join("\n");
}

function requireAlgorithmId(options: AlgorithmCliOptions): string {
  if (!options.id) {
    throw new Error("--id is required.");
  }

  return options.id;
}

function requireAlgorithmRunInput(options: AlgorithmCliOptions): AlgorithmRunInput {
  if (!options.run) {
    throw new Error("Algorithm run input is required.");
  }

  return options.run;
}

function requireText(options: AlgorithmCliOptions): string {
  if (!options.text) {
    throw new Error("--text is required.");
  }

  return options.text;
}

export async function appendVerificationGateViolationEvent(
  options: Pick<AlgorithmCliOptions, "homeDir" | "somaHome" | "substrate">,
  runId: string,
  error: VerificationGateError,
  runSubstrate?: AlgorithmRun["substrate"],
): Promise<void> {
  try {
    await appendSomaMemoryEvent(defaultSomaHome({ homeDir: options.homeDir, somaHome: options.somaHome }), {
      // Attribute to the run's own substrate when the CLI flag is absent — a
      // `verify` that omits --substrate must not mislabel a claude-code (or any)
      // run's gate refusal as "custom" telemetry.
      substrate: options.substrate ?? runSubstrate ?? "custom",
      kind: "verification.gate_violation",
      summary: `VerificationGate refused a hollow pass on ${runId}/${error.criterionId} (${error.reason}).`,
      metadata: {
        runId,
        criterionId: error.criterionId,
        reason: error.reason,
        evidenceKind: error.evidenceKind ?? null,
      },
    });
  } catch {
    // Telemetry is best-effort; the gate error itself is what matters.
  }
}

async function updateAndReportAlgorithmRun(
  options: AlgorithmCliOptions,
  update: (run: AlgorithmRun) => AlgorithmRun,
  registration: { registerCapabilities?: boolean } = {},
): Promise<string> {
  const id = requireAlgorithmId(options);
  const { run } = await readAlgorithmRunById(id, {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
  });
  const registered =
    registration.registerCapabilities === true
      ? await registerSomaHomeAlgorithmCapabilities(run, {
          homeDir: options.homeDir,
          somaHome: options.somaHome,
          substrate: run.substrate,
        })
      : run;
  let updated: AlgorithmRun;
  try {
    updated = update(registered);
  } catch (error) {
    // A VerificationGate refusal is the most on-mission signal this CLI sees —
    // an attempted hollow "done". The 2026-07-10 proxy-drift audit found it was
    // detected and then discarded (bare throw, no trace), making the hollow-pass
    // attempt rate unmeasurable. Record it before rethrowing. Every substrate
    // funnels through this CLI, so the emission is substrate-neutral by
    // construction. Best-effort: a telemetry failure must never mask the gate.
    if (error instanceof VerificationGateError) {
      await appendVerificationGateViolationEvent(options, id, error, run.substrate);
    }
    throw error;
  }
  const written = await writeAlgorithmRun(updated, {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
  });

  await runSomaLifecycleAlgorithmUpdated({
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrate: "custom",
  });

  return formatAlgorithmRun(written.run, written.path);
}

/**
 * The bridge's read path (§2.7), injectable so the planSteps tests can exercise
 * the contract without a tracker. Production resolves to `readNodeForBridge`,
 * which is `soma graph node <id>`'s own seam.
 */
export interface AlgorithmCliDeps {
  readNode: (nodeId: string, options: { repo?: string }) => Promise<BridgedNodeReport>;
}

/** Which node an already-bridged step defers to — read off the run, not argv. */
async function resolveBridgedNodeId(options: AlgorithmCliOptions, stepId: string): Promise<string> {
  const id = requireAlgorithmId(options);
  const { run } = await readAlgorithmRunById(id, { homeDir: options.homeDir, somaHome: options.somaHome });
  // The core's lookup, not a third copy of it and its message.
  const { step } = requirePlanStep(run, stepId);

  if (step.nodeId === undefined) {
    throw new Error(`Algorithm plan step ${stepId} is not bridged to a work-graph node. Bridge it with --node <node-id>.`);
  }

  return step.nodeId;
}

/**
 * `soma algorithm step` — three shapes: a direct status write on a run-owned
 * step, `--node` to bridge one to a work-graph node, and `--sync` to re-derive an
 * already-bridged one (§2.7). Its own function rather than a fifth inline branch
 * in the dispatcher's if-chain.
 */
async function runStepAction(options: AlgorithmCliOptions, deps: AlgorithmCliDeps): Promise<string> {
  if (!options.stepId) throw new Error("--step-id is required.");
  const stepId = options.stepId;
  const bind = options.stepNodeId !== undefined;
  const sync = options.stepSync === true;

  if (bind && sync) throw new Error("--node already derives the status; pass one of --node or --sync.");

  if (bind || sync) {
    // Naming a collision beats silently preferring one side of it. `--status` is
    // the write §2.7 refuses outright; `--evidence` is subtler — the derived
    // pointer always overwrites it, so accepting it would discard it in silence.
    if (options.stepStatus !== undefined) {
      throw new Error("--status cannot be combined with --node or --sync: a bridged step's status derives from its node.");
    }
    if (options.evidence !== undefined) {
      throw new Error(
        "--evidence cannot be combined with --node or --sync: a bridged step's evidence is the derived pointer to its node.",
      );
    }
    const nodeId = options.stepNodeId ?? (await resolveBridgedNodeId(options, stepId));
    const state = await deps.readNode(nodeId, { repo: options.repo });
    return updateAndReportAlgorithmRun(options, (run) => syncBridgedPlanStep(run, stepId, state, { bind }));
  }

  if (!options.stepStatus) throw new Error("--status is required (or use --node/--sync for a bridged step).");
  const stepStatus = options.stepStatus;
  return updateAndReportAlgorithmRun(options, (run) => updateAlgorithmPlanStep(run, stepId, stepStatus, options.evidence));
}

export async function runAlgorithmCli(
  parsed: ParsedAlgorithmArgs,
  overrides: Partial<AlgorithmCliDeps> = {},
): Promise<string> {
  const options = parsed.options;
  const deps: AlgorithmCliDeps = { readNode: async (nodeId, opts) => await readNodeForBridge(nodeId, opts), ...overrides };

  if (parsed.action === "classify") {
    if (!options.prompt) throw new Error("--prompt is required.");
    return options.json ? formatAlgorithmClassificationJson(options.prompt) : formatAlgorithmClassification(options.prompt);
  }

  if (parsed.action === "new") {
    const input = requireAlgorithmRunInput(options);
    const run = await registerSomaHomeAlgorithmCapabilities(createAlgorithmRun(input), {
      homeDir: options.homeDir,
      somaHome: options.somaHome,
      substrate: input.substrate,
    });
    const written = await writeAlgorithmRun(run, {
      homeDir: options.homeDir,
      somaHome: options.somaHome,
    });
    await runSomaLifecycleAlgorithmUpdated({
      homeDir: options.homeDir,
      somaHome: options.somaHome,
      substrate: "custom",
    });
    return formatAlgorithmRunResult(written);
  }

  if (parsed.action === "list") {
    const summaries = await listAlgorithmRunSummaries({ homeDir: options.homeDir, somaHome: options.somaHome });
    return [
      "Soma Algorithm runs",
      ...summaries.map((run) => `- ${run.id}: ${run.phase} ${run.progress} ${run.effort} - ${run.goal}`),
    ].join("\n");
  }

  if (parsed.action === "show") {
    const { path, run } = await readAlgorithmRunById(requireAlgorithmId(options), {
      homeDir: options.homeDir,
      somaHome: options.somaHome,
    });
    return formatAlgorithmRun(run, path);
  }

  if (parsed.action === "capabilities") {
    const capabilities = options.capabilities ?? [];
    // soma#574: the capability vocabulary is closed but PER-MACHINE — it resolves
    // from the bundled table, the adopter's capabilities.local.md, skill
    // manifests, and every installed skill. Doctrine tells the agent to select
    // names verbatim from that registry and treat anything else as a phantom,
    // which was unactionable while no verb could show it. `unsupported` was
    // likewise computed and never surfaced, so a row that resolved to nothing
    // was indistinguishable from a row nobody wrote.
    if (options.listCapabilities === true) {
      const resolved = await loadSomaHomeAlgorithmCapabilityRegistry({
        homeDir: options.homeDir,
        somaHome: options.somaHome,
        substrate: options.substrate,
      });
      // The home registry is only part of what a run can select: the compiled-in
      // defaults sit underneath it. Listing the home half alone would omit
      // ReReadCheck — which doctrine calls mandatory at EVERY tier — from the
      // very output the agent is told to select verbatim from (Sage review).
      const registry = mergedAlgorithmCapabilityRegistry(resolved);
      // `mergedAlgorithmCapabilityRegistry` keeps `definitions` and `unsupported`
      // disjoint, so a broken row whose name a compiled-in also answers to drops
      // out of both — the adopter sees a clean list and believes their override
      // resolved (Sage review). Recover those here and report them separately:
      // the capability IS available, but not from the row they wrote.
      const shadowed = resolved.unsupported.filter((name) =>
        registry.definitions.some((definition) => definition.name === name),
      );
      if (options.json === true) {
        return JSON.stringify(registry, null, 2);
      }
      return formatAlgorithmCapabilityRegistry(registry, shadowed);
    }
    if (capabilities.length === 0) {
      throw new Error("--capability is required (or --list to show the resolved registry).");
    }
    if (capabilities.length > 1 && options.capabilityReason) {
      throw new Error("--reason can only be used with one --capability at a time.");
    }
    return updateAndReportAlgorithmRun(
      options,
      (run) =>
        capabilities.reduce(
          (current, capability) =>
            selectAlgorithmCapability(current, {
              name: capability,
              phase: options.capabilityPhase,
              reason: options.capabilityReason,
            }),
          run,
        ),
      { registerCapabilities: true },
    );
  }

  if (parsed.action === "invoke") {
    const [capability] = options.capabilities ?? [];
    if (!capability || !options.evidence) {
      throw new Error("--capability and --evidence are required.");
    }
    return updateAndReportAlgorithmRun(
      options,
      (run) =>
        recordAlgorithmCapabilityInvocation(run, {
          name: capability,
          substrate: options.substrate,
          evidence: options.evidence ?? "",
        }),
      { registerCapabilities: true },
    );
  }

  if (parsed.action === "remove-capability") {
    const [capability] = options.capabilities ?? [];
    if (!capability || !options.capabilityReason) {
      throw new Error("--capability and --reason are required.");
    }
    return updateAndReportAlgorithmRun(options, (run) =>
      removeAlgorithmCapabilitySelection(run, {
        name: capability,
        reason: options.capabilityReason ?? "",
      }),
    );
  }

  if (parsed.action === "plan") {
    return updateAndReportAlgorithmRun(options, (run) => setAlgorithmPlan(run, options.planSteps ?? []));
  }

  if (parsed.action === "observe") {
    if (!options.claim || !options.evidence) {
      throw new Error("--claim and --evidence are required.");
    }
    const claim = options.claim;
    const evidence = options.evidence;
    // Default to the weak 'specified', mirroring the verify gate (#330): clearing
    // the OBSERVE→THINK floor requires the caller to EXPLICITLY assert
    // `--evidence-kind probed` (or tested). Defaulting to a floor-clearing value
    // would fail open for a gate whose whole point is rejecting unverified claims.
    const evidenceKind = options.evidenceKind ?? "specified";
    return updateAndReportAlgorithmRun(options, (run) =>
      recordAlgorithmObservation(run, { claim, evidence, evidenceKind }, undefined, { substrate: options.substrate }),
    );
  }

  if (parsed.action === "decision") {
    const text = requireText(options);
    return updateAndReportAlgorithmRun(options, (run) => recordAlgorithmDecision(run, text));
  }

  if (parsed.action === "change") {
    const text = requireText(options);
    return updateAndReportAlgorithmRun(options, (run) => recordAlgorithmChange(run, text));
  }

  if (parsed.action === "step") {
    return runStepAction(options, deps);
  }

  if (parsed.action === "verify") {
    if (!options.criterionId || !options.criterionStatus || !options.evidence) {
      throw new Error("--criterion-id, --status, and --evidence are required.");
    }
    const criterionId = options.criterionId;
    const criterionStatus = options.criterionStatus;
    const evidence = options.evidence;
    if (options.evidenceKind !== undefined && criterionStatus !== "passed") {
      throw new Error("--evidence-kind only applies to --status passed.");
    }
    // A 'passed' with no explicit kind defaults to the weak 'specified', which the
    // LEARN gate refuses. The kind is caller-asserted: the gate forces an explicit
    // probed/tested claim (or deferred-probe), making a hollow pass auditable — it
    // does not verify the probe actually happened.
    const evidenceKind = defaultEvidenceKind(options.evidenceKind, criterionStatus);
    return updateAndReportAlgorithmRun(options, (run) =>
      verifyAlgorithmCriterion(run, criterionId, criterionStatus, evidence, undefined, { substrate: options.substrate }, evidenceKind),
    );
  }

  if (parsed.action === "learn") {
    const text = requireText(options);
    return updateAndReportAlgorithmRun(options, (run) => recordAlgorithmLearning(run, text, undefined, { substrate: options.substrate }));
  }

  if (parsed.action === "reflect") {
    // recordAlgorithmMetaReflection compacts the smarterRun and validates ≥1 signal.
    const smarterRun = {
      missedEarlyStep: options.missedEarlyStep,
      missedVerifyOrParallel: options.missedVerifyOrParallel,
      highestValueMove: options.highestValueMove,
    };
    return updateAndReportAlgorithmRun(options, (run) =>
      recordAlgorithmMetaReflection(
        run,
        { smarterRun, satisfaction: options.satisfaction, withinBudget: options.withinBudget },
        undefined,
        { substrate: options.substrate },
      ),
    );
  }

  if (parsed.action === "reflections") {
    if (options.id !== undefined && options.digest === true) {
      throw new Error("reflections takes either --id (list one run) or --digest (rank across runs), not both.");
    }
    // Single-run listing: `--id` without `--digest`.
    if (options.id !== undefined) {
      const { run } = await readAlgorithmRunById(options.id, { homeDir: options.homeDir, somaHome: options.somaHome });
      if (run.metaReflection.length === 0) return `No meta-reflections for ${run.id}.`;
      return [
        `Meta-reflections for ${run.id}:`,
        ...run.metaReflection.map((r) => {
          const gates = `floor=${r.gatesFired.currentStateFloor} learn=${r.gatesFired.learnGateClean} complete=${r.gatesFired.completeness}`;
          const signals = [r.smarterRun.missedEarlyStep, r.smarterRun.missedVerifyOrParallel, r.smarterRun.highestValueMove]
            .filter((s): s is string => s !== undefined)
            .join("; ");
          return `- [${r.phase}] gates: ${gates} — ${signals}`;
        }),
      ].join("\n");
    }
    // Cross-run digest (default, or explicit `--digest`).
    const runs = await listAlgorithmRuns({ homeDir: options.homeDir, somaHome: options.somaHome });
    const collected: ReflectionForDigest[] = runs.flatMap(({ run }) =>
      run.metaReflection.map((reflection) => ({ runId: run.id, reflection })),
    );
    if (options.paiSource !== undefined) {
      const content = await readFile(options.paiSource, "utf8");
      collected.push(...parsePaiReflections(content));
    }
    return renderReflectionDigest(buildReflectionDigest(collected));
  }

  if (parsed.action === "batch") {
    const operations = options.batchOperations ?? [];
    return updateAndReportAlgorithmRun(options, (run) => applyAlgorithmBatch(run, operations, undefined, { substrate: options.substrate }), {
      registerCapabilities: true,
    });
  }

  if (parsed.action === "sync-from-isa") {
    if (!options.vsaPath) throw new Error("--isa is required.");
    if (!options.substrate) throw new Error("--substrate is required.");
    const result = await syncAlgorithmRunFromVsa({
      vsaPath: options.vsaPath,
      substrate: options.substrate,
      homeDir: options.homeDir,
      somaHome: options.somaHome,
      promoteOnComplete: options.promoteOnComplete === true,
      principalAuthority: options.principalAuthority === true,
    });
    return formatSyncResult(result);
  }

  if (parsed.action === "resume") {
    if (!options.untilPhase) throw new Error("--until-phase is required.");
    const untilPhase = options.untilPhase;
    return updateAndReportAlgorithmRun(options, (run) =>
      advanceAlgorithmRunUntil(run, untilPhase, undefined, { substrate: options.substrate }),
      { registerCapabilities: true },
    );
  }

  return updateAndReportAlgorithmRun(options, (run) => advanceAlgorithmRun(run, undefined, { substrate: options.substrate }), {
    registerCapabilities: true,
  });
}
