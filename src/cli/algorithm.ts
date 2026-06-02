import {
  applyAlgorithmBatch,
  advanceAlgorithmRunUntil,
  advanceAlgorithmRun,
  algorithmPhaseOrder,
  classifyAlgorithmPrompt,
  createAlgorithmRun,
  listAlgorithmRunSummaries,
  readAlgorithmRunById,
  recordAlgorithmCapabilityInvocation,
  recordAlgorithmChange,
  recordAlgorithmDecision,
  recordAlgorithmLearning,
  removeAlgorithmCapabilitySelection,
  runSomaLifecycleAlgorithmUpdated,
  setAlgorithmPlan,
  selectAlgorithmCapability,
  updateAlgorithmPlanStep,
  verifyAlgorithmCriterion,
  writeAlgorithmRun,
} from "../index";
import { registerSomaHomeAlgorithmCapabilities } from "../algorithm-capabilities";
import { syncAlgorithmRunFromIsa, formatSyncResult } from "../algorithm-isa-sync";
import { algorithmTouchedBy } from "../algorithm-provenance";
import { datePrefixSlug } from "../dated-slug";
import { getCriteria, getGoal } from "../isa-accessors";
import { getRunPhase } from "../algorithm-lifecycle";
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";
import type {
  AlgorithmBatchOperation,
  AlgorithmEffortTier,
  AlgorithmPhase,
  AlgorithmPlanStep,
  AlgorithmRun,
  AlgorithmRunInput,
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
  "decision",
  "change",
  "step",
  "verify",
  "learn",
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
    capabilities: "Usage: soma algorithm capabilities --id <run-id> --capability <name> [--phase <phase>] [--reason <text>] [--home-dir <dir>] [--soma-home <dir>]",
    invoke: "Usage: soma algorithm invoke --id <run-id> --capability <name> --evidence <text> [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    "remove-capability": "Usage: soma algorithm remove-capability --id <run-id> --capability <name> --reason <text> [--home-dir <dir>] [--soma-home <dir>]",
    plan: "Usage: soma algorithm plan --id <run-id> --step <id:criteria:text> [--home-dir <dir>] [--soma-home <dir>]",
    decision: "Usage: soma algorithm decision --id <run-id> --text <text> [--home-dir <dir>] [--soma-home <dir>]",
    change: "Usage: soma algorithm change --id <run-id> --text <text> [--home-dir <dir>] [--soma-home <dir>]",
    step: "Usage: soma algorithm step --id <run-id> --step-id <id> --status <open|done|blocked> [--evidence <text>]",
    verify: "Usage: soma algorithm verify --id <run-id> --criterion-id <id> --status <passed|failed|dropped> --evidence <text> [--substrate <id>]",
    learn: "Usage: soma algorithm learn --id <run-id> --text <text> [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    advance: "Usage: soma algorithm advance --id <run-id> [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    resume: "Usage: soma algorithm resume --id <run-id> --until-phase <phase> [--substrate <id>] [--home-dir <dir>] [--soma-home <dir>]",
    "sync-from-isa":
      "Usage: soma algorithm sync-from-isa --isa <path> --substrate <id> [--soma-home <dir>] [--home-dir <dir>] [--promote-on-complete]",
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
  stepId?: string;
  stepStatus?: AlgorithmPlanStep["status"];
  criterionId?: string;
  criterionStatus?: "passed" | "failed" | "dropped";
  evidence?: string;
  substrate?: SubstrateId;
  untilPhase?: AlgorithmPhase;
  batchOperations?: AlgorithmBatchOperation[];
  json?: boolean;
  isaPath?: string;
  promoteOnComplete?: boolean;
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

function parseCriterionStatus(value: string): "passed" | "failed" | "dropped" {
  if (value === "passed" || value === "failed" || value === "dropped") {
    return value;
  }

  throw new Error("--status must be one of passed, failed, or dropped.");
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

  throw new Error("--op must start with decision, change, learn, capability, capability-invocation, capability-removal, step, verify, or advance.");
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
      case "--step-id":
        options.stepId = readOption(rest, index, arg);
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
      case "--op":
        batchOperations.push(parseBatchOperation(readOption(rest, index, arg)));
        index += 1;
        break;
      case "--ops-json":
        batchOperations.push(...parseBatchOperationsJson(readOption(rest, index, arg)));
        index += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--isa":
        options.isaPath = readOption(rest, index, arg);
        index += 1;
        break;
      case "--promote-on-complete":
        options.promoteOnComplete = true;
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
    `goal: ${getGoal(run.isa) ?? ""}`,
    `touched by: ${touchedBy.length > 0 ? touchedBy.join(", ") : "none"}`,
    "",
    "Criteria:",
    ...getCriteria(run.isa).map((criterion) => `- [${criterion.status}] ${criterion.id}: ${criterion.text}${criterion.verification ? ` | ${criterion.verification}` : ""}`),
    "",
    "Plan:",
    ...(run.planSteps.length > 0 ? run.planSteps.map((step) => `- [${step.status}] ${step.id}: ${step.text} (${step.criteriaIds.join(",")})`) : ["- none"]),
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
  const written = await writeAlgorithmRun(update(registered), {
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

export async function runAlgorithmCli(parsed: ParsedAlgorithmArgs): Promise<string> {
  const options = parsed.options;

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
    if (capabilities.length === 0) {
      throw new Error("--capability is required.");
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

  if (parsed.action === "decision") {
    const text = requireText(options);
    return updateAndReportAlgorithmRun(options, (run) => recordAlgorithmDecision(run, text));
  }

  if (parsed.action === "change") {
    const text = requireText(options);
    return updateAndReportAlgorithmRun(options, (run) => recordAlgorithmChange(run, text));
  }

  if (parsed.action === "step") {
    if (!options.stepId || !options.stepStatus) throw new Error("--step-id and --status are required.");
    const stepId = options.stepId;
    const stepStatus = options.stepStatus;
    return updateAndReportAlgorithmRun(options, (run) => updateAlgorithmPlanStep(run, stepId, stepStatus, options.evidence));
  }

  if (parsed.action === "verify") {
    if (!options.criterionId || !options.criterionStatus || !options.evidence) {
      throw new Error("--criterion-id, --status, and --evidence are required.");
    }
    const criterionId = options.criterionId;
    const criterionStatus = options.criterionStatus;
    const evidence = options.evidence;
    return updateAndReportAlgorithmRun(options, (run) =>
      verifyAlgorithmCriterion(run, criterionId, criterionStatus, evidence, undefined, { substrate: options.substrate }),
    );
  }

  if (parsed.action === "learn") {
    const text = requireText(options);
    return updateAndReportAlgorithmRun(options, (run) => recordAlgorithmLearning(run, text, undefined, { substrate: options.substrate }));
  }

  if (parsed.action === "batch") {
    const operations = options.batchOperations ?? [];
    return updateAndReportAlgorithmRun(options, (run) => applyAlgorithmBatch(run, operations, undefined, { substrate: options.substrate }), {
      registerCapabilities: true,
    });
  }

  if (parsed.action === "sync-from-isa") {
    if (!options.isaPath) throw new Error("--isa is required.");
    if (!options.substrate) throw new Error("--substrate is required.");
    const result = await syncAlgorithmRunFromIsa({
      isaPath: options.isaPath,
      substrate: options.substrate,
      homeDir: options.homeDir,
      somaHome: options.somaHome,
      promoteOnComplete: options.promoteOnComplete === true,
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
