import { readSync } from "node:fs";
import {
  addAlgorithmCapabilities,
  applyAlgorithmBatch,
  advanceAlgorithmRun,
  checkSomaPolicyBatch,
  checkSomaPolicy,
  classifyAlgorithmPrompt,
  captureSomaFeedback,
  createAlgorithmRun,
  importAlgorithm,
  importPaiIdentity,
  importPaiPack,
  installSomaForCodex,
  installSomaForPiDev,
  listAlgorithmRunSummaries,
  planAlgorithmImport,
  planPaiImport,
  planPaiPackImport,
  planSomaForCodexInstall,
  planSomaForPiDevInstall,
  promoteAlgorithmRunMemory,
  readAlgorithmRunById,
  recordAlgorithmChange,
  recordAlgorithmDecision,
  recordAlgorithmLearning,
  runSomaLifecycleAlgorithmUpdated,
  runSomaLifecycleSessionEnd,
  runSomaLifecycleSessionStart,
  searchSomaMemory,
  setAlgorithmPlan,
  updateAlgorithmPlanStep,
  updateAlgorithmRunById,
  verifyAlgorithmCriterion,
  writeAlgorithmRun,
} from "./index";
import type {
  AlgorithmEffortTier,
  AlgorithmBatchOperation,
  AlgorithmImportOptions,
  AlgorithmImportPlan,
  AlgorithmImportResult,
  AlgorithmPlanStep,
  AlgorithmRun,
  AlgorithmRunInput,
  PaiImportOptions,
  PaiImportPlan,
  PaiImportResult,
  PaiPackImportOptions,
  PaiPackImportPlan,
  PaiPackImportResult,
  SomaInstallOptions,
  SomaInstallPlan,
  SomaInstallResult,
  SomaFeedbackCaptureOptions,
  SomaFeedbackCaptureResult,
  SomaLifecycleOptions,
  SomaLifecycleResult,
  SomaMemoryPromotionOptions,
  SomaMemoryPromotionResult,
  SomaMemoryPromotionStore,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
  SomaPolicyCheckOptions,
  SomaPolicyCheckResult,
  SomaPolicyBatchTarget,
  SubstrateId,
} from "./types";
import { SOMA_FEEDBACK_STDIN_MAX_BYTES } from "./feedback-contract";

interface ParsedInstallArgs {
  command: "install";
  substrate: "codex" | "pi-dev";
  apply: boolean;
  options: SomaInstallOptions;
}

interface ParsedImportArgs {
  command: "import";
  source: "pai" | "algorithm" | "pai-pack";
  apply: boolean;
  options: PaiImportOptions | AlgorithmImportOptions | PaiPackImportOptions;
}

interface ParsedAlgorithmArgs {
  command: "algorithm";
  action:
    | "new"
    | "classify"
    | "list"
    | "show"
    | "capabilities"
    | "plan"
    | "decision"
    | "change"
    | "step"
    | "verify"
    | "learn"
    | "batch"
    | "advance";
  options: AlgorithmCliOptions;
}

interface AlgorithmCliOptions {
  homeDir?: string;
  somaHome?: string;
  run?: AlgorithmRunInput;
  id?: string;
  prompt?: string;
  capabilities?: string[];
  planSteps?: AlgorithmPlanStep[];
  text?: string;
  stepId?: string;
  stepStatus?: AlgorithmPlanStep["status"];
  criterionId?: string;
  criterionStatus?: "passed" | "failed" | "dropped";
  evidence?: string;
  batchOperations?: AlgorithmBatchOperation[];
}

interface ParsedLifecycleArgs {
  command: "lifecycle";
  event: "session-start" | "algorithm-updated" | "session-end";
  options: SomaLifecycleOptions;
}

interface ParsedMemorySearchArgs {
  command: "memory";
  action: "search";
  options: SomaMemorySearchOptions;
}

