import { readSync } from "node:fs";
import {
  addAlgorithmCapabilities,
  applyAlgorithmBatch,
  advanceAlgorithmRun,
  checkSomaPolicyBatch,
  checkSomaPolicy,
  classifyAlgorithmPrompt,
  captureSomaFeedback,
  captureSomaResult,
  createAlgorithmRun,
  importAlgorithm,
  importPaiDocs,
  importPaiIdentity,
  importPaiPack,
  migratePai,
  planPaiMigration,
  type PaiMigrationOptions,
  type PaiMigrationPlan,
  type PaiMigrationResult,
  installSomaForClaudeCode,
  installSomaForCodex,
  installSomaForPiDev,
  planSomaForClaudeCodeInstall,
  uninstallSomaForClaudeCode,
  type UninstallClaudeCodeOptions,
  type UninstallClaudeCodeResult,
  buildClaudeCodeHomeProjection,
  buildCodexHomeProjection,
  buildPiDevHomeProjection,
  loadSomaHome,
  listAlgorithmRunSummaries,
  planAlgorithmImport,
  planPaiDocsImport,
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
  searchSomaResults,
  setAlgorithmPlan,
  updateAlgorithmPlanStep,
  updateAlgorithmRunById,
  verifyAlgorithmCriterion,
  writeAlgorithmRun,
} from "./index";
// Sage r2 #99 Architecture: presentation helper imported directly
// (not re-exported from the package root) so the text-rendering shape
// stays internal and revisable without an SDK breakage.
import { formatPackOutcomeLines } from "./pai-migration";
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
  PaiPackOutcome,
  PaiDocsImportOptions,
  PaiDocsImportPlan,
  PaiDocsImportResult,
  ProjectionInput,
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
  SomaResultCaptureOptions,
  SomaResultCaptureResult,
  SomaResultEventKind,
  SomaResultSearchOptions,
  SomaResultSearchResult,
  SomaPolicyCheckOptions,
  SomaPolicyCheckResult,
  SomaPolicyBatchTarget,
  SubstrateId,
} from "./types";
import { SOMA_FEEDBACK_STDIN_MAX_BYTES } from "./feedback-contract";
import { ISA_SUBCOMMAND_HELP, ISA_USAGE_HEADER, runIsaCli } from "./cli-isa";
// #115 — `soma migrate claude-skills` (Phase 1). Module-internal, not
// re-exported from the package barrel, same pattern as
// `pai-memory-migrator.ts` (#90 Sage r2 Architecture finding — the
// migrator's public boundary is not yet stable; CLI imports
// directly).
import {
  migrateClaudeSkills,
  planClaudeSkillsMigration,
  readClaudeSkillsMigrationStatus,
  resolveOutcomeReason,
  REASON_PREFIX_HOOK_BINDING,
  REASON_PREFIX_SLASH_COMMAND,
} from "./claude-skills-migrator";
// #125 — stderr-backed progress emitter for `migrate claude-skills`.
// Library callers default to the no-op (avoids surprise stderr noise);
// CLI builds the real one bound to `process.stderr` so principals see
// per-skill progress lines without changing the stdout summary shape.
import { createProgressEmitter } from "./claude-skills-progress";
import type {
  ClaudeSkillsMigrationOptions,
  ClaudeSkillsMigrationPlan,
  ClaudeSkillsMigrationResult,
  ClaudeSkillsMigrationManifest,
  ClaudeSkillOutcome,
  ClaudeSkillsSmokeSubstrate,
  RewriteDescriptionsAgent,
} from "./types";
// CLI formatter for `import pai-docs` needs the same in-scope subtree
// list the importer iterates. Importing directly from the module
// keeps the constant a module-internal contract rather than promoting
// importer policy through the package root surface.
import { PAI_DOCS_IMPORT_SUBDIRS } from "./pai-docs-importer";

/**
 * Typed CLI error carrying an exit code distinct from the default 1.
 * Used by `soma isa` (#36) to surface system errors (2) vs user errors (1)
 * vs success (0) per the established CLI convention.
 */
export class SomaCliError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.name = "SomaCliError";
    this.exitCode = exitCode;
  }
}
import { getCriteria, getGoal } from "./isa-accessors";
import { getRunPhase } from "./algorithm-lifecycle";
import { isSomaResultEventKind } from "./result-capture";
import { SOMA_RESULT_EVENT_KINDS } from "./types";

/**
 * #106 — single-source helper for emitting the
 * `--include-substrate-specific` deprecation warning to stderr. Both
 * `parseImportArgs` (pai-pack surface) and `parseMigrateArgs`
 * (migrate-pai surface) accept the legacy flag for one release and
 * route through this helper so the wording stays consistent and the
 * test surface has a single text to assert on.
 *
 * Goes to stderr (not the CLI's returned stdout string) because
 * (a) it's a side-channel warning, not part of the command output,
 * and (b) it must not corrupt machine-parseable stdout content.
 */
function warnDeprecatedSubstrateFlag(): void {
  process.stderr.write(
    "Warning: --include-substrate-specific is deprecated; use --include-unrecognized.\n",
  );
}

type InstallSubstrate = "codex" | "pi-dev" | "claude-code";

interface ParsedInstallArgs {
  command: "install";
  substrate: InstallSubstrate;
  apply: boolean;
  workspace: boolean;
  options: SomaInstallOptions;
}

interface ParsedUninstallArgs {
  command: "uninstall";
  substrate: InstallSubstrate;
  workspace: boolean;
  options: SomaInstallOptions & UninstallClaudeCodeOptions;
}

interface ParsedReprojectArgs {
  command: "reproject";
  substrate: InstallSubstrate;
  workspace: boolean;
  options: SomaInstallOptions;
}

interface ParsedUpgradeArgs {
  command: "upgrade";
  substrate: InstallSubstrate;
  workspace: boolean;
  options: SomaInstallOptions;
}

interface ParsedExportArgs {
  command: "export";
  substrate: InstallSubstrate;
  out?: string;
  options: SomaInstallOptions;
}

interface ParsedDaemonArgs {
  command: "daemon";
}

interface ParsedImportArgs {
  command: "import";
  source: "pai" | "algorithm" | "pai-pack" | "pai-docs";
  apply: boolean;
  options: PaiImportOptions | AlgorithmImportOptions | PaiPackImportOptions | PaiDocsImportOptions;
}

interface ParsedMigrateArgs {
  command: "migrate";
  source: "pai";
  mode: "plan" | "apply" | "status";
  options: PaiMigrationOptions;
  /** #106 — when true, plan/apply formatter prints inline file lists. Default false. */
  verbose: boolean;
}

/**
 * #115 — `soma migrate claude-skills` parsed args. Sibling to
 * `ParsedMigrateArgs` (PAI path); a separate type because the option
 * sets do not overlap and merging them would force every dispatch
 * site to discriminate on `source` AND options shape. Keeping them
 * separate keeps the type narrowing trivial.
 */
interface ParsedMigrateClaudeSkillsArgs {
  command: "migrate";
  source: "claude-skills";
  mode: "plan" | "apply" | "status";
  options: ClaudeSkillsMigrationOptions;
  // #125 — when true, the CLI suppresses stderr progress (passes a
  // quiet emitter to the migrator). The Timing block on stdout is
  // unaffected — it's part of the summary, not stderr noise.
  quiet?: boolean;
}

