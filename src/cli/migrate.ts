import {
  migratePai,
  planPaiMigration,
  type PaiMigrationOptions,
  type PaiMigrationPlan,
  type PaiMigrationResult,
} from "../index";
import { formatPackOutcomeLines } from "../pai-migration";
import {
  countOutcomesWithMissingDependencies,
  migrateClaudeSkills,
  planClaudeSkillsMigration,
  readClaudeSkillsMigrationStatus,
  resolveOutcomeReason,
  REASON_PREFIX_HOOK_BINDING,
  REASON_PREFIX_SLASH_COMMAND,
} from "../claude-skills-migrator";
import { createProgressEmitter } from "../claude-skills-progress";
import type {
  ClaudeSkillOutcome,
  ClaudeSkillsMigrationManifest,
  ClaudeSkillsMigrationOptions,
  ClaudeSkillsMigrationPlan,
  ClaudeSkillsMigrationResult,
  ClaudeSkillsSmokeSubstrate,
  PaiPackOutcome,
  RewriteDescriptionsAgent,
} from "../types";
import { SomaCliError } from "./errors";
import { warnDeprecatedSubstrateFlag } from "./deprecated-flags";
import { readOption } from "./parse-utils";

export const MIGRATE_PAI_USAGE =
  "Usage: soma migrate pai [--dry-run] [--apply] [--status] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>] [--pai-install <dir>] [--pai-repo <root>] [--pai-source-dir <dir>] [--pai-packs-dir <dir>] [--pai-pack-dir <dir>] [--emit-resolution <path>] [--resolution <path>] [--skip-memory] [--skip-skills] [--skip-docs] [--overwrite-reserved] [--include-unrecognized] [--verbose]";

// #115 — `soma migrate claude-skills`. Phase 1 verb + classifier
// (#116) ships the flat-tree import; Phase 2 adds `--smoke
// <substrate>` (repeatable) for per-skill static-shape verify
// against the requested target substrate's projection (codex, pi-dev,
// or `all` which expands to both). `--smoke` is optional and absent
// from the usage line below for non-Phase-2 callers — they keep the
// Phase-1 surface intact.
export const MIGRATE_CLAUDE_SKILLS_USAGE =
  "Usage: soma migrate claude-skills --from <skills-dir> [--dry-run] [--apply] [--status] [--home-dir <dir>] [--soma-home <dir>] [--include-claude-specific] [--smoke <codex|pi-dev|all>] [--rewrite-descriptions <claude|codex|pi|none|auto>] [--quiet] [--verbose]";

export const MIGRATE_COMMAND_HELP: { usage: string; subcommands: Record<"pai" | "claude-skills", string> } = {
  usage: `${MIGRATE_PAI_USAGE}\n       ${MIGRATE_CLAUDE_SKILLS_USAGE.slice("Usage: ".length)}`,
  subcommands: {
    pai: MIGRATE_PAI_USAGE,
    "claude-skills": MIGRATE_CLAUDE_SKILLS_USAGE,
  },
};

export interface ParsedMigratePaiArgs {
  command: "migrate";
  source: "pai";
  mode: "plan" | "apply" | "status";
  options: PaiMigrationOptions;
  /** #106 — when true, plan/apply formatter prints inline file lists. Default false. */
  verbose: boolean;
}

/**
 * #115 — `soma migrate claude-skills` parsed args. Sibling to
 * `ParsedMigratePaiArgs` (PAI path); a separate type because the
 * option sets do not overlap and merging them would force every
 * dispatch site to discriminate on `source` AND options shape. Keeping
 * them separate keeps the type narrowing trivial.
 */
export interface ParsedMigrateClaudeSkillsArgs {
  command: "migrate";
  source: "claude-skills";
  mode: "plan" | "apply" | "status";
  options: ClaudeSkillsMigrationOptions;
  // #125 — when true, the CLI suppresses stderr progress (passes a
  // quiet emitter to the migrator). The Timing block on stdout is
  // unaffected — it's part of the summary, not stderr noise.
  quiet?: boolean;
  /** #139 — preserve append-only per-skill stderr rows for debugging. */
  verbose?: boolean;
}

export type ParsedMigrateArgs = ParsedMigratePaiArgs | ParsedMigrateClaudeSkillsArgs;