interface ParsedMemoryPromoteArgs {
  command: "memory";
  action: "promote";
  options: SomaMemoryPromotionOptions;
}

type ParsedMemoryArgs = ParsedMemorySearchArgs | ParsedMemoryPromoteArgs;

interface ParsedFeedbackArgs {
  command: "feedback";
  action: "capture";
  options: SomaFeedbackCaptureOptions;
  readTextFromStdin: boolean;
}

interface ParsedPolicyArgs {
  command: "policy";
  action: "check";
  options: SomaPolicyCheckOptions;
  targetsEnv?: string;
  json: boolean;
}

type ParsedArgs = ParsedInstallArgs | ParsedImportArgs | ParsedAlgorithmArgs | ParsedLifecycleArgs | ParsedMemoryArgs | ParsedFeedbackArgs | ParsedPolicyArgs;

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const [command, substrate, ...rest] = args;

  if (command !== "install" || (substrate !== "codex" && substrate !== "pi-dev")) {
    throw new Error("Usage: soma install <codex|pi-dev> [--dry-run] [--apply] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]");
  }

  const options: SomaInstallOptions = {};
  let apply = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--dry-run":
        apply = false;
        break;
      case "--apply":
        apply = true;
        break;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--substrate-home":
        options.substrateHome = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    substrate,
    apply,
    options,
  };
}

function parseImportArgs(args: string[]): ParsedImportArgs {
  const [command, source, ...rest] = args;

  if (command !== "import" || (source !== "pai" && source !== "algorithm" && source !== "pai-pack")) {
    throw new Error(
      [
        "Usage:",
        "  soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]",
        "  soma import algorithm [--dry-run] [--apply] [--home-dir <dir>] [--pai-algorithm-dir <dir>] [--soma-home <dir>]",
        "  soma import pai-pack [--dry-run] [--apply] [--home-dir <dir>] --pai-pack-dir <dir> [--soma-home <dir>] [--skill-name <name>] [--overwrite] [--include-substrate-specific]",
      ].join("\n"),
    );
  }

  const options: PaiImportOptions & AlgorithmImportOptions & PaiPackImportOptions = {};
  let apply = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--dry-run":
        apply = false;
        break;
      case "--apply":
        apply = true;
        break;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--claude-home":
        if (source !== "pai") {
          throw new Error("--claude-home is only valid for soma import pai.");
        }
        options.claudeHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--pai-algorithm-dir":
        if (source !== "algorithm") {
          throw new Error("--pai-algorithm-dir is only valid for soma import algorithm.");
        }
        options.paiAlgorithmDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--pai-pack-dir":
        if (source !== "pai-pack") {
          throw new Error("--pai-pack-dir is only valid for soma import pai-pack.");
        }
        options.paiPackDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--skill-name":
        if (source !== "pai-pack") {
          throw new Error("--skill-name is only valid for soma import pai-pack.");
        }
        options.skillName = readOption(rest, index, arg);
        index += 1;
        break;
      case "--overwrite":
        if (source !== "pai-pack") {
          throw new Error("--overwrite is only valid for soma import pai-pack.");
        }
        options.overwrite = true;
        break;
      case "--include-substrate-specific":
        if (source !== "pai-pack") {
          throw new Error("--include-substrate-specific is only valid for soma import pai-pack.");
        }
        options.includeSubstrateSpecific = true;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    source,
    apply,
    options,
  };
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

  throw new Error("--op must start with decision, change, learn, capability, step, verify, or advance.");
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

function parseSubstrate(value: string): SubstrateId {
  if (value === "codex" || value === "pi-dev" || value === "claude-code" || value === "cortex" || value === "custom") {
    return value;
  }

  throw new Error("--substrate must be one of codex, pi-dev, claude-code, cortex, or custom.");
}

function parseMemoryPromotionStore(value: string): SomaMemoryPromotionStore {
  if (value === "learning" || value === "knowledge" || value === "relationship" || value === "work") {
    return value;
  }

  throw new Error("--store must be one of learning, knowledge, relationship, or work.");
}

