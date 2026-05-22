import {
  importAlgorithm,
  importPaiDocs,
  importPaiIdentity,
  importPaiPack,
  planAlgorithmImport,
  planPaiDocsImport,
  planPaiImport,
  planPaiPackImport,
} from "../index";
import type {
  AlgorithmImportOptions,
  AlgorithmImportPlan,
  AlgorithmImportResult,
  PaiDocsImportOptions,
  PaiDocsImportPlan,
  PaiDocsImportResult,
  PaiImportOptions,
  PaiImportPlan,
  PaiImportResult,
  PaiPackImportOptions,
  PaiPackImportPlan,
  PaiPackImportResult,
} from "../types";
import { PAI_DOCS_IMPORT_SUBDIRS } from "../pai-docs-importer";
import { warnDeprecatedSubstrateFlag } from "./deprecated-flags";
import { readOption } from "./parse-utils";

export type ImportSource = "pai" | "algorithm" | "pai-pack" | "pai-docs";

export type ParsedImportArgs =
  | {
      command: "import";
      source: "pai";
      apply: boolean;
      options: PaiImportOptions;
    }
  | {
      command: "import";
      source: "algorithm";
      apply: boolean;
      options: AlgorithmImportOptions;
    }
  | {
      command: "import";
      source: "pai-pack";
      apply: boolean;
      options: PaiPackImportOptions;
    }
  | {
      command: "import";
      source: "pai-docs";
      apply: boolean;
      options: PaiDocsImportOptions;
    };

export const IMPORT_COMMAND_HELP: { usage: string; subcommands: Record<ImportSource, string> } = {
  usage: "Usage: soma import <pai|algorithm|pai-pack|pai-docs> ...",
  subcommands: {
    pai: "Usage: soma import pai [--dry-run] [--apply] [--home-dir <dir>] [--claude-home <dir>] [--soma-home <dir>]",
    algorithm: "Usage: soma import algorithm [--dry-run] [--apply] [--home-dir <dir>] [--pai-algorithm-dir <dir>] [--soma-home <dir>]",
    "pai-pack": "Usage: soma import pai-pack [--dry-run] [--apply] [--home-dir <dir>] --pai-pack-dir <dir> [--soma-home <dir>] [--skill-name <name>] [--overwrite] [--include-unrecognized]",
    "pai-docs": "Usage: soma import pai-docs [--dry-run] [--apply] [--home-dir <dir>] --pai-source-dir <dir> [--soma-home <dir>]",
  },
};

export function parseImportArgs(args: string[]): ParsedImportArgs {
  const [command, source, ...rest] = args;

  if (command !== "import" || !isImportSource(source)) {
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

  if (source === "algorithm") {
    return { command, source, apply, options };
  }
  if (source === "pai-pack") {
    return { command, source, apply, options };
  }
  if (source === "pai-docs") {
    return { command, source, apply, options };
  }
  return { command, source, apply, options };
}

function isImportSource(source: string | undefined): source is ImportSource {
  return source === "pai" || source === "algorithm" || source === "pai-pack" || source === "pai-docs";
}

function formatImportSourceLines(plan: Pick<PaiImportPlan | AlgorithmImportPlan, "sourceChecks" | "sourceFiles">): string[] {
  return plan.sourceChecks && plan.sourceChecks.length > 0
    ? plan.sourceChecks.map((check) => `- [${check.present ? "present" : "missing"}] ${check.required ? "required" : "optional"} ${check.path}`)
    : plan.sourceFiles.map((path) => `- ${path}`);
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
    ...formatImportSourceLines(plan),
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
    ...formatImportSourceLines(plan),
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

export async function runImportCli(parsed: ParsedImportArgs): Promise<string> {
  if (parsed.source === "algorithm") {
    if (!parsed.apply) {
      return formatAlgorithmImportPlan(planAlgorithmImport(parsed.options));
    }

    return formatAlgorithmImportResult(await importAlgorithm(parsed.options));
  }

  if (parsed.source === "pai-pack") {
    if (!parsed.apply) {
      return formatPaiPackImportPlan(await planPaiPackImport(parsed.options));
    }

    return formatPaiPackImportResult(await importPaiPack(parsed.options));
  }

  if (parsed.source === "pai-docs") {
    if (!parsed.apply) {
      return formatPaiDocsImportPlan(await planPaiDocsImport(parsed.options));
    }

    return formatPaiDocsImportResult(await importPaiDocs(parsed.options));
  }

  if (!parsed.apply) {
    return formatPaiImportPlan(planPaiImport(parsed.options));
  }

  return formatPaiImportResult(await importPaiIdentity(parsed.options));
}