interface ParsedAdoptArgs {
  command: "adopt";
  substrate: "claude";
  mode: "plan" | "apply" | "uninstall";
  options: SomaInstallOptions & UninstallClaudeCodeOptions;
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
  json?: boolean;
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

interface ParsedResultCaptureArgs {
  command: "result";
  action: "capture";
  options: SomaResultCaptureOptions;
}

interface ParsedResultSearchArgs {
  command: "result";
  action: "search";
  options: SomaResultSearchOptions;
}

type ParsedResultArgs = ParsedResultCaptureArgs | ParsedResultSearchArgs;

interface ParsedPolicyArgs {
  command: "policy";
  action: "check";
  options: SomaPolicyCheckOptions;
  targetsEnv?: string;
  json: boolean;
}

interface ParsedHelpArgs {
  command: "help";
  topic: string[];
}

interface ParsedIsaArgs {
  command: "isa";
  args: string[];
}

type ParsedArgs =
  | ParsedHelpArgs
  | ParsedInstallArgs
  | ParsedUninstallArgs
  | ParsedReprojectArgs
  | ParsedUpgradeArgs
  | ParsedExportArgs
  | ParsedDaemonArgs
  | ParsedImportArgs
  | ParsedMigrateArgs
  | ParsedMigrateClaudeSkillsArgs
  | ParsedAdoptArgs
  | ParsedAlgorithmArgs
  | ParsedLifecycleArgs
  | ParsedMemoryArgs
  | ParsedFeedbackArgs
  | ParsedResultArgs
  | ParsedPolicyArgs
  | ParsedIsaArgs;

const TOP_LEVEL_COMMANDS = [
  "adopt",
  "algorithm",
  "daemon",
  "export",
  "feedback",
  "import",
  "install",
  "isa",
  "lifecycle",
  "memory",
  "migrate",
  "policy",
  "reproject",
  "result",
  "uninstall",
  "upgrade",
] as const;

const MIGRATE_PAI_USAGE =
  "Usage: soma migrate pai [--dry-run] [--apply] [--status] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>] [--pai-install <dir>] [--pai-repo <root>] [--pai-source-dir <dir>] [--pai-packs-dir <dir>] [--pai-pack-dir <dir>] [--skip-memory] [--skip-skills] [--skip-docs] [--overwrite-reserved] [--include-unrecognized] [--verbose]";
// #115 — `soma migrate claude-skills`. Phase 1 verb + classifier
// (#116) ships the flat-tree import; Phase 2 adds `--smoke
// <substrate>` (repeatable) for per-skill static-shape verify
// against the requested target substrate's projection (codex, pi-dev,
// or `all` which expands to both). `--smoke` is optional and absent
// from the usage line below for non-Phase-2 callers — they keep the
// Phase-1 surface intact.
const MIGRATE_CLAUDE_SKILLS_USAGE =
  "Usage: soma migrate claude-skills --from <skills-dir> [--dry-run] [--apply] [--status] [--home-dir <dir>] [--soma-home <dir>] [--include-claude-specific] [--smoke <codex|pi-dev|all>] [--rewrite-descriptions <claude|codex|pi|none>] [--quiet]";
const ADOPT_CLAUDE_USAGE =
  "Usage: soma adopt claude [--dry-run] [--apply] [--uninstall] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";
const COMMAND_HELP: Record<string, { usage: string; subcommands?: Record<string, string> }> = {
  algorithm: {
    usage: "Usage: soma algorithm <new|classify|list|show|capabilities|plan|decision|change|step|verify|learn|batch|advance> ...",
    subcommands: {
      new: "Usage: soma algorithm new --prompt <text> --intent <text> --current-state <text> --goal <text> --criterion <id:text> [--effort <E1|E2|E3|E4|E5>] [--home-dir <dir>] [--soma-home <dir>]",
      classify: "Usage: soma algorithm classify --prompt <text> [--json]",
      batch: "Usage: soma algorithm batch --id <run-id> --op <kind:...> [--op <kind:...>]",
      list: "Usage: soma algorithm list [--home-dir <dir>] [--soma-home <dir>]",
      show: "Usage: soma algorithm show --id <run-id> [--home-dir <dir>] [--soma-home <dir>]",
      capabilities: "Usage: soma algorithm capabilities --id <run-id> --capability <name> [--home-dir <dir>] [--soma-home <dir>]",
      plan: "Usage: soma algorithm plan --id <run-id> --step <id:criteria:text> [--home-dir <dir>] [--soma-home <dir>]",
      decision: "Usage: soma algorithm decision --id <run-id> --text <text> [--home-dir <dir>] [--soma-home <dir>]",
      change: "Usage: soma algorithm change --id <run-id> --text <text> [--home-dir <dir>] [--soma-home <dir>]",
      step: "Usage: soma algorithm step --id <run-id> --step-id <id> --status <open|done|blocked|dropped> [--evidence <text>]",
      verify: "Usage: soma algorithm verify --id <run-id> --criterion-id <id> --status <passed|failed|dropped> --evidence <text>",
      learn: "Usage: soma algorithm learn --id <run-id> --text <text> [--home-dir <dir>] [--soma-home <dir>]",
      advance: "Usage: soma algorithm advance --id <run-id> [--home-dir <dir>] [--soma-home <dir>]",
    },
  },
  memory: {
    usage: "Usage: soma memory <search|promote> ...",
    subcommands: {
      search: "Usage: soma memory search --query <text> [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]",
      promote: "Usage: soma memory promote --from-run <run-id> --store <learning|knowledge|relationship|work> --title <text> [--lesson <text>] [--applies-when <text>]",
    },
  },
  feedback: {
    usage: "Usage: soma feedback capture (--text <text> | --stdin) [--substrate <id>] [--source <source>] [--store-excerpt]",
    subcommands: {
      capture: "Usage: soma feedback capture (--text <text> | --stdin) [--substrate <id>] [--source <source>] [--store-excerpt]",
    },
  },
  result: {
    usage: "Usage: soma result <capture|search> ...",
    subcommands: {
      capture:
        "Usage: soma result capture --substrate <id> --source <source> --summary <text> [--artifact-path <path>...] [--skill <id>] [--session-id <id>] [--kind <kind>] [--home-dir <dir>] [--soma-home <dir>]",
      search: "Usage: soma result search --query <text> [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]",
    },
  },
  policy: {
    usage: "Usage: soma policy check --action write --destination <path> [--content <text>|--content-env <name>] [--source <path>] [--substrate <id>] [--record <all|deny|none>] [--json]",
    subcommands: {
      check:
        "Usage: soma policy check --action write --destination <path> [--content <text>|--content-env <name>] [--source <path>] [--substrate <id>] [--record <all|deny|none>] [--json]",
    },
  },
  lifecycle: {
    usage: "Usage: soma lifecycle <session-start|algorithm-updated|session-end> [--home-dir <dir>] [--soma-home <dir>] [--substrate <id>] [--session-id <id>]",
  },
  install: {
    usage: "Usage: soma install <codex|pi-dev|claude-code> [--dry-run] [--apply] [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
    subcommands: {
      codex: "Usage: soma install codex [--dry-run] [--apply] [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
      "pi-dev": "Usage: soma install pi-dev [--dry-run] [--apply] [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
      "claude-code": "Usage: soma install claude-code [--dry-run] [--apply] [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
    },
  },
  uninstall: {
    usage: "Usage: soma uninstall <codex|pi-dev|claude-code> [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
    subcommands: {
      codex: "Usage: soma uninstall codex [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
      "pi-dev": "Usage: soma uninstall pi-dev [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
      "claude-code": "Usage: soma uninstall claude-code [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
    },
  },
  reproject: {
    usage: "Usage: soma reproject <codex|pi-dev|claude-code> [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
  },
  upgrade: {
    usage: "Usage: soma upgrade <codex|pi-dev|claude-code> [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
  },
  export: {
    usage: "Usage: soma export <codex|pi-dev|claude-code> [--out <dir>] [--home-dir <dir>] [--soma-home <dir>]",
  },
  daemon: {
    usage: "Usage: soma daemon  (not yet implemented — placeholder reserves the runtime mode)",
  },
  import: {
    usage: "Usage: soma import <pai|algorithm|pai-pack|pai-docs> ...",
    subcommands: {
      pai: "Usage: soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]",
      algorithm: "Usage: soma import algorithm [--dry-run] [--apply] [--home-dir <dir>] [--pai-algorithm-dir <dir>] [--soma-home <dir>]",
      "pai-pack": "Usage: soma import pai-pack [--dry-run] [--apply] [--home-dir <dir>] [--source <dir>] [--soma-home <dir>]",
      "pai-docs": "Usage: soma import pai-docs [--dry-run] [--apply] [--home-dir <dir>] --pai-source-dir <dir> [--soma-home <dir>]",
    },
  },
  migrate: {
    usage: `${MIGRATE_PAI_USAGE}\n       ${MIGRATE_CLAUDE_SKILLS_USAGE.slice("Usage: ".length)}`,
    subcommands: {
      pai: MIGRATE_PAI_USAGE,
      "claude-skills": MIGRATE_CLAUDE_SKILLS_USAGE,
    },
  },
  adopt: {
    usage: ADOPT_CLAUDE_USAGE,
    subcommands: { claude: ADOPT_CLAUDE_USAGE },
  },
  isa: {
    // Single source of truth lives in `./cli-isa.ts` (Sage round-1 dedup).
    usage: ISA_USAGE_HEADER,
    subcommands: ISA_SUBCOMMAND_HELP,
  },
};

function readOption(args: string[], index: number, name: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

function commandUsage(command: string, action?: string): string {
  const commandHelp = COMMAND_HELP[command] as { usage: string; subcommands?: Record<string, string> } | undefined;
  return (action ? commandHelp?.subcommands?.[action] : undefined) ?? commandHelp?.usage ?? `Usage: soma ${command} ...`;
}

const INSTALL_SUBSTRATES = ["codex", "pi-dev", "claude-code"] as const satisfies readonly InstallSubstrate[];

function isInstallSubstrate(value: string | undefined): value is InstallSubstrate {
  return value !== undefined && (INSTALL_SUBSTRATES as readonly string[]).includes(value);
}

function workspaceSubstrateHome(substrate: InstallSubstrate): string {
  // CONTEXT.md Runtime modes: workspace projection lives at
  // `./.{codex,pi,claude}/soma` — a soma-scoped subdir so it doesn't
  // collide with substrate-native workspace files the principal may
  // already have for that repo.
  const folder = substrate === "pi-dev" ? ".pi" : substrate === "claude-code" ? ".claude" : ".codex";
  return resolveJoin(process.cwd(), folder, "soma");
}

function resolveJoin(...parts: string[]): string {
  // Local helper to keep the cli surface free of an extra import.
  return parts.join("/").replace(/\/+/g, "/");
}

// Shared option parser used by install/uninstall/reproject/upgrade.
// All four verbs accept the same workspace + path triplet; this
// keeps the workspace-default fallback in one place (Sage r1
// maintainability finding on #54).
function parseSubstrateLifecycleOptions(
  substrate: InstallSubstrate,
  rest: string[],
  extra: (arg: string, index: number) => boolean,
): { workspace: boolean; options: SomaInstallOptions } {
  const options: SomaInstallOptions = {};
  let workspace = false;
  let substrateHomeExplicit = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--workspace":
        workspace = true;
        continue;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        continue;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        continue;
      case "--substrate-home":
        options.substrateHome = readOption(rest, index, arg);
        substrateHomeExplicit = true;
        index += 1;
        continue;
    }

    if (extra(arg, index)) continue;

    throw new Error(`Unknown option: ${arg}`);
  }

  if (workspace && !substrateHomeExplicit) {
    options.substrateHome = workspaceSubstrateHome(substrate);
  }

  return { workspace, options };
}

function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const [command, substrate, ...rest] = args;

  if (command !== "install" || !isInstallSubstrate(substrate)) {
    throw new Error(commandUsage("install"));
  }

  let apply = false;
  // The install verb layers --dry-run / --apply on top of the
  // shared substrate-lifecycle option set. The `extra` callback
  // hands those two flags to the shared parser so it can recognize
  // them without claiming the other options.
  const { workspace, options } = parseSubstrateLifecycleOptions(substrate, rest, (arg) => {
    switch (arg) {
      case "--dry-run":
        apply = false;
        return true;
      case "--apply":
        apply = true;
        return true;
    }
    return false;
  });

  return { command, substrate, apply, workspace, options };
}

function parseLifecycleVerbArgs<T extends "uninstall" | "reproject" | "upgrade">(
  verb: T,
  args: string[],
): { substrate: InstallSubstrate; workspace: boolean; options: SomaInstallOptions } {
  const [command, substrate, ...rest] = args;

  if (command !== verb || !isInstallSubstrate(substrate)) {
    throw new Error(commandUsage(verb));
  }

  const { workspace, options } = parseSubstrateLifecycleOptions(substrate, rest, () => false);
  return { substrate, workspace, options };
}

function parseUninstallArgs(args: string[]): ParsedUninstallArgs {
  const { substrate, workspace, options } = parseLifecycleVerbArgs("uninstall", args);
  return { command: "uninstall", substrate, workspace, options };
}

function parseReprojectArgs(args: string[]): ParsedReprojectArgs {
  const { substrate, workspace, options } = parseLifecycleVerbArgs("reproject", args);
  return { command: "reproject", substrate, workspace, options };
}

function parseUpgradeArgs(args: string[]): ParsedUpgradeArgs {
  const { substrate, workspace, options } = parseLifecycleVerbArgs("upgrade", args);
  return { command: "upgrade", substrate, workspace, options };
}

function parseExportArgs(args: string[]): ParsedExportArgs {
  const [command, substrate, ...rest] = args;

  if (command !== "export" || !isInstallSubstrate(substrate)) {
    throw new Error(commandUsage("export"));
  }

  const options: SomaInstallOptions = {};
  let out: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--out":
        out = readOption(rest, index, arg);
        index += 1;
        break;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { command: "export", substrate, out, options };
}

function parseDaemonArgs(args: string[]): ParsedDaemonArgs {
  if (args[0] !== "daemon" || args.length > 1) {
    throw new Error(commandUsage("daemon"));
  }
  return { command: "daemon" };
}