function parseAlgorithmArgs(args: string[]): ParsedAlgorithmArgs {
  const [command, action, ...rest] = args;

  const validActions = new Set([
    "new",
    "classify",
    "list",
    "show",
    "capabilities",
    "plan",
    "decision",
    "change",
    "step",
    "verify",
    "learn",
    "batch",
    "advance",
  ]);

  if (command !== "algorithm" || !validActions.has(action)) {
    throw new Error(
      "Usage: soma algorithm <new|list|show|capabilities|plan|decision|change|step|verify|learn|advance> ...",
    );
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
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (action === "new") {
    validateAlgorithmRunInput(run);
  }

  if (action === "new") {
    run.id = options.id;
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
    action: action as ParsedAlgorithmArgs["action"],
    options,
  };
}

function parseLifecycleArgs(args: string[]): ParsedLifecycleArgs {
  const [command, event, ...rest] = args;

  if (command !== "lifecycle" || (event !== "session-start" && event !== "algorithm-updated" && event !== "session-end")) {
    throw new Error(
      "Usage: soma lifecycle <session-start|algorithm-updated|session-end> [--home-dir <dir>] [--soma-home <dir>] [--substrate <id>] [--session-id <id>]",
    );
  }

  const options: SomaLifecycleOptions = {};

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
      case "--substrate":
        options.substrate = parseSubstrate(readOption(rest, index, arg));
        index += 1;
        break;
      case "--session-id":
        options.sessionId = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    command,
    event,
    options,
  };
}

function parseMemorySearchArgs(args: string[]): SomaMemorySearchOptions {
  const options: Partial<SomaMemorySearchOptions> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--query":
        options.query = readOption(args, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = Number.parseInt(readOption(args, index, arg), 10);
        if (!Number.isFinite(options.limit) || options.limit < 1) {
          throw new Error("--limit must be a positive integer.");
        }
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.query) {
    throw new Error("soma memory search is missing required option: --query.");
  }

  return options as SomaMemorySearchOptions;
}

function parseMemoryPromoteArgs(args: string[]): SomaMemoryPromotionOptions {
  const options: Partial<SomaMemoryPromotionOptions> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--substrate":
        options.substrate = parseSubstrate(readOption(args, index, arg));
        index += 1;
        break;
      case "--from-run":
        options.fromRun = readOption(args, index, arg);
        index += 1;
        break;
      case "--store":
        options.store = parseMemoryPromotionStore(readOption(args, index, arg));
        index += 1;
        break;
      case "--title":
        options.title = readOption(args, index, arg);
        index += 1;
        break;
      case "--lesson":
        options.lesson = readOption(args, index, arg);
        index += 1;
        break;
      case "--applies-when":
        options.appliesWhen = readOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const missing: string[] = [];
  if (!options.fromRun) missing.push("--from-run");
  if (!options.store) missing.push("--store");
  if (!options.title) missing.push("--title");
  if (missing.length > 0) {
    throw new Error(`soma memory promote is missing required option(s): ${missing.join(", ")}.`);
  }

  return options as SomaMemoryPromotionOptions;
}

function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
  const [command, action, ...rest] = args;

  if (command !== "memory" || (action !== "search" && action !== "promote")) {
    throw new Error("Usage: soma memory <search|promote> ...");
  }

  if (action === "search") {
    return {
      command,
      action,
      options: parseMemorySearchArgs(rest),
    };
  }

  return {
    command,
    action,
    options: parseMemoryPromoteArgs(rest),
  };
}

