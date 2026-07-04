import {
  auditMemory,
  consolidateMemory,
  promoteAlgorithmRunMemory,
  rebuildMemoryIndex,
  recallMemory,
  runMemoryBackfill,
  searchSomaMemory,
  verifyMemoryNote,
  writeMemoryAction,
  writeMemoryNote,
  writeSessionDigest,
} from "../index";
import { WRITABLE_NOTE_TYPES, isWritableNoteType } from "../memory-write";
import { SOMA_MEMORY_ACTION_APPROVALS } from "../types";
import type {
  SomaMemoryActionApproval,
  SomaMemoryActionOptions,
  SomaMemoryActionResult,
  SomaMemoryAuditOptions,
  SomaMemoryAuditResult,
  SomaMemoryBackfillOptions,
  SomaMemoryBackfillResult,
  SomaMemoryConsolidateOptions,
  SomaMemoryConsolidateResult,
  SomaMemoryDigestOptions,
  SomaMemoryDigestResult,
  SomaMemoryIndexResult,
  SomaMemoryNoteType,
  SomaMemoryPromotionOptions,
  SomaMemoryPromotionResult,
  SomaMemoryPromotionStore,
  SomaMemoryRecallOptions,
  SomaMemoryRecallResult,
  SomaMemorySearchOptions,
  SomaMemorySearchResult,
  SomaMemoryVerifyOptions,
  SomaMemoryVerifyResult,
  SomaMemoryWriteOptions,
  SomaMemoryWriteResult,
  SomaMemoryWriteTrigger,
  SubstrateId,
} from "../types";

/** Parsed `soma memory reindex` — home overrides only; rebuild uses the real clock. */
interface MemoryReindexOptions {
  homeDir?: string;
  somaHome?: string;
}
import { readOption } from "./parse-utils";
import { parseSubstrate } from "./substrate";
import { SomaCliError } from "./errors";

export interface ParsedMemorySearchArgs {
  command: "memory";
  action: "search";
  options: SomaMemorySearchOptions;
}

export interface ParsedMemoryRecallArgs {
  command: "memory";
  action: "recall";
  options: SomaMemoryRecallOptions;
}

export interface ParsedMemoryPromoteArgs {
  command: "memory";
  action: "promote";
  options: SomaMemoryPromotionOptions;
}

export interface ParsedMemoryWriteArgs {
  command: "memory";
  action: "write";
  options: SomaMemoryWriteOptions;
}

export interface ParsedMemoryVerifyArgs {
  command: "memory";
  action: "verify";
  options: SomaMemoryVerifyOptions;
}

export interface ParsedMemoryReindexArgs {
  command: "memory";
  action: "reindex";
  options: MemoryReindexOptions;
}

export interface ParsedMemoryDigestArgs {
  command: "memory";
  action: "digest";
  options: SomaMemoryDigestOptions;
}

export interface ParsedMemoryActionArgs {
  command: "memory";
  action: "action";
  options: SomaMemoryActionOptions;
}

export interface ParsedMemoryConsolidateArgs {
  command: "memory";
  action: "consolidate";
  options: SomaMemoryConsolidateOptions;
}

export interface ParsedMemoryAuditArgs {
  command: "memory";
  action: "audit";
  options: SomaMemoryAuditOptions;
}

export interface ParsedMemoryBackfillArgs {
  command: "memory";
  action: "backfill";
  options: SomaMemoryBackfillOptions;
}

export type ParsedMemoryArgs =
  | ParsedMemorySearchArgs
  | ParsedMemoryRecallArgs
  | ParsedMemoryPromoteArgs
  | ParsedMemoryWriteArgs
  | ParsedMemoryVerifyArgs
  | ParsedMemoryReindexArgs
  | ParsedMemoryDigestArgs
  | ParsedMemoryActionArgs
  | ParsedMemoryConsolidateArgs
  | ParsedMemoryAuditArgs
  | ParsedMemoryBackfillArgs;

const MEMORY_ACTIONS = ["search", "recall", "promote", "write", "verify", "reindex", "digest", "action", "consolidate", "audit", "backfill"] as const;
type MemoryAction = (typeof MEMORY_ACTIONS)[number];

