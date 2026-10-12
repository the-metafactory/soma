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
import { createSomaSnapshot } from "../snapshots";
import type {
  ClaudeSkillOutcome,
  ClaudeSkillsMigrationManifest,
  ClaudeSkillsMigrationOptions,
  ClaudeSkillsMigrationPlan,
  ClaudeSkillsMigrationResult,
  ClaudeSkillsSmokeSubstrate,
  RewriteDescriptionsAgent,
} from "../types";
import { SomaCliError } from "./errors";
import { readOption } from "./parse-utils";

// #115 — `soma migrate claude-skills`. Phase 1 verb + classifier
// (#116) ships the flat-tree import; Phase 2 adds `--smoke
// <substrate>` (repeatable) for per-skill static-shape verify
// against the requested target substrate's projection (codex, pi-dev,
// or `all` which expands to both). `--smoke` is optional and absent
// from the usage line below for non-Phase-2 callers — they keep the
// Phase-1 surface intact.
export const MIGRATE_CLAUDE_SKILLS_USAGE =
  "Usage: soma migrate claude-skills --from <skills-dir> [--dry-run] [--apply] [--status] [--home-dir <dir>] [--soma-home <dir>] [--include-claude-specific] [--smoke <codex|pi-dev|grok|all>] [--rewrite-descriptions <claude|codex|pi|none|auto>] [--quiet] [--verbose]";

export const MIGRATE_COMMAND_HELP: { usage: string; subcommands: Record<"claude-skills", string> } = {
  usage: MIGRATE_CLAUDE_SKILLS_USAGE,
  subcommands: {
    "claude-skills": MIGRATE_CLAUDE_SKILLS_USAGE,
  },
};

/**
 * #115 — `soma migrate claude-skills` parsed args. The only migrate
 * source since PAI migration was removed (pin soma ≤ 0.25 for it).
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

export type ParsedMigrateArgs = ParsedMigrateClaudeSkillsArgs;

function commandUsage(action?: string): string {
  return (isMigrateSource(action) ? MIGRATE_COMMAND_HELP.subcommands[action] : undefined) ?? MIGRATE_COMMAND_HELP.usage;
}

function isMigrateSource(action: string | undefined): action is keyof typeof MIGRATE_COMMAND_HELP.subcommands {
  return action === "claude-skills";
}

export function parseMigrateArgs(args: string[]): ParsedMigrateArgs {
  const [command, source] = args;
  if (command !== "migrate" || source !== "claude-skills") {
    throw new Error(commandUsage(source));
  }
  return parseMigrateClaudeSkillsArgs(args);
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
// non-source substrate (codex + pi-dev + grok — claude-code is the
// source substrate of `migrate claude-skills` and intentionally
// excluded because re-projecting an imported skill back to its source
// would only ever round-trip). Unknown values throw with the canonical
// allowed set so the principal sees what's accepted.
const VALID_SMOKE_VALUES: readonly (ClaudeSkillsSmokeSubstrate | "all")[] = [
  "codex",
  "pi-dev",
  "grok",
  "all",
];

function expandSmokeSubstrateArg(value: string): ClaudeSkillsSmokeSubstrate[] {
  if (value === "all") return ["codex", "pi-dev", "grok"];
  if (value === "codex" || value === "pi-dev" || value === "grok") return [value];
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
        const rw = o.descriptionRewrite;
        if (!rw) continue;
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
  const match = /^(\d+)\s/.exec(reason);
  return match ? parseInt(match[1], 10) : 0;
}

function extractClassifierDetail(reason: string): string {
  const inMatch = /in\s+(.+)$/.exec(reason);
  return inMatch ? inMatch[1] : reason;
}

// #115 — `soma migrate claude-skills` formatters: header line + per-row table.
// #124 — Grouped by disposition for scannable outcome summaries.
function formatClaudeSkillsMigrationPlan(plan: ClaudeSkillsMigrationPlan): string {
  if (!plan.isFlatSkillsTree) {
    return [
      "soma migrate claude-skills — plan (dry-run)",
      `from: ${plan.from}`,
      `somaHome: ${plan.somaHome}`,
      "",
      `Refused: ${plan.flatTreeRefusalReason ?? "--from is not a flat skills tree (no <Name>/SKILL.md direct children)."}`,
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
  claudeOptions.progressEmitter ??= createProgressEmitter({
      stderr: process.stderr,
      quiet: parsed.quiet === true,
      isatty: process.stderr.isTTY,
      verbose: parsed.verbose === true,
    });
  if (parsed.mode === "plan") {
    // #118 — plan mode is informative; refused-other rows are
    // displayed but the CLI exits 0.
    return formatClaudeSkillsMigrationPlan(
      await planClaudeSkillsMigration(claudeOptions),
    );
  }
  await createSomaSnapshot({
    homeDir: claudeOptions.homeDir,
    somaHome: claudeOptions.somaHome,
    name: "before-migrate-claude-skills",
    trigger: "migrate-claude-skills",
  });
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