function parseImportArgs(args: string[]): ParsedImportArgs {
  const [command, source, ...rest] = args;

  if (
    command !== "import" ||
    (source !== "pai" &&
      source !== "algorithm" &&
      source !== "pai-pack" &&
      source !== "pai-docs")
  ) {
    throw new Error(
      [
        "Usage:",
        "  soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]",
        "  soma import algorithm [--dry-run] [--apply] [--home-dir <dir>] [--pai-algorithm-dir <dir>] [--soma-home <dir>]",
        "  soma import pai-pack [--dry-run] [--apply] [--home-dir <dir>] --pai-pack-dir <dir> [--soma-home <dir>] [--skill-name <name>] [--overwrite] [--include-unrecognized]",
        "  soma import pai-docs [--dry-run] [--apply] [--home-dir <dir>] --pai-source-dir <dir> [--soma-home <dir>]",
      ].join("\n"),
    );
  }

  const options: PaiImportOptions &
    AlgorithmImportOptions &
    PaiPackImportOptions &
    PaiDocsImportOptions = {};
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
      case "--pai-source-dir":
        if (source !== "pai-docs") {
          throw new Error("--pai-source-dir is only valid for soma import pai-docs.");
        }
        options.paiSourceDir = readOption(rest, index, arg);
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
      case "--include-unrecognized":
        // #106 — canonical name; legacy flag below is the deprecated alias.
        if (source !== "pai-pack") {
          throw new Error("--include-unrecognized is only valid for soma import pai-pack.");
        }
        options.includeSubstrateSpecific = true;
        break;
      case "--include-substrate-specific":
        if (source !== "pai-pack") {
          throw new Error("--include-substrate-specific is only valid for soma import pai-pack.");
        }
        warnDeprecatedSubstrateFlag();
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
    throw new Error(commandUsage("algorithm"));
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
      case "--json":
        options.json = true;
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
    throw new Error(commandUsage("lifecycle"));
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
    throw new Error(commandUsage("memory"));
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
    throw new Error(commandUsage("feedback", "capture"));
  }

  const parsed = parseFeedbackCaptureArgs(rest);

  return {
    command,
    action,
    options: parsed.options,
    readTextFromStdin: parsed.readTextFromStdin,
  };
}

function parseResultKind(value: string): SomaResultEventKind {
  if (isSomaResultEventKind(value)) {
    return value;
  }

  throw new Error(`Unsupported result kind '${value}'. Expected one of: ${SOMA_RESULT_EVENT_KINDS.join(", ")}.`);
}

function readResultSharedOption(
  options: Pick<Partial<SomaResultCaptureOptions & SomaResultSearchOptions>, "homeDir" | "somaHome">,
  args: string[],
  index: number,
  arg: string,
): number | undefined {
  switch (arg) {
    case "--home-dir":
      options.homeDir = readOption(args, index, arg);
      return index + 1;
    case "--soma-home":
      options.somaHome = readOption(args, index, arg);
      return index + 1;
    default:
      return undefined;
  }
}