function parseFeedbackCaptureArgs(args: string[]): { options: SomaFeedbackCaptureOptions; readTextFromStdin: boolean } {
  const options: Partial<SomaFeedbackCaptureOptions> = {};
  let readTextFromStdin = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--home-dir":
        options.homeDir = readOption(args, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(args, index, arg);
        index += 1;
        break;
      case "--substrate":
        options.substrate = parseSubstrate(readOption(args, index, arg));
        index += 1;
        break;
      case "--text":
        options.text = readOption(args, index, arg);
        index += 1;
        break;
      case "--stdin":
        readTextFromStdin = true;
        break;
      case "--no-excerpt":
        options.storeExcerpt = false;
        break;
      case "--store-excerpt":
        options.storeExcerpt = true;
        break;
      case "--source":
        options.source = readOption(args, index, arg);
        index += 1;
        break;
      case "--timestamp":
        options.timestamp = readOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.text && !readTextFromStdin) {
    throw new Error("soma feedback capture is missing required option: --text or --stdin.");
  }
  if (options.text && readTextFromStdin) {
    throw new Error("soma feedback capture accepts either --text or --stdin, not both.");
  }

  const parsedOptions: SomaFeedbackCaptureOptions = {
    ...options,
    text: options.text ?? "",
  };

  return {
    options: parsedOptions,
    readTextFromStdin,
  };
}

function parseFeedbackArgs(args: string[]): ParsedFeedbackArgs {
  const [command, action, ...rest] = args;

  if (command !== "feedback" || action !== "capture") {
    throw new Error("Usage: soma feedback capture (--text <text> | --stdin) [--substrate <id>] [--source <source>] [--store-excerpt]");
  }

  const parsed = parseFeedbackCaptureArgs(rest);

  return {
    command,
    action,
    options: parsed.options,
    readTextFromStdin: parsed.readTextFromStdin,
  };
}

function parsePolicyArgs(args: string[]): ParsedPolicyArgs {
  const [command, action, ...rest] = args;

  if (command !== "policy" || action !== "check") {
    throw new Error(
      "Usage: soma policy check --action write --destination <path> [--content <text>|--content-env <name>] [--source <path>]",
    );
  }

  const options: Partial<SomaPolicyCheckOptions> = {};
  let json = false;
  let targetsEnv = "";

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
      case "--substrate":
        options.substrate = parseSubstrate(readOption(rest, index, arg));
        index += 1;
        break;
      case "--action": {
        const value = readOption(rest, index, arg);
        if (value !== "write") throw new Error("--action must be write.");
        options.action = value;
        index += 1;
        break;
      }
      case "--destination":
        options.destinationPath = readOption(rest, index, arg);
        index += 1;
        break;
      case "--source":
        options.sourcePath = readOption(rest, index, arg);
        index += 1;
        break;
      case "--content":
        options.content = readOption(rest, index, arg);
        index += 1;
        break;
      case "--content-env": {
        const envName = readOption(rest, index, arg);
        const envContent = process.env[envName];
        if (envContent === undefined) {
          throw new Error(`--content-env ${envName} is not set.`);
        }
        options.content = envContent;
        index += 1;
        break;
      }
      case "--record": {
        const value = readOption(rest, index, arg);
        if (value !== "all" && value !== "deny" && value !== "none") {
          throw new Error("--record must be one of all, deny, or none.");
        }
        options.record = value;
        index += 1;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--targets-env":
        targetsEnv = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const missing: string[] = [];
  if (!options.action) missing.push("--action");
  if (!options.destinationPath && !targetsEnv) missing.push("--destination");
  if (missing.length > 0) {
    throw new Error(`soma policy ${action} is missing required option(s): ${missing.join(", ")}.`);
  }

  return {
    command,
    action,
    options: options as SomaPolicyCheckOptions,
    targetsEnv: targetsEnv || undefined,
    json,
  };
}

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] === "lifecycle") {
    return parseLifecycleArgs(args);
  }

  if (args[0] === "memory") {
    return parseMemoryArgs(args);
  }

  if (args[0] === "feedback") {
    return parseFeedbackArgs(args);
  }

  if (args[0] === "algorithm") {
    return parseAlgorithmArgs(args);
  }

  if (args[0] === "policy") {
    return parsePolicyArgs(args);
  }

  if (args[0] === "install") {
    return parseInstallArgs(args);
  }

  if (args[0] === "import") {
    return parseImportArgs(args);
  }

  throw new Error(
    [
      "Usage:",
      "  soma algorithm new --prompt <text> --intent <text> --current-state <text> --goal <text> --criterion <id:text> [--effort <E1|E2|E3|E4|E5>] [--home-dir <dir>] [--soma-home <dir>]",
      "  soma algorithm classify --prompt <text>",
      "  soma algorithm batch --id <run-id> --op <kind:...> [--op <kind:...>]",
      "  soma algorithm <list|show|capabilities|plan|decision|change|step|verify|learn|advance> --id <run-id> [...]",
      "  soma memory search --query <text> [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]",
      "  soma memory promote --from-run <run-id> --store <learning|knowledge|relationship|work> --title <text> [--lesson <text>] [--applies-when <text>]",
      "  soma feedback capture (--text <text> | --stdin) [--substrate <id>] [--source <source>] [--store-excerpt]",
      "  soma policy check --action write --destination <path> [--content <text>|--content-env <name>] [--source <path>] [--substrate <id>] [--record <all|deny|none>] [--json]",
      "  soma lifecycle <session-start|algorithm-updated|session-end> [--home-dir <dir>] [--soma-home <dir>] [--substrate <id>] [--session-id <id>]",
      "  soma install <codex|pi-dev> [--dry-run] [--apply] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
      "  soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]",
      "  soma import algorithm [--dry-run] [--apply] [--home-dir <dir>] [--pai-algorithm-dir <dir>] [--soma-home <dir>]",
    ].join("\n"),
  );
}