function commandUsage(action?: string): string {
  return (isMigrateSource(action) ? MIGRATE_COMMAND_HELP.subcommands[action] : undefined) ?? MIGRATE_COMMAND_HELP.usage;
}

function isMigrateSource(action: string | undefined): action is keyof typeof MIGRATE_COMMAND_HELP.subcommands {
  return action === "pai" || action === "claude-skills";
}

export function parseMigrateArgs(args: string[]): ParsedMigrateArgs {
  const [command, source] = args;
  if (command !== "migrate") {
    throw new Error(commandUsage());
  }
  // #115 — second migration path. Routed early so the existing
  // pai-only parser body stays untouched.
  if (source === "claude-skills") {
    return parseMigrateClaudeSkillsArgs(args);
  }
  if (source !== "pai") {
    throw new Error(commandUsage(source));
  }
  return parseMigratePaiArgs(args);
}

function parseMigratePaiArgs(args: string[]): ParsedMigratePaiArgs {
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
      case "--emit-resolution":
        options.emitResolutionPath = readOption(rest, index, arg);
        index += 1;
        break;
      case "--resolution":
        options.resolutionPath = readOption(rest, index, arg);
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
      case "--verbose":
        // #139 — force append-only per-skill stderr progress even
        // inside concurrent phases. Useful for diagnosing a specific
        // skill without changing stdout formatting.
        verbose = true;
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

  return { command: "migrate", source: "claude-skills", mode, options, quiet, verbose };
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

// #120/#174 — `--rewrite-descriptions <value>` enum gate. `auto` is
// the batch/non-interactive approval mode; the migrator resolves it
// to the default concrete provider at dispatch time.
const VALID_REWRITE_DESCRIPTIONS_AGENTS: readonly RewriteDescriptionsAgent[] = [
  "claude",
  "codex",
  "pi",
  "none",
  "auto",
];

function parseRewriteDescriptionsAgent(value: string): RewriteDescriptionsAgent {
  if ((VALID_REWRITE_DESCRIPTIONS_AGENTS as readonly string[]).includes(value)) {
    return value as RewriteDescriptionsAgent;
  }
  throw new Error(
    `Unknown --rewrite-descriptions agent: ${JSON.stringify(value)}. Allowed: ${VALID_REWRITE_DESCRIPTIONS_AGENTS.join(", ")}.`,
  );
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
      `${counts.refusedDescriptionLimit} skill(s) refused-description-limit — re-run with --rewrite-descriptions auto (or claude/codex/pi) to compress oversize descriptions via LLM.`,
    );
  }
  appendMissingDependencyFooter(lines, plan.outcomes);
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
      `${result.refusedDescriptionLimitCount} skill(s) refused-description-limit — re-run with --rewrite-descriptions auto (or claude/codex/pi) to compress oversize descriptions via LLM.`,
    );
  }
  appendMissingDependencyFooter(lines, result.outcomes);
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

function appendMissingDependencyFooter(
  lines: string[],
  outcomes: readonly ClaudeSkillOutcome[],
): void {
  const missingDependencyCount = countOutcomesWithMissingDependencies(outcomes);
  if (missingDependencyCount === 0) return;
  lines.push(
    `${missingDependencyCount} skill(s) depend on skipped/refused skills — see report for details.`,
  );
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
  if (manifest.lastRun && manifest.lastRun.outcomes.length > 0) {
    const totals = manifest.lastRun.totals;
    lines.push("");
    lines.push("latest outcomes:");
    lines.push(
      `  imported: ${totals.imported}, skipped-idempotent: ${totals.skippedIdempotent}, skipped-claude-specific: ${totals.skippedClaudeSpecific}, refused-other: ${totals.refusedOther}, refused-description-limit: ${totals.refusedDescriptionLimit}`,
    );
    for (const outcome of manifest.lastRun.outcomes) {
      const reason = outcome.refusalReason ?? outcome.reason;
      const detail = outcome.remediation
        ? `${reason}; remediation: ${outcome.remediation}`
        : reason;
      lines.push(`  - ${outcome.kebabName} [${outcome.disposition}] ${detail}`);
    }
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

export async function runMigrateCli(parsed: ParsedMigrateArgs): Promise<string> {
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
        verbose: parsed.verbose === true,
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