function parsePositiveIntegerOption(args: string[], index: number, arg: string): number {
  const raw = readOption(args, index, arg);
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${arg} must be a positive integer.`);
  }

  return Number(raw);
}

function parseResultCaptureArgs(args: string[]): SomaResultCaptureOptions {
  const options: Partial<SomaResultCaptureOptions> = {};
  const artifactPaths: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const sharedOptionIndex = readResultSharedOption(options, args, index, arg);
    if (sharedOptionIndex !== undefined) {
      index = sharedOptionIndex;
      continue;
    }

    switch (arg) {
      case "--substrate":
        options.substrate = parseSubstrate(readOption(args, index, arg));
        index += 1;
        break;
      case "--source":
        options.source = readOption(args, index, arg);
        index += 1;
        break;
      case "--summary":
        options.summary = readOption(args, index, arg);
        index += 1;
        break;
      case "--artifact-path":
        artifactPaths.push(readOption(args, index, arg));
        index += 1;
        break;
      case "--skill":
        options.skill = readOption(args, index, arg);
        index += 1;
        break;
      case "--session-id":
        options.sessionId = readOption(args, index, arg);
        index += 1;
        break;
      case "--kind":
        options.kind = parseResultKind(readOption(args, index, arg));
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  const missing: string[] = [];
  if (!options.substrate) missing.push("--substrate");
  if (!options.source) missing.push("--source");
  if (!options.summary) missing.push("--summary");
  if (missing.length > 0) {
    throw new Error(`soma result capture is missing required option(s): ${missing.join(", ")}.`);
  }

  return {
    ...options,
    artifactPaths: artifactPaths.length > 0 ? artifactPaths : undefined,
  } as SomaResultCaptureOptions;
}

function parseResultSearchArgs(args: string[]): SomaResultSearchOptions {
  const options: Partial<SomaResultSearchOptions> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const sharedOptionIndex = readResultSharedOption(options, args, index, arg);
    if (sharedOptionIndex !== undefined) {
      index = sharedOptionIndex;
      continue;
    }

    switch (arg) {
      case "--query":
        options.query = readOption(args, index, arg);
        index += 1;
        break;
      case "--limit":
        options.limit = parsePositiveIntegerOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.query) {
    throw new Error("soma result search is missing required option: --query.");
  }

  return options as SomaResultSearchOptions;
}

function parseResultArgs(args: string[]): ParsedResultArgs {
  const [command, action, ...rest] = args;

  if (command !== "result" || (action !== "capture" && action !== "search")) {
    throw new Error(commandUsage("result"));
  }

  if (action === "capture") {
    return {
      command,
      action,
      options: parseResultCaptureArgs(rest),
    };
  }

  return {
    command,
    action,
    options: parseResultSearchArgs(rest),
  };
}

function parsePolicyArgs(args: string[]): ParsedPolicyArgs {
  const [command, action, ...rest] = args;

  if (command !== "policy" || action !== "check") {
    throw new Error(commandUsage("policy", "check"));
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
        if (value !== "write" && value !== "delete" && value !== "modify") throw new Error("--action must be one of write, delete, or modify.");
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
      case "--protected-path": {
        const protectedPath = readOption(rest, index, arg);
        (options.protectedPaths ??= []).push({ path: protectedPath, description: protectedPath });
        index += 1;
        break;
      }
      case "--protected-path-name": {
        const name = readOption(rest, index, arg);
        if (!options.protectedPaths || options.protectedPaths.length === 0) {
          throw new Error("--protected-path-name requires a preceding --protected-path.");
        }
        options.protectedPaths[options.protectedPaths.length - 1].description = name;
        index += 1;
        break;
      }
      case "--private-root": {
        (options.privateRoots ??= []).push(readOption(rest, index, arg));
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
  if (args.length === 0) {
    return { command: "help", topic: [] };
  }

  if (isHelpRequest(args)) {
    const topic = helpTopic(args);
    const [command] = topic;

    if (command && !TOP_LEVEL_COMMANDS.includes(command as (typeof TOP_LEVEL_COMMANDS)[number])) {
      throw new Error(renderUnknownCommand(command));
    }

    return { command: "help", topic };
  }

  if (args[0] === "isa") {
    return { command: "isa", args: args.slice(1) };
  }

  if (args[0] === "lifecycle") {
    return parseLifecycleArgs(args);
  }

  if (args[0] === "memory") {
    return parseMemoryArgs(args);
  }

  if (args[0] === "feedback") {
    return parseFeedbackArgs(args);
  }

  if (args[0] === "result") {
    return parseResultArgs(args);
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

  if (args[0] === "uninstall") {
    return parseUninstallArgs(args);
  }

  if (args[0] === "reproject") {
    return parseReprojectArgs(args);
  }

  if (args[0] === "upgrade") {
    return parseUpgradeArgs(args);
  }

  if (args[0] === "export") {
    return parseExportArgs(args);
  }

  if (args[0] === "daemon") {
    return parseDaemonArgs(args);
  }

  if (args[0] === "import") {
    return parseImportArgs(args);
  }

  if (args[0] === "migrate") {
    return parseMigrateArgs(args);
  }

  if (args[0] === "adopt") {
    return parseAdoptArgs(args);
  }

  throw new Error(renderUnknownCommand(args[0]));
}

function parseAdoptArgs(args: string[]): ParsedAdoptArgs {
  const [command, substrate, ...rest] = args;
  if (command !== "adopt" || substrate !== "claude") {
    throw new Error(commandUsage("adopt", substrate));
  }
  const options: SomaInstallOptions & UninstallClaudeCodeOptions = {};
  let mode: "plan" | "apply" | "uninstall" = "plan";
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--dry-run":
        mode = "plan";
        break;
      case "--apply":
        mode = "apply";
        break;
      case "--uninstall":
        mode = "uninstall";
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
      case "--help":
        // Defensive: parseArgs intercepts --help at the top, but keep
        // this branch so the parser surfaces usage if called directly
        // (sage r1 on #72 — blocker bar).
        throw new Error(ADOPT_CLAUDE_USAGE);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { command: "adopt", substrate: "claude", mode, options };
}

function parseMigrateArgs(args: string[]): ParsedMigrateArgs | ParsedMigrateClaudeSkillsArgs {
  const [command, source] = args;
  if (command !== "migrate") {
    throw new Error(commandUsage("migrate"));
  }
  // #115 — second migration path. Routed early so the existing
  // pai-only parser body stays untouched.
  if (source === "claude-skills") {
    return parseMigrateClaudeSkillsArgs(args);
  }
  if (source !== "pai") {
    throw new Error(commandUsage("migrate", source));
  }
  return parseMigratePaiArgs(args);
}

function parseMigratePaiArgs(args: string[]): ParsedMigrateArgs {
  const [, , ...rest] = args;
  const options: PaiMigrationOptions = {};
  let mode: "plan" | "apply" | "status" = "plan";
  const packPaths: string[] = [];
  let verbose = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--dry-run":
        mode = "plan";
        break;
      case "--apply":
        mode = "apply";
        break;
      case "--status":
        mode = "status";
        break;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--claude-home":
        options.claudeHome = readOption(rest, index, arg);
        index += 1;
        break;
      // #90 — `--pai-install` is the principal-facing alias for
      // `--claude-home`. Both target the same option field; the alias
      // exists because the issue body specifies `--pai-install` as the
      // canonical flag for the full-migrate surface.
      case "--pai-install":
        options.claudeHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--pai-pack-dir":
        // #28 back-compat — explicit per-pack paths (one flag per pack).
        packPaths.push(readOption(rest, index, arg));
        index += 1;
        break;
      case "--pai-packs-dir":
        // #90 — single directory of many packs.
        options.paiPacksDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--pai-source-dir":
        options.paiSourceDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--pai-repo":
        // #98 — single PAI repo root. The orchestrator derives both
        // `paiSourceDir` (→ `<root>/Releases/<latest-semver>/.claude/PAI`)
        // and `paiPacksDir` (→ `<root>/Packs`) from it BEFORE the
        // phases run. Explicit `--pai-source-dir` / `--pai-packs-dir`
        // always win — `--pai-repo` only fills the unset slots. See
        // `applyPaiRepoDerivation` in `src/pai-migration.ts`.
        options.paiRepo = readOption(rest, index, arg);
        index += 1;
        break;
      case "--skip-memory":
        options.skipMemory = true;
        break;
      case "--skip-skills":
        options.skipSkills = true;
        break;
      case "--skip-docs":
        options.skipDocs = true;
        break;
      case "--overwrite-reserved":
        options.overwriteReserved = true;
        break;
      case "--include-unrecognized":
        // #106 — canonical name. Same passthrough as the legacy flag
        // below; routes to `importPaiPack`'s legacy
        // `includeSubstrateSpecific` SDK option key (kept stable to
        // avoid SDK churn — see PaiPackImportOptions docstring).
        options.includeSubstrateSpecific = true;
        break;
      case "--include-substrate-specific":
        // #97 — passthrough to `importPaiPack`. #106 renamed the
        // canonical flag to `--include-unrecognized`; this alias is
        // kept for one release with a stderr deprecation warning so
        // the canonical `migrate pai` walkthrough keeps working for
        // anyone with the old flag in shell history / scripts.
        warnDeprecatedSubstrateFlag();
        options.includeSubstrateSpecific = true;
        break;
      case "--verbose":
        // #106 — opt-in inline file lists in the plan/apply CLI
        // output. Without this flag, refused-unrecognized-layout
        // rows render as `(N files — run --verbose ...)` and the
        // imported/refused-other rows render their reasons truncated.
        // Full file lists ALWAYS land in MIGRATION.md regardless.
        verbose = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (packPaths.length > 0) options.paiPackPaths = packPaths;
  return { command: "migrate", source: "pai", mode, options, verbose };
}

function parseMigrateClaudeSkillsArgs(args: string[]): ParsedMigrateClaudeSkillsArgs {
  const [, , ...rest] = args;
  const options: ClaudeSkillsMigrationOptions = {};
  let mode: "plan" | "apply" | "status" = "plan";
  // #115 Phase 2 — accumulator for `--smoke <substrate>` (repeatable).
  // De-dup happens in the migrator; the parser preserves source-order
  // entries so duplicate flags don't fail. `all` expands to the full
  // substrate list at parse time so downstream consumers see a
  // resolved substrate set.
  const smokeAccumulator: ClaudeSkillsSmokeSubstrate[] = [];
  // #125 — `--quiet` suppresses stderr progress. The Timing block on
  // stdout is unaffected; principals who pipe stderr to /dev/null in
  // CI scripts no longer need to.
  let quiet = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--dry-run":
        mode = "plan";
        break;
      case "--apply":
        mode = "apply";
        break;
      case "--status":
        mode = "status";
        break;
      case "--from":
        options.from = readOption(rest, index, arg);
        index += 1;
        break;
      case "--home-dir":
        options.homeDir = readOption(rest, index, arg);
        index += 1;
        break;
      case "--soma-home":
        options.somaHome = readOption(rest, index, arg);
        index += 1;
        break;
      case "--include-claude-specific":
        options.includeClaudeSpecific = true;
        break;
      case "--smoke": {
        const value = readOption(rest, index, arg);
        index += 1;
        const expanded = expandSmokeSubstrateArg(value);
        for (const sub of expanded) {
          smokeAccumulator.push(sub);
        }
        break;
      }
      case "--rewrite-descriptions": {
        // #120 — LLM agent for description compression. Validated
        // against the canonical enum; unknown values reject with a
        // clear error listing accepted forms.
        const value = readOption(rest, index, arg);
        index += 1;
        options.rewriteDescriptionsAgent = parseRewriteDescriptionsAgent(value);
        break;
      }
      case "--quiet":
        // #125 — suppress per-skill stderr progress. Stdout summary
        // (including the new Timing block) stays byte-stable. CI-
        // friendly for scripts that don't want the progress noise.
        quiet = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (smokeAccumulator.length > 0) {
    options.smokeSubstrates = smokeAccumulator;
  }

  if (!options.from && mode !== "status") {
    throw new Error(MIGRATE_CLAUDE_SKILLS_USAGE);
  }

  return { command: "migrate", source: "claude-skills", mode, options, quiet };
}

// #115 Phase 2 — expand `--smoke <value>`. `all` resolves to every
// non-source substrate (codex + pi-dev — claude-code is the source
// substrate of `migrate claude-skills` and intentionally excluded
// because re-projecting an imported skill back to its source would
// only ever round-trip). Unknown values throw with the canonical
// allowed set so the principal sees what's accepted.
const VALID_SMOKE_VALUES: readonly (ClaudeSkillsSmokeSubstrate | "all")[] = [
  "codex",
  "pi-dev",
  "all",
];
function expandSmokeSubstrateArg(value: string): ClaudeSkillsSmokeSubstrate[] {
  if (value === "all") return ["codex", "pi-dev"];
  if (value === "codex" || value === "pi-dev") return [value];
  throw new Error(
    `Unknown --smoke substrate: ${JSON.stringify(value)}. Allowed: ${VALID_SMOKE_VALUES.join(", ")}.`,
  );
}

// #120 — `--rewrite-descriptions <value>` enum gate. The four accepted
// values are claude, codex, pi, none. Unknown rejects with a clear
// error listing every valid form. `none` is permitted explicitly so
// scripts can be parameterized without a separate "absent" branch.
const VALID_REWRITE_DESCRIPTIONS_AGENTS: readonly RewriteDescriptionsAgent[] = [
  "claude",
  "codex",
  "pi",
  "none",
];
function parseRewriteDescriptionsAgent(value: string): RewriteDescriptionsAgent {
  if ((VALID_REWRITE_DESCRIPTIONS_AGENTS as readonly string[]).includes(value)) {
    return value as RewriteDescriptionsAgent;
  }
  throw new Error(
    `Unknown --rewrite-descriptions agent: ${JSON.stringify(value)}. Allowed: ${VALID_REWRITE_DESCRIPTIONS_AGENTS.join(", ")}.`,
  );
}

function helpTopic(args: string[]): string[] {
  const helpIndex = args.indexOf("--help");
  const topicArgs = helpIndex === 0 ? args.slice(1) : args.slice(0, helpIndex);

  const firstFlagIndex = topicArgs.findIndex((arg) => arg.startsWith("--"));
  return (firstFlagIndex === -1 ? topicArgs : topicArgs.slice(0, firstFlagIndex)).slice(0, 2);
}

function isHelpRequest(args: string[]): boolean {
  const helpIndex = args.indexOf("--help");
  if (helpIndex === -1) return false;
  if (helpIndex === 0) return true;

  return args.slice(0, helpIndex).every((arg) => !arg.startsWith("--"));
}

function renderUsage(): string {
  const usageLines = [...new Set(Object.values(COMMAND_HELP).flatMap((commandHelp) =>
    [commandHelp.usage, ...Object.values(commandHelp.subcommands ?? {})].map((line) => `  ${line.slice("Usage: ".length)}`),
  ))];

  return [
    "Usage:",
    ...usageLines,
  ].join("\n");
}

function renderHelp(topic: string[]): string {
  const [command, action] = topic;

  if (!command) {
    return renderUsage();
  }

  return commandUsage(command, action);
}

function renderUnknownCommand(command: string): string {
  const suggestion = suggestTopLevelCommand(command);

  return [
    `Unknown command: ${command}`,
    suggestion ? `Did you mean: ${suggestion}?` : undefined,
    "",
    renderUsage(),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function suggestTopLevelCommand(command: string): string | undefined {
  const ranked = TOP_LEVEL_COMMANDS.map((candidate) => ({
    candidate,
    distance: editDistance(command, candidate),
  })).sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));

  const best = ranked[0];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!best) return undefined;

  const threshold = Math.max(2, Math.floor(best.candidate.length / 3));
  return best.distance <= threshold ? best.candidate : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array<number>(right.length + 1);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? left.length;
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

function formatClaudeUninstallResult(result: UninstallClaudeCodeResult): string {
  if (result.removed.length === 0) {
    return [
      "soma adopt claude — uninstall",
      "",
      `Substrate home: ${result.substrateHome}`,
      "Nothing to remove — Soma was not installed at this substrate home.",
      "",
    ].join("\n");
  }
  return [
    "soma adopt claude — uninstall",
    "",
    `Substrate home: ${result.substrateHome}`,
    "",
    "Removed:",
    ...result.removed.map((p) => `  - ${p}`),
    "",
  ].join("\n");
}

/**
 * #106 — build the helpful footer suggestion lines based on what
 * outcomes the principal is looking at. One line per refusal kind
 * that has a documented opt-in flag.
 */
function buildMigrationFooterSuggestions(
  outcomes: readonly { outcome: string }[],
): string[] {
  const unrecognizedCount = outcomes.filter((o) => o.outcome === "refused-unrecognized-layout").length;
  const reservedCount = outcomes.filter((o) => o.outcome === "refused-reserved").length;
  const lines: string[] = [];
  if (unrecognizedCount > 0) {
    const packLabel = unrecognizedCount === 1 ? "pack" : "packs";
    lines.push(
      `${unrecognizedCount} ${packLabel} refused-unrecognized-layout — re-run with --include-unrecognized to import them.`,
    );
  }
  if (reservedCount > 0) {
    const packLabel = reservedCount === 1 ? "pack" : "packs";
    lines.push(
      `${reservedCount} ${packLabel} refused-reserved — re-run with --overwrite-reserved to overwrite Soma's reserved skills.`,
    );
  }
  return lines;
}

/**
 * #106 — render inline file lists for `refused-unrecognized-layout`
 * outcomes when `--verbose` is set. Mirrors the per-pack section the
 * MIGRATION.md body always carries; the only diff is indent + the
 * one-line preface saying which pack the list belongs to.
 */
function renderVerboseUnrecognizedFiles(
  outcomes: readonly PaiPackOutcome[],
): string[] {
  const out: string[] = [];
  const needsDetail = outcomes
    .filter((o) => o.outcome === "refused-unrecognized-layout" && (o.unrecognizedFiles?.length ?? 0) > 0)
    .sort((a, b) => a.paiPackDir.localeCompare(b.paiPackDir));
  if (needsDetail.length === 0) return out;
  out.push("", "Unrecognized files (--verbose):");
  for (const o of needsDetail) {
    const label = o.skillName ?? o.paiPackDir;
    out.push(`  ${label}:`);
    for (const file of o.unrecognizedFiles ?? []) {
      out.push(`    - ${file}`);
    }
  }
  return out;
}