function readLimitedFeedbackStdin(): string {
  const chunks: Buffer[] = [];
  let total = 0;

  for (;;) {
    const buffer = Buffer.alloc(Math.min(8192, SOMA_FEEDBACK_STDIN_MAX_BYTES + 1 - total));
    const bytesRead = readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > SOMA_FEEDBACK_STDIN_MAX_BYTES) {
      throw new Error(`soma feedback capture --stdin exceeds ${SOMA_FEEDBACK_STDIN_MAX_BYTES} byte limit.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function formatPlan(plan: SomaInstallPlan): string {
  return [
    "Soma install plan",
    `substrate: ${plan.substrate}`,
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `somaHome: ${plan.somaHome}`,
    `substrateHome: ${plan.substrateHome}`,
    "",
    "Soma directories:",
    ...plan.somaDirectories.map((path) => `- ${path}`),
    "",
    "Soma files:",
    ...plan.somaFiles.map((path) => `- ${path}`),
    "",
    "Substrate files:",
    ...plan.substrateFiles.map((path) => `- ${path}`),
  ].join("\n");
}

function formatInstallResult(result: SomaInstallResult): string {
  return [
    "Soma install applied",
    `substrate: ${result.substrate}`,
    `somaHome: ${result.somaHome.somaHome}`,
    `substrateHome: ${result.substrateHome.rootDir}`,
    "",
    "Soma files:",
    ...result.somaHome.files.map((path) => `- ${path}`),
    "",
    "Substrate files:",
    ...result.substrateHome.files.map((path) => `- ${path}`),
  ].join("\n");
}

function formatPaiImportPlan(plan: PaiImportPlan): string {
  return [
    "Soma PAI import plan",
    "source: pai",
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `claudeHome: ${plan.claudeHome}`,
    `somaHome: ${plan.somaHome}`,
    "",
    "Source files:",
    ...plan.sourceFiles.map((path) => `- ${path}`),
    "",
    "Target files:",
    ...plan.targetFiles.map((path) => `- ${path}`),
  ].join("\n");
}

function formatPaiImportResult(result: PaiImportResult): string {
  return [
    "Soma PAI import applied",
    `claudeHome: ${result.claudeHome}`,
    `somaHome: ${result.somaHome}`,
    "",
    "Files:",
    ...result.files.map((path) => `- ${path}`),
  ].join("\n");
}

function formatAlgorithmImportPlan(plan: AlgorithmImportPlan): string {
  return [
    "Soma Algorithm import plan",
    "source: algorithm",
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `paiAlgorithmDir: ${plan.paiAlgorithmDir}`,
    `somaHome: ${plan.somaHome}`,
    "",
    "Source files:",
    ...plan.sourceFiles.map((path) => `- ${path}`),
    "",
    "Target files:",
    ...plan.targetFiles.map((path) => `- ${path}`),
  ].join("\n");
}

function formatAlgorithmImportResult(result: AlgorithmImportResult): string {
  return [
    "Soma Algorithm import applied",
    `paiAlgorithmDir: ${result.paiAlgorithmDir}`,
    `somaHome: ${result.somaHome}`,
    "",
    "Files:",
    ...result.files.map((path) => `- ${path}`),
  ].join("\n");
}

function formatPaiPackImportPlan(plan: PaiPackImportPlan): string {
  const counts = plan.files.reduce<Partial<Record<string, number>>>((acc, file) => {
    acc[file.classification] = (acc[file.classification] ?? 0) + 1;
    return acc;
  }, {});

  return [
    "Soma PAI Pack import plan",
    "source: pai-pack",
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `paiPackDir: ${plan.paiPackDir}`,
    `somaHome: ${plan.somaHome}`,
    `skillName: ${plan.skillName}`,
    `packName: ${plan.packName}`,
    `description: ${plan.description}`,
    "",
    "Classification:",
    `- portable: ${counts.portable ?? 0}`,
    `- template: ${counts.template ?? 0}`,
    `- source-doc: ${counts["source-doc"] ?? 0}`,
    `- substrate-specific: ${counts["substrate-specific"] ?? 0}`,
    "",
    "Files:",
    ...plan.files.map((file) => {
      const source = file.origin === "source" ? file.source : `generated:${file.generator}`;
      return `- [${file.classification}] ${source} -> ${file.target}`;
    }),
  ].join("\n");
}

function formatPaiPackImportResult(result: PaiPackImportResult): string {
  const quotedSomaHome = quoteShellArg(result.somaHome);

  return [
    "Soma PAI Pack import applied",
    `paiPackDir: ${result.paiPackDir}`,
    `somaHome: ${result.somaHome}`,
    `skillName: ${result.skillName}`,
    "",
    "Next step:",
    "Import makes the skill available in Soma. Refresh the target substrate projection before expecting the skill in that substrate.",
    `bun run soma install <substrate> --apply --soma-home ${quotedSomaHome}`,
    "",
    "Files:",
    ...result.files.map((path) => `- ${path}`),
  ].join("\n");
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function formatAlgorithmRunResult(result: { path: string; run: { id: string; phase: string; effort: string } }): string {
  return [
    "Soma Algorithm run created",
    `id: ${result.run.id}`,
    `phase: ${result.run.phase}`,
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

function formatLifecycleResult(result: SomaLifecycleResult): string {
  const lines = [
    "Soma lifecycle event handled",
    `event: ${result.event}`,
    `somaHome: ${result.somaHome}`,
    `timestamp: ${result.timestamp}`,
    "",
    "Files:",
    ...result.files.map((path) => `- ${path}`),
  ];

  if (result.context) {
    lines.push("", result.context);
  }

  return lines.join("\n");
}

function formatMemorySearchResult(result: SomaMemorySearchResult): string {
  return [
    "Soma memory search",
    `query: ${result.query}`,
    `somaHome: ${result.somaHome}`,
    "",
    "Matches:",
    ...(result.matches.length > 0
      ? result.matches.map((match) => `- ${match.path}:${match.line} [score ${match.score}] ${match.snippet}`)
      : ["- none"]),
  ].join("\n");
}

function formatMemoryPromotionResult(result: SomaMemoryPromotionResult): string {
  return [
    "Soma memory promotion created",
    `store: ${result.store}`,
    `path: ${result.path}`,
    `sourceRunPath: ${result.sourceRunPath}`,
    `event: ${result.event.id}`,
  ].join("\n");
}

function formatFeedbackCaptureResult(result: SomaFeedbackCaptureResult): string {
  return [
    "Soma feedback capture",
    `captured: ${result.captured ? "yes" : "no"}`,
    `kind: ${result.classification.kind}`,
    `confidence: ${result.classification.confidence}`,
    `reason: ${result.classification.reason}`,
    result.event?.metadata?.excerptStored === true
      ? "warning: --store-excerpt persists a best-effort redacted excerpt; redaction is not a secret scanner."
      : undefined,
    result.event ? `event: ${result.event.id}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatPolicyCheckResult(result: SomaPolicyCheckResult): string {
  return [
    "Soma policy check",
    `decision: ${result.decision}`,
    `reason: ${result.reason}`,
    `somaHome: ${result.somaHome}`,
    result.event ? `event: ${result.event.id}` : undefined,
    "",
    "Findings:",
    ...(result.findings.length > 0 ? result.findings.map((finding) => `- ${finding.kind}: ${finding.detail}`) : ["- none"]),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function readPolicyTargetsEnv(envName: string): SomaPolicyBatchTarget[] {
  const envContent = process.env[envName];
  if (envContent === undefined) {
    throw new Error(`--targets-env ${envName} is not set.`);
  }

  let targets: unknown;
  try {
    targets = JSON.parse(envContent);
  } catch {
    throw new Error(`--targets-env ${envName} must contain valid JSON targets.`);
  }

  if (
    !Array.isArray(targets) ||
    targets.some(
      (target) =>
        !target ||
        typeof target !== "object" ||
        typeof (target as SomaPolicyBatchTarget).filePath !== "string" ||
        ((target as SomaPolicyBatchTarget).content !== undefined && typeof (target as SomaPolicyBatchTarget).content !== "string") ||
        ((target as SomaPolicyBatchTarget).sourcePath !== undefined && typeof (target as SomaPolicyBatchTarget).sourcePath !== "string"),
    )
  ) {
    throw new Error(`--targets-env ${envName} must contain an array of targets with string filePath values and optional string content/sourcePath values.`);
  }

  return targets as SomaPolicyBatchTarget[];
}

function formatAlgorithmRun(run: AlgorithmRun, path: string): string {
  return [
    "Soma Algorithm run",
    `id: ${run.id}`,
    `phase: ${run.phase}`,
    `effort: ${run.effort}`,
    `effortSource: ${run.effortSource}`,
    `mode: ${run.mode}`,
    `classificationReason: ${run.classificationReason}`,
    `path: ${path}`,
    `goal: ${run.isa.goal}`,
    "",
    "Criteria:",
    ...run.isa.criteria.map((criterion) => `- [${criterion.status}] ${criterion.id}: ${criterion.text}${criterion.verification ? ` | ${criterion.verification}` : ""}`),
    "",
    "Plan:",
    ...(run.planSteps.length > 0 ? run.planSteps.map((step) => `- [${step.status}] ${step.id}: ${step.text} (${step.criteriaIds.join(",")})`) : ["- none"]),
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
): Promise<string> {
  const id = requireAlgorithmId(options);
  const written = await updateAlgorithmRunById(id, { homeDir: options.homeDir, somaHome: options.somaHome }, update);

  await runSomaLifecycleAlgorithmUpdated({
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrate: "custom",
  });

  return formatAlgorithmRun(written.run, written.path);
}

async function runAlgorithmCli(parsed: ParsedAlgorithmArgs): Promise<string> {
  const options = parsed.options;

  if (parsed.action === "classify") {
    if (!options.prompt) throw new Error("--prompt is required.");
    return formatAlgorithmClassification(options.prompt);
  }

  if (parsed.action === "new") {
    const written = await writeAlgorithmRun(createAlgorithmRun(requireAlgorithmRunInput(options)), {
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
    return updateAndReportAlgorithmRun(options, (run) => addAlgorithmCapabilities(run, options.capabilities ?? []));
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
      verifyAlgorithmCriterion(run, criterionId, criterionStatus, evidence),
    );
  }

  if (parsed.action === "learn") {
    const text = requireText(options);
    return updateAndReportAlgorithmRun(options, (run) => recordAlgorithmLearning(run, text));
  }

  if (parsed.action === "batch") {
    const operations = options.batchOperations ?? [];
    return updateAndReportAlgorithmRun(options, (run) => applyAlgorithmBatch(run, operations));
  }

  return updateAndReportAlgorithmRun(options, (run) => advanceAlgorithmRun(run));
}

export async function runSomaCli(args: string[]): Promise<string> {
  const parsed = parseArgs(args);

  if (parsed.command === "lifecycle") {
    if (parsed.event === "session-start") {
      return formatLifecycleResult(await runSomaLifecycleSessionStart(parsed.options));
    }

    if (parsed.event === "algorithm-updated") {
      return formatLifecycleResult(await runSomaLifecycleAlgorithmUpdated(parsed.options));
    }

    return formatLifecycleResult(await runSomaLifecycleSessionEnd(parsed.options));
  }

  if (parsed.command === "algorithm") {
    return runAlgorithmCli(parsed);
  }

  if (parsed.command === "memory") {
    if (parsed.action === "promote") {
      return formatMemoryPromotionResult(await promoteAlgorithmRunMemory(parsed.options));
    }

    return formatMemorySearchResult(await searchSomaMemory(parsed.options));
  }

  if (parsed.command === "feedback") {
    const options = parsed.readTextFromStdin ? { ...parsed.options, text: readLimitedFeedbackStdin() } : parsed.options;
    return formatFeedbackCaptureResult(await captureSomaFeedback(options));
  }

  if (parsed.command === "policy") {
    if (parsed.targetsEnv) {
      const targets = readPolicyTargetsEnv(parsed.targetsEnv);
      const result = await checkSomaPolicyBatch({
        homeDir: parsed.options.homeDir,
        somaHome: parsed.options.somaHome,
        substrate: parsed.options.substrate,
        action: parsed.options.action,
        record: parsed.options.record,
        timestamp: parsed.options.timestamp,
        targets,
      });

      return parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.decision}: ${result.reason}\n`;
    }

    const result = await checkSomaPolicy(parsed.options);
    return parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatPolicyCheckResult(result);
  }

  if (parsed.command === "import") {
    if (parsed.source === "algorithm") {
      const options = parsed.options as AlgorithmImportOptions;

      if (!parsed.apply) {
        return formatAlgorithmImportPlan(planAlgorithmImport(options));
      }

      return formatAlgorithmImportResult(await importAlgorithm(options));
    }

    if (parsed.source === "pai-pack") {
      const options = parsed.options as PaiPackImportOptions;

      if (!parsed.apply) {
        return formatPaiPackImportPlan(await planPaiPackImport(options));
      }

      return formatPaiPackImportResult(await importPaiPack(options));
    }

    const options = parsed.options as PaiImportOptions;

    if (!parsed.apply) {
      return formatPaiImportPlan(planPaiImport(options));
    }

    return formatPaiImportResult(await importPaiIdentity(options));
  }

  if (!parsed.apply) {
    return formatPlan(
      parsed.substrate === "codex" ? planSomaForCodexInstall(parsed.options) : planSomaForPiDevInstall(parsed.options),
    );
  }

  return formatInstallResult(
    parsed.substrate === "codex" ? await installSomaForCodex(parsed.options) : await installSomaForPiDev(parsed.options),
  );
}

if (import.meta.main) {
  try {
    console.log(await runSomaCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