export const MEMORY_COMMAND_HELP: { usage: string; subcommands: Record<MemoryAction, string> } = {
  usage: "Usage: soma memory <search|recall|promote|write|verify|reindex|digest|action|consolidate|audit|backfill> ...",
  subcommands: {
    search: "Usage: soma memory search [query] [--query <text>] [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]",
    recall:
      "Usage: soma memory recall <query> [--query <text>] [--limit <n>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Note-aware retrieval over durable notes: term-scored whole-file matches (limit 3) + 1-hop links, " +
      "superseded notes excluded, each result carrying a verification banner. Read-only.",
    promote: "Usage: soma memory promote --from-run <run-id> --store <learning|knowledge|relationship|work> --title <text> [--lesson <text>] [--applies-when <text>]",
    write:
      "Usage: soma memory write --trigger <principal-correction|import> --body <text> " +
      "(create: --id <slug> --type <semantic|procedural> [--force]) " +
      "(--merge <id> | --supersede <id>) " +
      "[--principal-authority] [--project <key>] [--source-of-truth <ref>] [--links a,b] " +
      "[--recall-trigger <text>] [--review <text>] " +
      "[--provenance <import|tool:name>] [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Trust is DERIVED from --trigger; there is no --trust flag. principal-correction requires " +
      "--principal-authority. (The consolidation trigger, which mints assistant trust, is an internal " +
      "M6 SDK path and is not accepted on the public CLI.)",
    verify:
      "Usage: soma memory verify <id> [--id <id>] [--principal-authority] [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Verifying a principal-trust note requires --principal-authority (assistant-trust notes are an internal SDK path).",
    reindex:
      "Usage: soma memory reindex [--home-dir <dir>] [--soma-home <dir>]. " +
      "Rebuild memory/INDEX.md from note frontmatter (earned-inclusion ladder, retention-score budget); " +
      "ages are computed against the current date, so 'verified Nd ago' advances day to day. Quarantined notes never appear.",
    digest:
      "Usage: soma memory digest --session <id> --body <text> [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Write the ONE assistant-authored session digest (8–15 non-empty lines). A second digest for the same session no-ops with an event. " +
      "(The deterministic SessionEnd fallback is a Claude Code adapter concern — see `soma lifecycle session-end`.)",
    action:
      "Usage: soma memory action --slug <slug> --planned-action <text> --approval <proposed|approved|rejected|auto> " +
      "[--outcome <text>] [--session <id>] [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Log one planned-action→approval→outcome entry (id YYYYMMDD-<slug>; collision refused).",
    consolidate:
      "Usage: soma memory consolidate [--dry-run] [--gc-state] [--substrate <s>] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Deterministic maintenance: prune aged episodic → digest+archive, mark aged-unverified semantic review:stale, " +
      "list lexically-similar note pairs (near-duplicates for review; no semantic check), rebuild INDEX. --gc-state additionally DELETES current-work state >7d (explicit override). " +
      "--dry-run prints the plan without touching anything.",
    audit:
      "Usage: soma memory audit [--home-dir <dir>] [--soma-home <dir>]. " +
      "Deterministic, read-only health check of the memory tree (no LLM): schema validity, INDEX freshness, " +
      "digest coverage, orphaned archive notes, event/note ratio. EXITS NON-ZERO on any health-gating failure: an abnormal note root (root-integrity), a schema-invalid note, or a stale INDEX.",
    backfill:
      "Usage: soma memory backfill [--from <dir>] [--type <semantic|procedural>] [--project <key>] [--dry-run] [--home-dir <dir>] [--soma-home <dir>]. " +
      "Bulk-import legacy free-form markdown (default source: <somaHome>/memory category dirs) into schema-valid notes via the import trigger. " +
      "Every note lands at QUARANTINED trust (recall-discoverable with a ⚠ banner, excluded from INDEX until verified); category dir → type is mapped (LEARNING→procedural, KNOWLEDGE→semantic) unless --type forces one. " +
      "Deterministic, idempotent (SHA manifest); --dry-run prints the plan without writing.",
  },
};

function isMemoryAction(value: string): value is MemoryAction {
  return (MEMORY_ACTIONS as readonly string[]).includes(value);
}