function formatPaiMigrationPlan(plan: PaiMigrationPlan, verbose = false): string {
  const algorithmLine = plan.algorithm
    ? `  - algorithm: ${plan.algorithm.sourceFiles.length} source file(s)`
    : "  - algorithm: not present";
  const memoryLine = plan.memory === null
    ? "  - memory:   skipped"
    : plan.memory.memoryDir === null
      ? "  - memory:   no PAI MEMORY tree present"
      : `  - memory:   ${plan.memory.files.length} file(s) to translate`;
  const docsLine = plan.docs === null
    ? "  - docs:     skipped (pass --pai-source-dir to enable)"
    : `  - docs:     ${plan.docs.files.length} file(s) from ${plan.docs.releaseVersion ?? "(no version)"}`;
  // #102 — render the per-pack outcome table on the plan surface, same
  // shape as the apply path (#97 AC-5). Single-sourced through
  // `formatPackOutcomeLines` so apply + plan can't drift on labels /
  // sort order / reason suffix. `labelKind: "path"` matches the
  // surrounding `Source:` / `Target:` / `Manifest:` full-path style.
  //
  // #106 — collapse style by default: refused-unrecognized-layout
  // rows render as `(N files — run --verbose or read MIGRATION.md)`
  // instead of dumping the full file list inline (was ~30KB for the
  // canonical PAI Packs collection). `--verbose` flips to the legacy
  // verbose style.
  const outcomeLines = formatPackOutcomeLines(plan.packOutcomes, {
    labelKind: "path",
    style: verbose ? "verbose" : "collapsed",
  });
  // `packs.length` now reflects "successfully planned" derived skills,
  // not source packs (#105 — a pack with N nested skills emits N
  // entries here, plus 1 row per outcome). The discovered count is
  // unique pack directories from outcomes; the to-import count is the
  // derived-skill cardinality.
  const uniquePackDirs = new Set(plan.packOutcomes.map((o) => o.paiPackDir)).size;
  const verboseDetail = verbose ? renderVerboseUnrecognizedFiles(plan.packOutcomes) : [];
  const footerSuggestions = buildMigrationFooterSuggestions(plan.packOutcomes);
  const footerLines = footerSuggestions.length === 0 ? [] : ["", ...footerSuggestions];
  return [
    "soma migrate pai — plan (dry-run; pass --apply to execute)",
    "",
    `Source:   ${plan.claudeHome}`,
    `Target:   ${plan.somaHome}`,
    `Manifest: ${plan.manifestPath}`,
    "",
    "Categories:",
    `  - identity: ${plan.identity.sourceFiles.length} source file(s)`,
    algorithmLine,
    memoryLine,
    docsLine,
    `  - packs:    ${uniquePackDirs} discovered, ${plan.packs.length} skill(s) to import`,
    "",
    "Pack outcomes:",
    ...outcomeLines,
    ...verboseDetail,
    ...footerLines,
    "",
  ].join("\n");
}

function formatPaiMigrationResult(result: PaiMigrationResult, verbose = false): string {
  const memoryLine = result.memory === null
    ? "  - memory:   skipped"
    : result.memory.memoryDir === null
      ? "  - memory:   no PAI MEMORY tree present"
      : `  - memory:   ${result.memory.writtenCount} written, ${result.memory.skippedCount} unchanged`;
  const docsLine = result.docs === null
    ? "  - docs:     skipped"
    : `  - docs:     ${result.docs.writtenCount} written, ${result.docs.files.length - result.docs.writtenCount} unchanged`;
  // #97 — per-pack outcome summary. Sage r1 #99: single-sourced
  // through `formatPackOutcomeLines` so the CLI summary and the
  // manifest body can't drift on outcome labels / reason suffix /
  // sort order. `labelKind: "path"` keeps the principal-facing
  // summary consistent with the surrounding `Source:` / `Target:`
  // / `Manifest:` lines (full paths).
  //
  // #106 — collapsed by default; `--verbose` plumbs through to the
  // legacy verbose form.
  const outcomeLines = formatPackOutcomeLines(result.packOutcomes, {
    labelKind: "path",
    style: verbose ? "verbose" : "collapsed",
  });
  // #105 — `result.packs` is now one-entry-per-derived-skill (a pack
  // with N nested skills produces N entries). The summary line counts
  // unique pack directories so the principal-facing count matches the
  // source-of-truth `~/work/PAI/Packs/` cardinality, not the derived
  // skill cardinality (which lives in the outcomes table immediately
  // below).
  const uniquePackDirs = new Set(result.packs.map((p) => p.paiPackDir)).size;
  const verboseDetail = verbose ? renderVerboseUnrecognizedFiles(result.packOutcomes) : [];
  const footerSuggestions = buildMigrationFooterSuggestions(result.packOutcomes);
  const footerLines = footerSuggestions.length === 0 ? [] : ["", ...footerSuggestions];
  return [
    "soma migrate pai — applied",
    "",
    `Source:   ${result.claudeHome}`,
    `Target:   ${result.somaHome}`,
    `Manifest: ${result.manifestPath}`,
    "",
    "Written:",
    `  - identity: ${result.identity.files.length} file(s)`,
    result.algorithm ? `  - algorithm: ${result.algorithm.files.length} file(s)` : "  - algorithm: skipped (not present)",
    memoryLine,
    docsLine,
    `  - packs:    ${uniquePackDirs} pack(s) → ${result.packs.length} skill(s), ${result.packs.reduce((sum, p) => sum + p.files.length, 0)} file(s)`,
    "",
    "Pack outcomes:",
    ...outcomeLines,
    ...verboseDetail,
    ...footerLines,
    "",
    `Total files written: ${result.filesWritten.length}`,
    "",
  ].join("\n");
}