export function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
  const [command, action, ...rest] = args;

  if (command !== "memory" || !isMemoryAction(action)) {
    throw new Error(MEMORY_COMMAND_HELP.usage);
  }

  switch (action) {
    case "search":
      return { command, action, options: parseMemorySearchArgs(rest) };
    case "recall":
      return { command, action, options: parseMemoryRecallArgs(rest) };
    case "promote":
      return { command, action, options: parseMemoryPromoteArgs(rest) };
    case "write":
      return { command, action, options: parseMemoryWriteArgs(rest) };
    case "verify":
      return { command, action, options: parseMemoryVerifyArgs(rest) };
    case "reindex":
      return { command, action, options: parseMemoryReindexArgs(rest) };
    case "digest":
      return { command, action, options: parseMemoryDigestArgs(rest) };
    case "action":
      return { command, action, options: parseMemoryActionArgs(rest) };
    case "consolidate":
      return { command, action, options: parseMemoryConsolidateArgs(rest) };
    case "audit":
      return { command, action, options: parseMemoryAuditArgs(rest) };
    case "backfill":
      return { command, action, options: parseMemoryBackfillArgs(rest) };
  }
}

function parseMemoryBackfillArgs(args: string[]): SomaMemoryBackfillOptions {
  const options: SomaMemoryBackfillOptions = {};
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
      case "--from":
        options.from = readOption(args, index, arg);
        index += 1;
        break;
      case "--type": {
        const value = readOption(args, index, arg);
        if (value !== "semantic" && value !== "procedural") {
          throw new Error(MEMORY_COMMAND_HELP.subcommands.backfill);
        }
        options.type = value;
        index += 1;
        break;
      }
      case "--project":
        options.project = readOption(args, index, arg);
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(MEMORY_COMMAND_HELP.subcommands.backfill);
    }
  }
  return options;
}

function parseMemoryAuditArgs(args: string[]): SomaMemoryAuditOptions {
  // Audit takes ONLY home overrides — no --substrate (it has no substrate behavior;
  // accepting it as a no-op is confusing for a health gate).
  const options: SomaMemoryAuditOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--home-dir") {
      options.homeDir = readOption(args, index, arg);
      index += 1;
    } else if (arg === "--soma-home") {
      options.somaHome = readOption(args, index, arg);
      index += 1;
    } else {
      throw new Error(MEMORY_COMMAND_HELP.subcommands.audit);
    }
  }
  return options;
}

function parseMemoryConsolidateArgs(args: string[]): SomaMemoryConsolidateOptions {
  const options: SomaMemoryConsolidateOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const consumed = consumeSharedMemoryOption(args, index, arg, options);
    if (consumed > 0) {
      index += consumed;
      continue;
    }
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--gc-state":
        options.gcState = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

/**
 * Consume a shared home/substrate option (`--home-dir`, `--soma-home`,
 * `--substrate`) into `options`. Returns the number of EXTRA argv entries consumed
 * (the option's value) — so the caller advances by exactly that, never over-skipping
 * a following option — or 0 if `arg` was not a shared option. All shared options
 * take a value today; returning the count keeps that from being a hidden assumption.
 */
function consumeSharedMemoryOption(
  args: string[],
  index: number,
  arg: string,
  options: { homeDir?: string; somaHome?: string; substrate?: SubstrateId },
): number {
  switch (arg) {
    case "--home-dir":
      options.homeDir = readOption(args, index, arg);
      return 1;
    case "--soma-home":
      options.somaHome = readOption(args, index, arg);
      return 1;
    case "--substrate":
      options.substrate = parseSubstrate(readOption(args, index, arg));
      return 1;
    default:
      return 0;
  }
}

function parseMemoryDigestArgs(args: string[]): SomaMemoryDigestOptions {
  const options: Partial<SomaMemoryDigestOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const consumed = consumeSharedMemoryOption(args, index, arg, options);
    if (consumed > 0) {
      index += consumed;
      continue;
    }
    switch (arg) {
      case "--session":
        options.sessionId = readOption(args, index, arg);
        index += 1;
        break;
      case "--body":
        options.body = readOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  const missing: string[] = [];
  if (!options.sessionId) missing.push("--session");
  if (options.body === undefined) missing.push("--body");
  if (missing.length > 0) {
    throw new Error(`soma memory digest is missing required option(s): ${missing.join(", ")}.`);
  }
  return options as SomaMemoryDigestOptions;
}

function parseActionApproval(value: string): SomaMemoryActionApproval {
  if ((SOMA_MEMORY_ACTION_APPROVALS as readonly string[]).includes(value)) {
    return value as SomaMemoryActionApproval;
  }
  throw new Error(`--approval must be one of ${SOMA_MEMORY_ACTION_APPROVALS.join(", ")}.`);
}

function parseMemoryActionArgs(args: string[]): SomaMemoryActionOptions {
  const options: Partial<SomaMemoryActionOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const consumed = consumeSharedMemoryOption(args, index, arg, options);
    if (consumed > 0) {
      index += consumed;
      continue;
    }
    switch (arg) {
      case "--slug":
        options.slug = readOption(args, index, arg);
        index += 1;
        break;
      case "--session":
        options.sessionId = readOption(args, index, arg);
        index += 1;
        break;
      case "--planned-action":
        options.plannedAction = readOption(args, index, arg);
        index += 1;
        break;
      case "--approval":
        options.approval = parseActionApproval(readOption(args, index, arg));
        index += 1;
        break;
      case "--outcome":
        options.outcome = readOption(args, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  const missing: string[] = [];
  if (!options.slug) missing.push("--slug");
  if (!options.plannedAction) missing.push("--planned-action");
  if (!options.approval) missing.push("--approval");
  if (missing.length > 0) {
    throw new Error(`soma memory action is missing required option(s): ${missing.join(", ")}.`);
  }
  return options as SomaMemoryActionOptions;
}

function parseMemoryReindexArgs(args: string[]): MemoryReindexOptions {
  const options: MemoryReindexOptions = {};
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
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

/**
 * Parsed shape shared by the two query-style memory commands (`search`, `recall`):
 * both take a single query (positional or `--query`), an optional positive-integer
 * `--limit`, and the standard home overrides. One parser so a future flag change
 * can't drift the two apart (and so the `--limit` integer contract is enforced in
 * exactly one place).
 */
interface QueryCommandArgs {
  homeDir?: string;
  somaHome?: string;
  query: string;
  limit?: number;
}

function parseQueryCommandArgs(args: string[], commandLabel: string): QueryCommandArgs {
  const options: Partial<QueryCommandArgs> = {};
  let positionalQuery: string | undefined;

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
      case "--limit": {
        // Strict integer: Number.parseInt would silently accept "2.5"→2 and
        // "1e2"→1, contradicting the positive-integer contract the API also
        // enforces. Number(...) rejects any non-numeric-integer spelling.
        const raw = readOption(args, index, arg);
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("--limit must be a positive integer.");
        }
        options.limit = value;
        index += 1;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (positionalQuery !== undefined) {
          throw new Error(`soma memory ${commandLabel} accepts only one positional query; unexpected argument: ${arg}`);
        }
        positionalQuery = arg;
    }
  }

  options.query ??= positionalQuery;

  if (!options.query) {
    throw new Error(`soma memory ${commandLabel} needs a query; pass it as the first argument or --query <text>.`);
  }

  return options as QueryCommandArgs;
}

function parseMemorySearchArgs(args: string[]): SomaMemorySearchOptions {
  return parseQueryCommandArgs(args, "search");
}

function parseMemoryRecallArgs(args: string[]): SomaMemoryRecallOptions {
  return parseQueryCommandArgs(args, "recall");
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

function parseMemoryPromotionStore(value: string): SomaMemoryPromotionStore {
  if (value === "learning" || value === "knowledge" || value === "relationship" || value === "work") {
    return value;
  }

  throw new Error("--store must be one of learning, knowledge, relationship, or work.");
}

function parseWriteTrigger(value: string): SomaMemoryWriteTrigger {
  // `consolidation` is a valid SDK trigger but not a public-CLI one — it needs
  // consolidationAuthority, which is SDK-only. Reject it here with a clear parse
  // error instead of letting it fail later inside the writer.
  if (value === "consolidation") {
    throw new Error("--trigger consolidation is an internal (M6) SDK path, not available on the public CLI.");
  }
  if (value === "principal-correction" || value === "import") {
    return value;
  }
  throw new Error(`--trigger must be principal-correction or import (consolidation is SDK-only).`);
}

function parseWriteType(value: string): SomaMemoryNoteType {
  if (!isWritableNoteType(value)) {
    throw new Error(`--type must be ${WRITABLE_NOTE_TYPES.join(" or ")} (episodic writes go through digest/action, M5).`);
  }
  return value;
}

function parseMemoryWriteArgs(args: string[]): SomaMemoryWriteOptions {
  const options: Partial<SomaMemoryWriteOptions> = {};
  let mergeTarget: string | undefined;
  let supersedeTarget: string | undefined;

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
      case "--trigger":
        options.trigger = parseWriteTrigger(readOption(args, index, arg));
        index += 1;
        break;
      case "--id":
        options.id = readOption(args, index, arg);
        index += 1;
        break;
      case "--type":
        options.type = parseWriteType(readOption(args, index, arg));
        index += 1;
        break;
      case "--body":
        options.body = readOption(args, index, arg);
        index += 1;
        break;
      case "--project":
        options.project = readOption(args, index, arg);
        index += 1;
        break;
      case "--source-of-truth":
        options.sourceOfTruth = readOption(args, index, arg);
        index += 1;
        break;
      case "--links":
        options.links = readOption(args, index, arg)
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        index += 1;
        break;
      case "--recall-trigger":
        // Maps to the note's `hook` frontmatter field (M0 schema). The
        // user-facing flag avoids the reserved `hook` term (CONTEXT.md).
        options.hook = readOption(args, index, arg);
        index += 1;
        break;
      case "--review":
        options.review = readOption(args, index, arg);
        index += 1;
        break;
      case "--provenance":
        options.provenance = readOption(args, index, arg);
        index += 1;
        break;
      case "--merge":
        mergeTarget = readOption(args, index, arg);
        index += 1;
        break;
      case "--supersede":
        supersedeTarget = readOption(args, index, arg);
        index += 1;
        break;
      case "--force":
        options.force = true;
        break;
      case "--principal-authority":
        options.principalAuthority = true;
        break;
      case "--trust":
        throw new Error(
          "soma memory write has no --trust flag: trust is derived from --trigger " +
            "(principal-correction→principal, import→quarantined, consolidation→assistant).",
        );
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (mergeTarget !== undefined && supersedeTarget !== undefined) {
    throw new Error("soma memory write accepts --merge or --supersede, not both.");
  }
  if (!options.trigger) {
    throw new Error("soma memory write needs --trigger <principal-correction|import>.");
  }
  if (options.body === undefined) {
    throw new Error("soma memory write needs --body <text>.");
  }

  if (mergeTarget !== undefined) {
    // merge edits an existing note in place — it takes neither a new id nor a
    // type. Reject them rather than silently ignoring (the target is --merge <id>).
    if (options.id !== undefined || options.type !== undefined) {
      throw new Error("soma memory write --merge takes neither --id nor --type; the target is --merge <id>.");
    }
    options.mode = "merge";
    options.targetId = mergeTarget;
  } else if (supersedeTarget !== undefined) {
    options.mode = "supersede";
    options.targetId = supersedeTarget;
  } else {
    options.mode = "create";
  }

  // create + supersede both mint a new note and need id + type.
  if (options.mode !== "merge") {
    const missing: string[] = [];
    if (!options.id) missing.push("--id");
    if (!options.type) missing.push("--type");
    if (missing.length > 0) {
      throw new Error(`soma memory ${options.mode} is missing required option(s): ${missing.join(", ")}.`);
    }
  }

  return options as SomaMemoryWriteOptions;
}

function parseMemoryVerifyArgs(args: string[]): SomaMemoryVerifyOptions {
  const options: Partial<SomaMemoryVerifyOptions> = {};
  let positionalId: string | undefined;

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
      case "--id":
        options.id = readOption(args, index, arg);
        index += 1;
        break;
      case "--principal-authority":
        options.principalAuthority = true;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (positionalId !== undefined) {
          throw new Error(`soma memory verify accepts only one positional id; unexpected argument: ${arg}`);
        }
        positionalId = arg;
    }
  }

  // Reject a conflicting positional + --id rather than silently preferring one —
  // verify is a mutating command, so an ignored id must not slip through.
  if (options.id !== undefined && positionalId !== undefined && options.id !== positionalId) {
    throw new Error(`soma memory verify got two different ids ("${positionalId}" and --id "${options.id}"); pass only one.`);
  }
  options.id ??= positionalId;
  if (!options.id) {
    throw new Error("soma memory verify needs a note id; pass it as the first argument or --id <id>.");
  }

  return options as SomaMemoryVerifyOptions;
}

export async function runMemoryCli(parsed: ParsedMemoryArgs): Promise<string> {
  switch (parsed.action) {
    case "promote":
      return formatMemoryPromotionResult(await promoteAlgorithmRunMemory(parsed.options));
    case "write":
      return formatMemoryWriteResult(await writeMemoryNote(parsed.options));
    case "verify":
      return formatMemoryVerifyResult(await verifyMemoryNote(parsed.options));
    case "search":
      return formatMemorySearchResult(await searchSomaMemory(parsed.options));
    case "recall":
      return formatMemoryRecallResult(await recallMemory(parsed.options));
    case "reindex":
      return formatMemoryReindexResult(await rebuildMemoryIndex(parsed.options));
    case "digest":
      return formatMemoryDigestResult(await writeSessionDigest(parsed.options));
    case "action":
      return formatMemoryActionResult(await writeMemoryAction(parsed.options));
    case "consolidate":
      return formatMemoryConsolidateResult(await consolidateMemory(parsed.options));
    case "audit": {
      const audit = await auditMemory(parsed.options);
      const report = formatMemoryAuditResult(audit);
      // A deterministic gate: an unhealthy tree (abnormal root, schema-invalid note, or stale INDEX)
      // exits NON-ZERO so the audit can fail CI / a pre-consolidation check. The full
      // report is carried on the error so it is still shown.
      if (!audit.healthy) throw new SomaCliError(report, 1);
      return report;
    }
    case "backfill": {
      const result = await runMemoryBackfill(parsed.options);
      const report = formatMemoryBackfillResult(result);
      // A non-dry-run with per-file write errors exits NON-ZERO so a scripted
      // backfill surfaces partial failure (the full account is on the error).
      if (!result.dryRun && result.errorCount > 0) throw new SomaCliError(report, 1);
      return report;
    }
  }
}

function formatMemoryBackfillResult(result: SomaMemoryBackfillResult): string {
  if (result.dryRun) {
    const lines = [
      `Soma memory backfill (dry-run — nothing changed) from ${result.from}`,
      `would import ${result.entries.length} file(s):`,
      ...result.entries.map((e) => `  ${e.relativePath} → ${e.type}/${e.noteId}.md (created ${e.created})`),
    ];
    if (result.entries.length === 0) lines.push("  (no eligible source files found)");
    return lines.join("\n");
  }
  const lines = [
    `Soma memory backfill from ${result.from}`,
    `written: ${result.writtenCount} · skipped (already imported): ${result.skippedManifestCount} · ` +
      `skipped (duplicate): ${result.skippedDuplicateCount} · errors: ${result.errorCount}`,
    `manifest: ${result.manifestPath}`,
  ];
  type BackfillEntry = SomaMemoryBackfillResult["entries"][number];
  const appendSection = (
    status: BackfillEntry["status"],
    heading: string,
    format: (e: BackfillEntry) => string,
  ): void => {
    const matched = result.entries.filter((e) => e.status === status);
    if (matched.length === 0) return;
    lines.push(heading);
    for (const e of matched) lines.push(format(e));
  };
  appendSection(
    "written",
    "imported (quarantined — recall-discoverable, elevate via verify to reach INDEX):",
    (e) => `  ${e.relativePath} → ${e.type}/${e.noteId}.md`,
  );
  appendSection("skipped-duplicate", "skipped as duplicates of existing notes:", (e) => `  ${e.relativePath}: ${e.detail ?? ""}`);
  appendSection("error", "errors:", (e) => `  ${e.relativePath}: ${e.detail ?? ""}`);
  return lines.join("\n");
}

function formatMemoryAuditResult(result: SomaMemoryAuditResult): string {
  const lines = [
    result.healthy ? "Soma memory audit: HEALTHY" : "Soma memory audit: UNHEALTHY",
    ...result.probes.map((p) => `  [${p.ok ? "ok" : "FAIL"}] ${p.name}: ${p.detail}`),
  ];
  if (result.invalidNotes.length > 0) {
    lines.push("schema-invalid notes:");
    for (const p of result.invalidNotes) lines.push(`  - ${p}`);
  }
  if (result.orphanedArchive.length > 0) {
    lines.push("archived notes missing from a digest:");
    for (const p of result.orphanedArchive) lines.push(`  - ${p}`);
  }
  return lines.join("\n");
}

function formatConsolidateIndexLine(result: SomaMemoryConsolidateResult, mutated: boolean): string {
  // INDEX is rebuilt only when something actually mutated (archive/stale/GC).
  if (!mutated) return `index: unchanged (no mutations${result.dryRun ? " planned" : ""})`;
  return result.dryRun ? `index: would rebuild ${result.indexPath}` : `index: rebuilt ${result.indexPath}`;
}

function formatMemoryConsolidateResult(result: SomaMemoryConsolidateResult): string {
  const indexLine = formatConsolidateIndexLine(result, result.mutated);
  const lines = [
    result.dryRun ? "Soma memory consolidate (dry-run — nothing changed)" : "Soma memory consolidate",
    `archived: ${result.archived.length} aged episodic note(s)`,
    ...result.archived.map((a) => `  - ${a.from} → ${a.to} (${a.reason})`),
    `digests: ${result.digestsWritten.length} monthly file(s)`,
    `marked review:stale: ${result.markedStale.length} semantic note(s)`,
    ...result.markedStale.map((p) => `  - ${p}`),
    `state GC'd: ${result.stateGced.length} current-work file(s)`,
    ...result.stateGced.map((p) => `  - ${p}`),
    `similar pairs listed: ${result.similarPairs.length} (lexical near-duplicates for review; no semantic check)`,
    ...result.similarPairs.map((c) => `  - ${c.a} ~ ${c.b} (jaccard ${c.score.toFixed(2)})`),
    indexLine,
  ];
  if (result.unreadable.length > 0) {
    lines.push(`⚠ ${result.unreadable.length} unreadable note file(s) — skipped, surface for the audit:`);
    for (const p of result.unreadable) lines.push(`  - ${p}`);
  }
  return lines.join("\n");
}

function formatMemoryDigestResult(result: SomaMemoryDigestResult): string {
  return [
    result.created ? "Soma memory digest written" : "Soma memory digest already exists (no-op)",
    `id: ${result.note.id}`,
    `path: ${result.path}`,
    `event: ${result.event.id}`,
  ].join("\n");
}

function formatMemoryActionResult(result: SomaMemoryActionResult): string {
  return [
    "Soma memory action logged",
    `id: ${result.note.id}`,
    `trust: ${result.note.trust}`,
    `path: ${result.path}`,
    `event: ${result.event.id}`,
  ].join("\n");
}

function formatMemoryReindexResult(result: SomaMemoryIndexResult): string {
  const lines = [
    "Soma memory reindex",
    `path: ${result.path}`,
    `rendered: ${result.rendered} line(s)`,
    `admitted: ${result.admitted} (earned a line)`,
    `shed: ${result.shed} (over budget)`,
    `excluded: ${result.excluded} (quarantined / superseded / not yet earned)`,
  ];
  if (result.unreadable.length > 0) {
    lines.push(`⚠ ${result.unreadable.length} corpus file(s) unreadable — index was partial:`);
    for (const path of result.unreadable) lines.push(`  - ${path}`);
  }
  return lines.join("\n");
}

function formatMemoryWriteResult(result: SomaMemoryWriteResult): string {
  const lines = [
    `Soma memory ${result.mode}`,
    `id: ${result.note.id}`,
    `type: ${result.note.type}`,
    `trust: ${result.note.trust}`,
    `provenance: ${result.note.provenance}`,
    `path: ${result.path}`,
  ];
  if (result.supersededId) lines.push(`superseded: ${result.supersededId} (valid_until set)`);
  lines.push(`event: ${result.event.id}`);
  return lines.join("\n");
}

function formatMemoryVerifyResult(result: SomaMemoryVerifyResult): string {
  return [
    "Soma memory verify",
    `id: ${result.note.id}`,
    `last_verified: ${result.note.last_verified}`,
    `resurface_count: ${result.note.resurface_count}`,
    `path: ${result.path}`,
    `event: ${result.event.id}`,
  ].join("\n");
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

/**
 * Strip terminal control sequences from note-authored text before it reaches the
 * terminal. Memory notes can hold imported / quarantined tool/web content, and a
 * malicious note body or `source_of_truth` could smuggle ANSI CSI / OSC escapes
 * that spoof output, rewrite earlier lines, or poke the terminal's title and
 * clipboard state when the principal runs `soma memory recall`. Removes:
 *   - ESC-introduced sequences (CSI `ESC [ … final`, OSC `ESC ] … BEL|ST`, and
 *     any other `ESC <byte>` form), plus the C1 CSI byte 0x9b, and
 *   - remaining C0/C1 control chars, keeping only tab and newline (the layout
 *     this formatter itself relies on).
 * Deliberately conservative: it discards control bytes rather than escaping them,
 * since recall output is human-facing text, not a round-trippable channel.
 */
function sanitizeForTerminal(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC … terminated by BEL or ST
    .replace(/\x1b[@-_][0-?]*[ -/]*[@-~]/g, "")         // CSI and other two-byte ESC sequences
    .replace(/\x1b./g, "")                                // any stray ESC + following byte
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ""); // C0/C1 controls except \t (\x09) and \n (\x0a)
}

/**
 * Render one recalled note to its output lines (heading + banner + body). Every
 * note-derived field is sanitized here — the id/linkedFrom are slug-validated by
 * the parser (they cannot hold control chars in a note that parsed at all), but
 * sanitizing them anyway keeps every note-derived field on one rendering path, so
 * no future edit can reintroduce a raw one.
 */
function formatRecalledMatch(match: SomaMemoryRecallResult["matches"][number]): string[] {
  const id = sanitizeForTerminal(match.id);
  const heading =
    match.via === "match"
      ? `━━ ${id} [${match.type}] · ${match.score} term${match.score === 1 ? "" : "s"} matched`
      : `━━ ${id} [${match.type}] · via link from ${sanitizeForTerminal(match.linkedFrom ?? "")}`;
  return [heading, sanitizeForTerminal(match.banner), "", sanitizeForTerminal(match.note.body), ""];
}

function formatMemoryRecallResult(result: SomaMemoryRecallResult): string {
  const lines = [
    "Soma memory recall",
    // The query is principal-supplied and the note body/banner can carry imported
    // or quarantined tool/web content — never render any of it to the terminal raw
    // (ANSI/OSC escapes could spoof output or touch clipboard/title state).
    `query: ${sanitizeForTerminal(result.query)}`,
    `terms: ${result.terms.length > 0 ? result.terms.map(sanitizeForTerminal).join(", ") : "(none — needs a 3+char term)"}`,
    // somaHome is derived from a caller-supplied --soma-home; a path with ANSI/OSC
    // bytes must not reach the terminal raw either.
    `somaHome: ${sanitizeForTerminal(result.somaHome)}`,
    "",
  ];

  if (result.matches.length === 0) {
    lines.push("No active notes matched.");
  } else {
    for (const match of result.matches) lines.push(...formatRecalledMatch(match));
  }

  // Surface both blind spots explicitly — recall never hides an unresolved link or
  // an unreadable corpus file behind a clean-looking result.
  if (result.unresolvedLinks.length > 0) {
    const rendered = result.unresolvedLinks.map(sanitizeForTerminal).join(", ");
    lines.push(`Unresolved 1-hop links (missing or superseded): ${rendered}`);
  }
  if (result.unreadable.length > 0) {
    lines.push(`⚠ ${result.unreadable.length} corpus file(s) unreadable — recall was partial:`);
    for (const path of result.unreadable) lines.push(`  - ${sanitizeForTerminal(path)}`);
  }

  return lines.join("\n").trimEnd();
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