async function readPaiMigrationManifest(options: PaiMigrationOptions): Promise<string | null> {
  // Sage r1: derive manifest path directly without invoking the
  // migration planner. Status only needs to read the existing
  // manifest; source-discovery + pack-listing work is irrelevant
  // here and would make `--status` fail on, e.g., missing source
  // dirs even when the manifest exists.
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const somaHome = resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
  const manifestPath = join(somaHome, "profile/imports/claude/MIGRATION.md");
  try {
    return await readFile(manifestPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function formatPaiMigrationStatus(manifest: string | null): string {
  if (manifest === null) {
    return "soma migrate pai — no migration manifest found. Run `soma migrate pai --apply` first.\n";
  }
  return `${manifest}\n`;
}

// #124 — Grouped outcome structure for disposition-bucketed output.
interface GroupedOutcomes {
  imported: {
    portable: ClaudeSkillOutcome[];
    needsAdapt: ClaudeSkillOutcome[];
    descriptionRewritten: ClaudeSkillOutcome[];
  };
  skippedClaudeSpecific: {
    slashCommand: ClaudeSkillOutcome[];
    hookBinding: ClaudeSkillOutcome[];
    other: ClaudeSkillOutcome[];
  };
  skippedIdempotent: ClaudeSkillOutcome[];
  refusedDescriptionLimit: ClaudeSkillOutcome[];
  refusedOther: ClaudeSkillOutcome[];
}

function groupOutcomesByDisposition(outcomes: readonly ClaudeSkillOutcome[]): GroupedOutcomes {
  const groups: GroupedOutcomes = {
    imported: { portable: [], needsAdapt: [], descriptionRewritten: [] },
    skippedClaudeSpecific: { slashCommand: [], hookBinding: [], other: [] },
    skippedIdempotent: [],
    refusedDescriptionLimit: [],
    refusedOther: [],
  };
  for (const o of outcomes) {
    switch (o.disposition) {
      case "imported":
        if (o.tag === "portable") groups.imported.portable.push(o);
        else if (o.tag === "needs-adapt") groups.imported.needsAdapt.push(o);
        else groups.imported.portable.push(o);
        if (o.descriptionRewrite) groups.imported.descriptionRewritten.push(o);
        break;
      case "skipped-claude-specific":
        if (o.reason.startsWith(REASON_PREFIX_SLASH_COMMAND)) groups.skippedClaudeSpecific.slashCommand.push(o);
        else if (o.reason.startsWith(REASON_PREFIX_HOOK_BINDING)) groups.skippedClaudeSpecific.hookBinding.push(o);
        else groups.skippedClaudeSpecific.other.push(o);
        break;
      case "skipped-idempotent":
        groups.skippedIdempotent.push(o);
        break;
      case "refused-description-limit":
        groups.refusedDescriptionLimit.push(o);
        break;
      case "refused-other":
        groups.refusedOther.push(o);
        break;
      default: {
        const _exhaustive: never = o.disposition;
        throw new Error(`unhandled disposition: ${_exhaustive}`);
      }
    }
  }
  return groups;
}

function renderGroupedOutcomeLines(
  groups: GroupedOutcomes,
  opts: {
    smokeSubstrates?: readonly ClaudeSkillsSmokeSubstrate[];
  },
): string[] {
  const lines: string[] = [];
  const importedTotal =
    groups.imported.portable.length +
    groups.imported.needsAdapt.length;

  if (importedTotal > 0) {
    lines.push(`### Imported (${importedTotal})`);
    lines.push("");
    if (groups.imported.portable.length > 0) {
      lines.push(`Portable (${groups.imported.portable.length}):`);
      for (const o of groups.imported.portable) {
        lines.push(`  - ${o.kebabName}${renderSkillSuffix(o, opts)}`);
      }
      lines.push("");
    }
    if (groups.imported.needsAdapt.length > 0) {
      lines.push(`Needs-adapt (${groups.imported.needsAdapt.length}):`);
      for (const o of groups.imported.needsAdapt) {
        const refCount = extractRefCount(o.reason);
        lines.push(`  - ${o.kebabName} (${refCount} refs)${renderSkillSuffix(o, opts)}`);
      }
      lines.push("");
    }
    if (groups.imported.descriptionRewritten.length > 0) {
      lines.push(`Description rewritten (${groups.imported.descriptionRewritten.length}):`);
      for (const o of groups.imported.descriptionRewritten) {
        const rw = o.descriptionRewrite!;
        lines.push(`  - ${o.kebabName} (${rw.originalLength} → ${rw.rewrittenLength} chars, ${rw.agent})`);
      }
      lines.push("");
    }
  }

  const claudeSpecificTotal =
    groups.skippedClaudeSpecific.slashCommand.length +
    groups.skippedClaudeSpecific.hookBinding.length +
    groups.skippedClaudeSpecific.other.length;

  if (claudeSpecificTotal > 0) {
    lines.push(`### Skipped — claude-specific (${claudeSpecificTotal})`);
    lines.push("");
    if (groups.skippedClaudeSpecific.slashCommand.length > 0) {
      lines.push(`Slash-command refs (${groups.skippedClaudeSpecific.slashCommand.length}):`);
      for (const o of groups.skippedClaudeSpecific.slashCommand) {
        lines.push(`  - ${o.kebabName} (${extractClassifierDetail(o.reason)})`);
      }
      lines.push("");
    }
    if (groups.skippedClaudeSpecific.hookBinding.length > 0) {
      lines.push(`Hook bindings (${groups.skippedClaudeSpecific.hookBinding.length}):`);
      for (const o of groups.skippedClaudeSpecific.hookBinding) {
        lines.push(`  - ${o.kebabName} (${extractClassifierDetail(o.reason)})`);
      }
      lines.push("");
    }
    if (groups.skippedClaudeSpecific.other.length > 0) {
      lines.push(`Other (${groups.skippedClaudeSpecific.other.length}):`);
      for (const o of groups.skippedClaudeSpecific.other) {
        lines.push(`  - ${o.kebabName} (${o.reason})`);
      }
      lines.push("");
    }
  }

  if (groups.skippedIdempotent.length > 0) {
    lines.push(`### Skipped — idempotent (${groups.skippedIdempotent.length})`);
    lines.push("");
    for (const o of groups.skippedIdempotent) {
      lines.push(`  - ${o.kebabName}`);
    }
    lines.push("");
  }

  if (groups.refusedDescriptionLimit.length > 0) {
    lines.push(`### Refused — description-limit (${groups.refusedDescriptionLimit.length})`);
    lines.push("");
    for (const o of groups.refusedDescriptionLimit) {
      lines.push(`  - ${o.kebabName} (${resolveOutcomeReason(o)})`);
    }
    lines.push("");
  }

  if (groups.refusedOther.length > 0) {
    lines.push(`### Refused — other (${groups.refusedOther.length})`);
    lines.push("");
    for (const o of groups.refusedOther) {
      lines.push(`  - ${o.kebabName} (${resolveOutcomeReason(o)})`);
    }
    lines.push("");
  }

  return lines;
}

function renderSkillSuffix(
  o: ClaudeSkillOutcome,
  opts: {
    smokeSubstrates?: readonly ClaudeSkillsSmokeSubstrate[];
  },
): string {
  let suffix = "";
  if (opts.smokeSubstrates && opts.smokeSubstrates.length > 0 && o.substrates) {
    const parts = opts.smokeSubstrates
      .map((sub) => {
        const v = o.substrates?.[sub];
        return v ? `${sub}=${v.status}` : null;
      })
      .filter((s): s is string => s !== null);
    if (parts.length > 0) suffix = ` [${parts.join(", ")}]`;
  }
  return suffix;
}

function extractRefCount(reason: string): number {
  const match = reason.match(/^(\d+)\s/);
  return match ? parseInt(match[1], 10) : 0;
}

function extractClassifierDetail(reason: string): string {
  const inMatch = reason.match(/in\s+(.+)$/);
  return inMatch ? inMatch[1] : reason;
}

// #115 — `soma migrate claude-skills` formatters. Mirrors the `migrate
// pai` shape (header line + per-row table) so principals reading
// both surfaces don't need to context-switch.
// #124 — Grouped by disposition for scannable outcome summaries.
function formatClaudeSkillsMigrationPlan(plan: ClaudeSkillsMigrationPlan): string {
  if (!plan.isFlatSkillsTree) {
    return [
      "soma migrate claude-skills — plan (dry-run)",
      `from: ${plan.from}`,
      `somaHome: ${plan.somaHome}`,
      "",
      "Refused: --from is not a flat skills tree (no <Name>/SKILL.md direct children).",
      "Point --from at an installed `.claude/skills/` tree (e.g. ~/.claude/skills or ~/work/PAI/Releases/v5.0.0/.claude/skills).",
      "",
    ].join("\n");
  }
  const lines: string[] = [
    "soma migrate claude-skills — plan (dry-run; pass --apply to execute)",
    `from: ${plan.from}`,
    `somaHome: ${plan.somaHome}`,
    `include-claude-specific: ${plan.includeClaudeSpecific ? "yes" : "no"}`,
  ];
  if (plan.smokeSubstrates.length > 0) {
    lines.push(`smoke-substrates: ${plan.smokeSubstrates.join(", ")}`);
  }
  if (plan.rewriteDescriptionsAgent !== "none") {
    lines.push(`rewrite-descriptions: ${plan.rewriteDescriptionsAgent}`);
  }
  lines.push("");
  const groups = groupOutcomesByDisposition(plan.outcomes);
  lines.push(...renderGroupedOutcomeLines(groups, {
    smokeSubstrates: plan.smokeSubstrates,
  }));
  const counts = countOutcomesByDisposition(plan.outcomes);
  lines.push("---");
  lines.push("");
  lines.push(
    `Totals: ${counts.imported} imported, ${counts.skippedIdempotent} skipped-idempotent, ${counts.skippedClaudeSpecific} skipped-claude-specific, ${counts.refusedOther} refused-other, ${counts.refusedDescriptionLimit} refused-description-limit.`,
  );
  if (counts.skippedClaudeSpecific > 0 && !plan.includeClaudeSpecific) {
    lines.push(
      `${counts.skippedClaudeSpecific} skill(s) tagged claude-specific — re-run with --include-claude-specific to import them anyway.`,
    );
  }
  if (counts.refusedOther > 0) {
    lines.push(
      `${counts.refusedOther} skill(s) refused (out-of-home symlink, cycle, or other genuine error). Plan mode exits 0; apply mode exits 1.`,
    );
  }
  if (counts.refusedDescriptionLimit > 0) {
    lines.push(
      `${counts.refusedDescriptionLimit} skill(s) refused-description-limit — re-run with --rewrite-descriptions claude (or codex/pi) to compress oversize descriptions via LLM.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function formatClaudeSkillsMigrationResult(result: ClaudeSkillsMigrationResult): string {
  const lines: string[] = [
    "soma migrate claude-skills — applied",
    `from: ${result.from}`,
    `somaHome: ${result.somaHome}`,
    `importedAt: ${result.importedAt}`,
    `manifest: ${result.manifestPath}`,
    `report:   ${result.reportPath}`,
    `include-claude-specific: ${result.includeClaudeSpecific ? "yes" : "no"}`,
  ];
  if (result.smokeSubstrates.length > 0) {
    lines.push(`smoke-substrates: ${result.smokeSubstrates.join(", ")}`);
  }
  if (result.rewriteDescriptionsAgent !== "none") {
    lines.push(`rewrite-descriptions: ${result.rewriteDescriptionsAgent}`);
  }
  lines.push("");
  const groups = groupOutcomesByDisposition(result.outcomes);
  lines.push(...renderGroupedOutcomeLines(groups, {
    smokeSubstrates: result.smokeSubstrates,
  }));
  lines.push("---");
  lines.push("");
  lines.push(
    `Totals: ${result.writtenCount} written, ${result.skippedIdempotentCount} skipped-idempotent, ${result.skippedClaudeSpecificCount} skipped-claude-specific, ${result.refusedOtherCount} refused-other, ${result.refusedDescriptionLimitCount} refused-description-limit.`,
  );
  if (result.descriptionRewrittenCount > 0) {
    lines.push(
      `Descriptions rewritten this run: ${result.descriptionRewrittenCount} via ${result.rewriteDescriptionsAgent}.`,
    );
  }
  if (result.substrateVerifySummary) {
    for (const substrate of result.smokeSubstrates) {
      const bucket = result.substrateVerifySummary[substrate];
      if (!bucket) continue;
      lines.push(
        `Smoke ${substrate}: ${bucket.verified} verified, ${bucket.verifiedWithWarnings} verified-with-warnings, ${bucket.failed} failed.`,
      );
    }
  }
  if (result.skippedClaudeSpecificCount > 0 && !result.includeClaudeSpecific) {
    lines.push(
      `${result.skippedClaudeSpecificCount} skill(s) refused-claude-specific — re-run with --include-claude-specific to import them anyway.`,
    );
  }
  if (result.refusedDescriptionLimitCount > 0) {
    lines.push(
      `${result.refusedDescriptionLimitCount} skill(s) refused-description-limit — re-run with --rewrite-descriptions claude (or codex/pi) to compress oversize descriptions via LLM.`,
    );
  }
  // #125 — Timing block. Appended to the standard summary so script
  // parsers that anchor on `Totals: ` keep working; the new block
  // lives BELOW the totals and rerun-suggestion lines. Renders even
  // when stderr was quiet — the timing belongs to the stdout summary.
  if (result.timing) {
    // Build a lightweight emitter to reuse the formatting logic.
    // The sink is unused (we only call `finishTimingSummary`).
    const emitter = createProgressEmitter({
      stderr: process.stderr,
      quiet: true,
      isatty: false,
    });
    lines.push("");
    lines.push(emitter.finishTimingSummary(result.timing));
  }
  lines.push("");
  return lines.join("\n");
}

function formatClaudeSkillsMigrationStatus(
  manifest: ClaudeSkillsMigrationManifest | null,
): string {
  if (manifest === null) {
    return "soma migrate claude-skills — no migration manifest found. Run `soma migrate claude-skills --from <dir> --apply` first.\n";
  }
  const lines: string[] = [
    "soma migrate claude-skills — status",
    `from: ${manifest.from}`,
    `somaHome: ${manifest.somaHome}`,
    `importedAt: ${manifest.importedAt}`,
    `include-claude-specific: ${manifest.includeClaudeSpecific ? "yes" : "no"}`,
    `skills: ${manifest.skills.length}`,
    "",
  ];
  for (const entry of manifest.skills) {
    lines.push(`  - ${entry.kebabName} [${entry.tag}] (${Object.keys(entry.fileShas).length} files)`);
  }
  lines.push("");
  return lines.join("\n");
}

function countOutcomesByDisposition(
  outcomes: readonly { disposition: string }[],
): {
  imported: number;
  skippedIdempotent: number;
  skippedClaudeSpecific: number;
  refusedOther: number;
  // #120 — count of outcomes in the new `refused-description-limit`
  // disposition. Surfaced in the plan/apply totals lines so a
  // principal can see the rewrite-flag opportunity at a glance.
  refusedDescriptionLimit: number;
} {
  let imported = 0;
  let skippedIdempotent = 0;
  let skippedClaudeSpecific = 0;
  let refusedOther = 0;
  let refusedDescriptionLimit = 0;
  for (const o of outcomes) {
    if (o.disposition === "imported") imported += 1;
    else if (o.disposition === "skipped-idempotent") skippedIdempotent += 1;
    else if (o.disposition === "skipped-claude-specific") skippedClaudeSpecific += 1;
    else if (o.disposition === "refused-other") refusedOther += 1;
    else if (o.disposition === "refused-description-limit") refusedDescriptionLimit += 1;
  }
  return { imported, skippedIdempotent, skippedClaudeSpecific, refusedOther, refusedDescriptionLimit };
}

function formatPaiImportPlan(plan: PaiImportPlan): string {
  const sourceLines =
    plan.sourceChecks && plan.sourceChecks.length > 0
      ? plan.sourceChecks.map((check) => `- [${check.present ? "present" : "missing"}] ${check.required ? "required" : "optional"} ${check.path}`)
      : plan.sourceFiles.map((path) => `- ${path}`);

  return [
    "Soma PAI import plan",
    "source: pai",
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `claudeHome: ${plan.claudeHome}`,
    `somaHome: ${plan.somaHome}`,
    "",
    "Source files:",
    ...sourceLines,
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
  const sourceLines =
    plan.sourceChecks && plan.sourceChecks.length > 0
      ? plan.sourceChecks.map((check) => `- [${check.present ? "present" : "missing"}] ${check.required ? "required" : "optional"} ${check.path}`)
      : plan.sourceFiles.map((path) => `- ${path}`);

  return [
    "Soma Algorithm import plan",
    "source: algorithm",
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `paiAlgorithmDir: ${plan.paiAlgorithmDir}`,
    `somaHome: ${plan.somaHome}`,
    "",
    "Source files:",
    ...sourceLines,
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

function formatOnePaiPackImportPlan(plan: PaiPackImportPlan): string {
  const counts = plan.files.reduce<Partial<Record<string, number>>>((acc, file) => {
    acc[file.classification] = (acc[file.classification] ?? 0) + 1;
    return acc;
  }, {});

  const normalizationLines: string[] = [];
  if (plan.normalization.actions.length > 0 || plan.normalization.warnings.length > 0) {
    normalizationLines.push("", "Normalization:");
    if (plan.normalization.actions.length > 0) {
      normalizationLines.push(`  actions: ${plan.normalization.actions.length}`);
      for (const action of plan.normalization.actions) {
        normalizationLines.push(`  - [action] ${action.file}: ${action.kind} — ${action.detail}`);
      }
    }
    if (plan.normalization.warnings.length > 0) {
      normalizationLines.push(`  warnings: ${plan.normalization.warnings.length}`);
      for (const warning of plan.normalization.warnings) {
        normalizationLines.push(`  - [warning] ${warning.file}: ${warning.kind} — ${warning.detail}`);
      }
    }
  } else {
    normalizationLines.push("", "Normalization: no actions, no warnings");
  }

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
    `- unrecognized-layout: ${counts["unrecognized-layout"] ?? 0}`,
    ...normalizationLines,
    "",
    "Files:",
    ...plan.files.map((file) => {
      const source = file.origin === "source" ? file.source : `generated:${file.generator}`;
      return `- [${file.classification}] ${source} -> ${file.target}`;
    }),
  ].join("\n");
}

/**
 * #105 — `importPaiPack` / `planPaiPackImport` now return an array
 * (one entry per derived skill). The CLI prints each plan/result in
 * turn separated by a blank line so multi-skill packs surface every
 * derived skill to the principal.
 */
function formatPaiPackImportPlan(plans: PaiPackImportPlan[]): string {
  if (plans.length === 0) return "Soma PAI Pack import plan: no derived skills.";
  if (plans.length === 1) return formatOnePaiPackImportPlan(plans[0]);
  const header = `Soma PAI Pack import plan: ${plans.length} derived skill(s) — ${plans.map((p) => p.skillName).join(", ")}`;
  return [header, "", ...plans.map(formatOnePaiPackImportPlan)].join("\n\n");
}

function formatOnePaiPackImportResult(result: PaiPackImportResult): string {
  const quotedSomaHome = quoteShellArg(result.somaHome);

  const normalizationLines: string[] = [];
  if (result.normalization.actions.length > 0 || result.normalization.warnings.length > 0) {
    normalizationLines.push("", "Normalization applied:");
    normalizationLines.push(`  actions: ${result.normalization.actions.length}`);
    normalizationLines.push(`  warnings: ${result.normalization.warnings.length}`);
  }

  return [
    "Soma PAI Pack import applied",
    `paiPackDir: ${result.paiPackDir}`,
    `somaHome: ${result.somaHome}`,
    `skillName: ${result.skillName}`,
    ...normalizationLines,
    "",
    "Next step:",
    "Import makes the skill available in Soma. Refresh the target substrate projection before expecting the skill in that substrate.",
    `bun run soma install <substrate> --apply --soma-home ${quotedSomaHome}`,
    "",
    "Files:",
    ...result.files.map((path) => `- ${path}`),
  ].join("\n");
}

function formatPaiPackImportResult(results: PaiPackImportResult[]): string {
  if (results.length === 0) return "Soma PAI Pack import applied: no derived skills.";
  if (results.length === 1) return formatOnePaiPackImportResult(results[0]);
  const header = `Soma PAI Pack import applied: ${results.length} derived skill(s) — ${results.map((r) => r.skillName).join(", ")}`;
  return [header, "", ...results.map(formatOnePaiPackImportResult)].join("\n\n");
}

function formatPaiDocsImportPlan(plan: PaiDocsImportPlan): string {
  const counts = plan.files.reduce<Partial<Record<string, number>>>((acc, file) => {
    acc[file.subdir] = (acc[file.subdir] ?? 0) + 1;
    return acc;
  }, {});

  return [
    "Soma PAI docs import plan",
    "source: pai-docs",
    `mode: ${plan.apply ? "apply" : "dry-run"}`,
    `paiSourceDir: ${plan.paiSourceDir}`,
    `somaHome: ${plan.somaHome}`,
    `releaseVersion: ${plan.releaseVersion ?? "<unknown>"}`,
    "",
    "Counts:",
    // Drive the counts from the shared subtree constant so adding a
    // subtree only requires touching `PAI_DOCS_IMPORT_SUBDIRS`.
    ...PAI_DOCS_IMPORT_SUBDIRS.map((subdir) => `- ${subdir}: ${counts[subdir] ?? 0}`),
    "",
    "Files:",
    ...plan.files.map((file) => `- ${file.relativePath} -> ${file.target}`),
  ].join("\n");
}

function formatPaiDocsImportResult(result: PaiDocsImportResult): string {
  return [
    "Soma PAI docs import applied",
    `paiSourceDir: ${result.paiSourceDir}`,
    `somaHome: ${result.somaHome}`,
    `releaseVersion: ${result.releaseVersion ?? "<unknown>"}`,
    `importedAt: ${result.importedAt}`,
    `writtenCount: ${result.writtenCount}${result.unchanged ? " (idempotent no-op — source SHAs unchanged)" : ""}`,
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

function formatResultCaptureResult(result: SomaResultCaptureResult): string {
  return [
    "Soma result capture",
    `event: ${result.event.id}`,
    `kind: ${result.event.kind}`,
    `somaHome: ${result.somaHome}`,
    result.event.artifactPaths && result.event.artifactPaths.length > 0
      ? `artifactPaths: ${result.event.artifactPaths.map((artifactPath) => sanitizeTerminalText(artifactPath)).join(", ")}`
      : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function sanitizeTerminalText(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1F\x7F]/g, " ");
}

function formatResultSearchResult(result: SomaResultSearchResult): string {
  return [
    "Soma result search",
    `query: ${sanitizeTerminalText(result.query)}`,
    `somaHome: ${result.somaHome}`,
    "",
    "Matches:",
    ...(result.matches.length > 0
      ? result.matches.map((match) =>
          [
            `- ${match.eventPath}:${match.line}`,
            `[event ${match.eventId}]`,
            `[kind ${match.kind}]`,
            `[score ${match.score}]`,
            sanitizeTerminalText(match.summary),
            match.artifactPaths.length > 0
              ? `(artifacts: ${match.artifactPaths.map((artifactPath) => sanitizeTerminalText(artifactPath)).join(", ")})`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        )
      : ["- none"]),
  ].join("\n");
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
        ((target as SomaPolicyBatchTarget).action !== undefined &&
          (typeof (target as SomaPolicyBatchTarget).action !== "string" || !["write", "delete", "modify"].includes((target as SomaPolicyBatchTarget).action ?? ""))) ||
        ((target as SomaPolicyBatchTarget).content !== undefined && typeof (target as SomaPolicyBatchTarget).content !== "string") ||
        ((target as SomaPolicyBatchTarget).sourcePath !== undefined && typeof (target as SomaPolicyBatchTarget).sourcePath !== "string"),
    )
  ) {
    throw new Error(
      `--targets-env ${envName} must contain an array of targets with string filePath values and optional string content/sourcePath values. Optional action must be one of write, delete, or modify.`,
    );
  }

  return targets as SomaPolicyBatchTarget[];
}

function formatAlgorithmRun(run: AlgorithmRun, path: string): string {
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
    "",
    "Criteria:",
    ...getCriteria(run.isa).map((criterion) => `- [${criterion.status}] ${criterion.id}: ${criterion.text}${criterion.verification ? ` | ${criterion.verification}` : ""}`),
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
    return options.json ? formatAlgorithmClassificationJson(options.prompt) : formatAlgorithmClassification(options.prompt);
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

  if (parsed.command === "help") {
    return renderHelp(parsed.topic);
  }

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

  if (parsed.command === "isa") {
    const result = await runIsaCli(parsed.args);
    if (result.exitCode !== 0) {
      // Propagate non-zero exit via the same SomaCliError pattern used
      // elsewhere — bubble up to process.exit at the top-level harness.
      throw new SomaCliError(result.text, result.exitCode);
    }
    return result.text;
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

  if (parsed.command === "result") {
    if (parsed.action === "capture") {
      return formatResultCaptureResult(await captureSomaResult(parsed.options));
    }

    return formatResultSearchResult(await searchSomaResults(parsed.options));
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
        privateRoots: parsed.options.privateRoots,
        protectedPaths: parsed.options.protectedPaths,
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

    if (parsed.source === "pai-docs") {
      const options = parsed.options as PaiDocsImportOptions;

      if (!parsed.apply) {
        return formatPaiDocsImportPlan(await planPaiDocsImport(options));
      }

      return formatPaiDocsImportResult(await importPaiDocs(options));
    }

    const options = parsed.options as PaiImportOptions;

    if (!parsed.apply) {
      return formatPaiImportPlan(planPaiImport(options));
    }

    return formatPaiImportResult(await importPaiIdentity(options));
  }

  if (parsed.command === "migrate") {
    // #115 — second migration path. Dispatched first so the
    // existing PAI path stays untouched.
    if (parsed.source === "claude-skills") {
      const claudeOptions = parsed.options;
      if (parsed.mode === "status") {
        return formatClaudeSkillsMigrationStatus(
          await readClaudeSkillsMigrationStatus(claudeOptions),
        );
      }
      // #125 — build the progress emitter once at the CLI boundary.
      // `quiet` collapses to a no-op emitter; otherwise we bind to
      // `process.stderr` and detect TTY via `isTTY === true` on the
      // same stream. Tests inject `claudeOptions.progressEmitter`
      // directly (the parser doesn't expose stream injection), so
      // we only build the default when the caller didn't supply
      // one. This keeps `runSomaCli`-based tests free to assert on
      // a captured emitter.
      if (!claudeOptions.progressEmitter) {
        claudeOptions.progressEmitter = createProgressEmitter({
          stderr: process.stderr,
          quiet: parsed.quiet === true,
          isatty: process.stderr.isTTY === true,
        });
      }
      if (parsed.mode === "plan") {
        // #118 — plan mode is informative; refused-other rows are
        // displayed but the CLI exits 0 (mirror of #112's plan/apply
        // split for `migrate pai`).
        return formatClaudeSkillsMigrationPlan(
          await planClaudeSkillsMigration(claudeOptions),
        );
      }
      const csResult = await migrateClaudeSkills(claudeOptions);
      const formatted = formatClaudeSkillsMigrationResult(csResult);
      // #118 — apply mode: surface a non-zero exit code when any skill
      // refused with a genuine error (out-of-home symlink target,
      // cycle, broken link, denylisted target). Plan mode already
      // returned without throwing above. Other dispositions
      // (skipped-claude-specific, skipped-idempotent) are policy-
      // respected and stay zero-exit.
      if (csResult.refusedOtherCount > 0) {
        const refused = csResult.outcomes.filter((o) => o.disposition === "refused-other");
        const detail = refused
          .map((o) => `  - ${o.sourceName}: ${o.refusalReason ?? o.reason}`)
          .join("\n");
        throw new SomaCliError(
          `${formatted}\nsoma migrate claude-skills — ${csResult.refusedOtherCount} skill(s) refused with genuine errors:\n${detail}\n`,
          1,
        );
      }
      return formatted;
    }
    if (parsed.mode === "status") {
      return formatPaiMigrationStatus(await readPaiMigrationManifest(parsed.options));
    }
    if (parsed.mode === "plan") {
      const plan = await planPaiMigration(parsed.options);
      const formatted = formatPaiMigrationPlan(plan, parsed.verbose);
      // #112 — split exit semantics by mode. Plan-mode (dry-run) is
      // "show me what would happen"; a known-malformed upstream pack
      // is informative, not a deploy blocker. The footer line stays —
      // it's the principal signal regardless of exit code — but the
      // CLI exits 0 so interactive use doesn't pair a non-zero exit
      // with what is essentially a preview. Apply-mode keeps exit 1
      // on `refused-other` per #97 AC-4 (write phase had a genuine
      // error → CI must triage).
      //
      // Pre-#112 (per #102 AC-4 mirror): plan mode shared the apply
      // policy and threw `SomaCliError(..., 1)` on any `refused-other`.
      // That mirror is intentionally dropped here.
      const refusedOther = plan.packOutcomes.filter((o) => o.outcome === "refused-other");
      if (refusedOther.length > 0) {
        const detail = refusedOther
          .map((o) => `  - ${o.skillName ?? o.paiPackDir}: ${o.reason ?? "(no detail)"}`)
          .join("\n");
        return `${formatted}\nsoma migrate pai — ${refusedOther.length} pack(s) failed with genuine errors:\n${detail}\n`;
      }
      return formatted;
    }
    const result = await migratePai(parsed.options);
    const formatted = formatPaiMigrationResult(result, parsed.verbose);
    // #97 — AC-4: exit non-zero only when a pack outcome is
    // `refused-other` (genuine error). Substrate-specific and
    // reserved-name refusals are policy-respected and zero-exit; the
    // principal asked for them by NOT passing the relevant override
    // flag. The CLI still prints the full outcome table so they
    // know what happened.
    const refusedOther = result.packOutcomes.filter((o) => o.outcome === "refused-other");
    if (refusedOther.length > 0) {
      const detail = refusedOther
        .map((o) => `  - ${o.skillName ?? o.paiPackDir}: ${o.reason ?? "(no detail)"}`)
        .join("\n");
      throw new SomaCliError(
        `${formatted}\nsoma migrate pai — ${refusedOther.length} pack(s) failed with genuine errors:\n${detail}\n`,
        1,
      );
    }
    return formatted;
  }

  if (parsed.command === "adopt") {
    if (parsed.mode === "uninstall") {
      return formatClaudeUninstallResult(await uninstallSomaForClaudeCode(parsed.options));
    }
    if (parsed.mode === "plan") {
      return formatPlan(planSomaForClaudeCodeInstall(parsed.options));
    }
    return formatInstallResult(await installSomaForClaudeCode(parsed.options));
  }

  if (parsed.command === "daemon") {
    // Reserved CLI surface — `daemon` mode (long-lived Myelin
    // subscriber) is not yet implemented. The verb exists so that
    // CONTEXT.md's "Runtime modes" table maps onto the CLI surface
    // one-to-one (#54 AC). Implementation lands in a follow-up
    // issue.
    throw new SomaCliError("soma daemon is not yet implemented (placeholder reserves the runtime mode).", 1);
  }

  if (parsed.command === "export") {
    return formatExportResult(await runExport(parsed));
  }

  if (parsed.command === "uninstall") {
    return runUninstall(parsed);
  }

  if (parsed.command === "reproject" || parsed.command === "upgrade") {
    // Both verbs reuse the install code path: reproject re-emits the
    // projection; upgrade is reproject + future migration work
    // (#54: migration content is a follow-up). They always apply —
    // unlike `install`, the principal opted into the verb explicitly.
    return formatInstallResult(await runInstall(parsed.substrate, parsed.options));
  }

  if (!parsed.apply) {
    return formatPlan(planInstall(parsed.substrate, parsed.options));
  }

  return formatInstallResult(await runInstall(parsed.substrate, parsed.options));
}

function planInstall(substrate: InstallSubstrate, options: SomaInstallOptions): SomaInstallPlan {
  switch (substrate) {
    case "codex":
      return planSomaForCodexInstall(options);
    case "pi-dev":
      return planSomaForPiDevInstall(options);
    case "claude-code":
      return planSomaForClaudeCodeInstall(options);
  }
}

async function runInstall(substrate: InstallSubstrate, options: SomaInstallOptions): Promise<SomaInstallResult> {
  switch (substrate) {
    case "codex":
      return installSomaForCodex(options);
    case "pi-dev":
      return installSomaForPiDev(options);
    case "claude-code":
      return installSomaForClaudeCode(options);
  }
}

async function runUninstall(parsed: ParsedUninstallArgs): Promise<string> {
  if (parsed.substrate === "claude-code") {
    return formatClaudeUninstallResult(await uninstallSomaForClaudeCode(parsed.options));
  }
  // Codex and Pi.dev uninstallers are not yet implemented. The CLI
  // surface is reserved so CONTEXT.md's "Lifecycle verbs" table maps
  // one-to-one (#54 AC); functional removal lands in a follow-up.
  throw new SomaCliError(
    `soma uninstall ${parsed.substrate} is not yet implemented (claude-code is currently the only functional uninstaller; codex and pi-dev removal land in a follow-up).`,
    1,
  );
}

async function runExport(parsed: ParsedExportArgs): Promise<{ files: { path: string; content: string }[]; out?: string }> {
  const projection = await buildExportProjection(parsed.substrate, parsed.options);
  if (!parsed.out) {
    return { files: projection };
  }
  const outRoot = resolveAbsolute(parsed.out);
  // Compute realpath(--out) once per export run instead of per file
  // (sage r2 performance finding on #54). The symlink guard inside
  // `writeProjectionExportFile` reuses this cached value.
  const { mkdir, realpath } = await import("node:fs/promises");
  await mkdir(outRoot, { recursive: true });
  const realOutRoot = await realpath(outRoot);
  // Parallel writes — independent files, order preserved by mapping
  // over the original projection array (sage r1 performance finding
  // on #54).
  const written = await Promise.all(
    projection.map(async (file) => {
      const absolute = await writeProjectionExportFile(outRoot, realOutRoot, file.path, file.content);
      return { path: absolute, content: file.content };
    }),
  );
  return { files: written, out: outRoot };
}

async function buildExportProjection(
  substrate: InstallSubstrate,
  options: SomaInstallOptions,
): Promise<{ path: string; content: string }[]> {
  const projectionInput = await loadSomaHome(options.somaHome ?? defaultSomaHomePath(options.homeDir));
  const projectionOptions = {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrateHome: options.substrateHome,
  };
  const files = projectionFilesFor(substrate, projectionInput, projectionOptions);
  return files.map((f) => ({ path: f.path, content: f.content }));
}

function projectionFilesFor(
  substrate: InstallSubstrate,
  input: ProjectionInput,
  options: { homeDir?: string; somaHome?: string; substrateHome?: string },
): readonly { path: string; content: string }[] {
  switch (substrate) {
    case "codex":
      return buildCodexHomeProjection(input, options).bundle.files;
    case "pi-dev":
      return buildPiDevHomeProjection(input, options).bundle.files;
    case "claude-code":
      return buildClaudeCodeHomeProjection(input, options).bundle.files;
  }
}

function defaultSomaHomePath(homeDir?: string): string {
  const base = homeDir ?? process.env.HOME ?? process.cwd();
  return resolveJoin(base, ".soma");
}

function resolveAbsolute(path: string): string {
  return path.startsWith("/") ? path : resolveJoin(process.cwd(), path);
}

async function writeProjectionExportFile(
  outRoot: string,
  realOutRoot: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const { mkdir, realpath, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  // Lexical guard: reject paths that try to escape --out via
  // absolute paths or `..` segments before we touch the disk.
  const safeRelative = relativePath.replace(/^[/\\]+/, "");
  const absolute = path.resolve(outRoot, safeRelative);
  const resolvedOutRoot = path.resolve(outRoot);
  if (absolute !== resolvedOutRoot && !absolute.startsWith(resolvedOutRoot + path.sep)) {
    throw new SomaCliError(`soma export refused to write outside --out (path: ${relativePath}).`, 2);
  }
  // Symlink guard (sage r1 security finding on #54): after mkdir,
  // resolve the real path of the parent directory and verify it is
  // still under --out's real path. A symlink such as
  // `<out>/rules -> ~/.ssh` would let writeFile land outside --out
  // even though the lexical check passed. `realOutRoot` is computed
  // once by `runExport` (sage r2 performance finding).
  const parent = path.dirname(absolute);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  if (realParent !== realOutRoot && !realParent.startsWith(realOutRoot + path.sep)) {
    throw new SomaCliError(
      `soma export refused to follow a symlink that escapes --out (path: ${relativePath}).`,
      2,
    );
  }
  await writeFile(absolute, content, "utf8");
  return absolute;
}

function formatExportResult(result: { files: { path: string; content: string }[]; out?: string }): string {
  if (result.out) {
    return [
      "Soma export applied",
      `out: ${result.out}`,
      "",
      "Files:",
      ...result.files.map((f) => `- ${f.path}`),
    ].join("\n");
  }
  // No --out → emit JSON to stdout for downstream tools / diffing.
  return JSON.stringify(result.files, null, 2);
}

if (import.meta.main) {
  try {
    console.log(await runSomaCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof SomaCliError ? error.exitCode : 1;
  }
}
