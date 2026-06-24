import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkCompleteness,
  getActiveVsa,
  vsaDir,
  vsaPath,
  listAvailableTiers,
  listVsas,
  resolveSomaHome,
  scaffoldVsa,
  setActiveVsa,
  type EffortTier,
  type VsaListEntry,
} from "./vsa";
import { installVsaSkill } from "./vsa-skill-installer";
import { datePrefixSlug } from "./dated-slug";

/**
 * `soma vsa <action>` CLI surface (#36). Thin shell over the library
 * (#34) — every command is exit-code correct, every mutation is
 * dry-runnable, every error is contextualized.
 */

export interface VsaCliResult {
  exitCode: 0 | 1 | 2;
  text: string;
}

export interface VsaCliOptions {
  homeDir?: string;
  somaHome?: string;
}

export async function runVsaCli(rawArgs: string[]): Promise<VsaCliResult> {
  const args = [...rawArgs];
  const action = args.shift();
  if (action === undefined || action === "help") {
    return { exitCode: 0, text: VSA_USAGE };
  }
  try {
    switch (action) {
      case "list":
        return await runList(parseFlags(args));
      case "show":
        return await runShow(args);
      case "active":
        return await runActive(parseFlags(args));
      case "use":
        return await runUse(args);
      case "scaffold":
        return await runScaffold(args);
      case "check":
        return await runCheck(args);
      case "archive":
        return await runArchive(args);
      case "skill":
        return await runSkill(args);
      default:
        return { exitCode: 2, text: `Unknown soma vsa action: '${action}'.\n\n${VSA_USAGE}` };
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Distinguish user errors (validation, missing slug) from system errors.
    const exitCode: 0 | 1 | 2 = /Invalid|requires|already exists|not found|no active/i.test(message) ? 1 : 2;
    return { exitCode, text: `Error: ${message}\n` };
  }
}

interface ParsedFlags {
  options: VsaCliOptions;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const options: VsaCliOptions = {};
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--home-dir" || arg === "--soma-home" || arg === "--slug" || arg === "--effort" || arg === "--goal" || arg === "--phase") {
      if (i + 1 >= args.length) throw new Error(`${arg} requires a value.`);
      const value = args[i + 1];
      if (arg === "--home-dir") options.homeDir = value;
      else if (arg === "--soma-home") options.somaHome = value;
      else flags[arg.slice(2)] = value;
      i += 1;
    } else if (arg === "--active-only" || arg === "--dry-run" || arg === "--force" || arg === "--json") {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: '${arg}'.`);
    } else {
      positional.push(arg);
    }
  }
  return { options, flags, positional };
}

function requirePositionalSlug(args: string[], action: string): string | { error: string } {
  if (args.length === 0) return { error: `soma vsa ${action} requires <slug>.\n` };
  const slug = args[0];
  if (slug.startsWith("--")) return { error: `soma vsa ${action} requires <slug>.\n` };
  return slug;
}

/**
 * Shared <slug> + flag parser for commands that take a positional slug
 * plus optional flags. Returns either { slug, parsed } on success or an
 * VsaCliResult to bubble straight up. Extracted to keep show/use/check/
 * archive consistent and reduce duplication (Sage round-2 suggestion).
 */
function parseSlugAction(args: string[], action: string): { slug: string; parsed: ParsedFlags } | VsaCliResult {
  const slugOrError = requirePositionalSlug(args, action);
  if (typeof slugOrError !== "string") return { exitCode: 1, text: slugOrError.error };
  return { slug: slugOrError, parsed: parseFlags(args.slice(1)) };
}

/**
 * Single source of truth for the `soma vsa` help surface. Exported so the
 * cli.ts top-level help renderer can re-use it instead of duplicating
 * subcommand strings (Sage round-1 maintainability suggestion).
 */
export const VSA_USAGE_HEADER = "Usage: soma vsa <list|show|active|use|scaffold|check|archive|skill> [options]";

export const VSA_SUBCOMMAND_HELP: Record<string, string> = {
  list: "Usage: soma vsa list [--phase <phase>] [--active-only] [--home-dir <dir>] [--soma-home <dir>]",
  show: "Usage: soma vsa show <slug> [--home-dir <dir>] [--soma-home <dir>]",
  active: "Usage: soma vsa active [--json] [--home-dir <dir>] [--soma-home <dir>]",
  use: "Usage: soma vsa use <slug> [--dry-run] [--home-dir <dir>] [--soma-home <dir>]",
  scaffold:
    "Usage: soma vsa scaffold --slug <name> --effort <E1|E2|E3|E4|E5> --goal <text> [--force] [--dry-run]",
  check: "Usage: soma vsa check <slug> [--home-dir <dir>] [--soma-home <dir>]",
  archive: "Usage: soma vsa archive <slug> [--dry-run] [--home-dir <dir>] [--soma-home <dir>]",
  skill: "Usage: soma vsa skill upgrade [--dry-run] [--home-dir <dir>] [--soma-home <dir>]",
};

const VSA_USAGE = [
  VSA_USAGE_HEADER,
  "",
  "Actions:",
  ...Object.entries(VSA_SUBCOMMAND_HELP).map(([name, usage]) => `  ${name.padEnd(10)} ${usage}`),
  "",
  "Common options:",
  "  --home-dir <path>     Override $HOME",
  "  --soma-home <path>    Override ~/.soma",
  "",
].join("\n");

async function runList(parsed: ParsedFlags): Promise<VsaCliResult> {
  const entries = await listVsas(parsed.options);
  const phase = typeof parsed.flags.phase === "string" ? parsed.flags.phase : null;
  const activeOnly = parsed.flags["active-only"] === true;
  // --active-only narrows to the currently-active VSA (per
  // memory/STATE/active.json), NOT all non-complete VSAs (Sage
  // round-1 important). If no active slug is set, the result is empty.
  const activeSlug = activeOnly
    ? (await getActiveVsa(parsed.options))?.activeSlug ?? null
    : null;
  const filtered = entries.filter((e) => {
    if (activeOnly && e.slug !== activeSlug) return false;
    if (phase !== null && e.phase !== phase) return false;
    return true;
  });
  if (filtered.length === 0) {
    return { exitCode: 0, text: "No VSAs found.\n" };
  }
  return { exitCode: 0, text: `${renderList(filtered)}\n` };
}

function renderList(entries: VsaListEntry[]): string {
  const headers = ["SLUG", "PHASE", "PROGRESS", "UPDATED"];
  const rows = entries.map((e) => [e.slug, e.phase, e.progress, e.updated]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (row: string[]): string => row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [fmt(headers), fmt(headers.map((_, i) => "-".repeat(widths[i]))), ...rows.map(fmt)].join("\n");
}

async function runShow(args: string[]): Promise<VsaCliResult> {
  const result = parseSlugAction(args, "show");
  if ("exitCode" in result) return result;
  const { slug, parsed } = result;
  const somaHome = resolveSomaHome(parsed.options);
  const path = vsaPath(somaHome, slug);
  try {
    const raw = await readFile(path, "utf8");
    return { exitCode: 0, text: raw.endsWith("\n") ? raw : `${raw}\n` };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exitCode: 1, text: `VSA not found: '${slug}'\n` };
    }
    throw error;
  }
}

async function runActive(parsed: ParsedFlags): Promise<VsaCliResult> {
  const state = await getActiveVsa(parsed.options);
  if (state?.activeSlug == null) {
    return { exitCode: 1, text: "no active VSA\n" };
  }
  if (parsed.flags.json === true) {
    return { exitCode: 0, text: `${JSON.stringify(state, null, 2)}\n` };
  }
  return { exitCode: 0, text: `${state.activeSlug}\n` };
}

async function runUse(args: string[]): Promise<VsaCliResult> {
  const result = parseSlugAction(args, "use");
  if ("exitCode" in result) return result;
  const { slug, parsed } = result;
  const somaHome = resolveSomaHome(parsed.options);
  try {
    await stat(vsaPath(somaHome, slug));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exitCode: 1, text: `VSA not found: '${slug}'. Scaffold one with: soma vsa scaffold --slug ${slug} --effort E1 --goal "..."\n` };
    }
    throw error;
  }
  if (parsed.flags["dry-run"] === true) {
    const current = await getActiveVsa(parsed.options);
    const currentSlug = current?.activeSlug ?? "(none)";
    return {
      exitCode: 0,
      text: `[dry-run] Would set active VSA: ${currentSlug} → ${slug}\n`,
    };
  }
  const setResult = await setActiveVsa(slug, parsed.options);
  const prev = setResult.previousSlug ?? "(none)";
  return {
    exitCode: 0,
    text: `Active VSA set: ${prev} → ${slug}\n`,
  };
}

async function runScaffold(args: string[]): Promise<VsaCliResult> {
  const parsed = parseFlags(args);
  const slug = typeof parsed.flags.slug === "string" ? datePrefixSlug(parsed.flags.slug) : null;
  const effort = typeof parsed.flags.effort === "string" ? parsed.flags.effort.toUpperCase() as EffortTier : null;
  const goal = typeof parsed.flags.goal === "string" ? parsed.flags.goal : null;
  if (slug === null) return { exitCode: 1, text: "soma vsa scaffold requires --slug.\n" };
  if (effort === null) return { exitCode: 1, text: "soma vsa scaffold requires --effort.\n" };
  if (goal === null) return { exitCode: 1, text: "soma vsa scaffold requires --goal.\n" };
  if (!listAvailableTiers().includes(effort)) {
    return { exitCode: 1, text: `Invalid effort tier: '${effort}'. Must be one of ${listAvailableTiers().join(", ")}.\n` };
  }
  const somaHome = resolveSomaHome(parsed.options);
  const targetPath = vsaPath(somaHome, slug);
  const exists = await stat(targetPath).then(() => true, () => false);
  if (exists && parsed.flags.force !== true) {
    return { exitCode: 1, text: `VSA already exists: '${slug}'. Use --force to overwrite.\n` };
  }
  if (parsed.flags["dry-run"] === true) {
    return {
      exitCode: 0,
      text: `[dry-run] Would scaffold ${slug} (${effort}) → ${targetPath}\n`,
    };
  }
  const { path } = await scaffoldVsa({ ...parsed.options, slug, effort, goal });
  return { exitCode: 0, text: `Scaffolded ${slug} (${effort}) → ${path}\n` };
}

async function runCheck(args: string[]): Promise<VsaCliResult> {
  const result = parseSlugAction(args, "check");
  if ("exitCode" in result) return result;
  const { slug, parsed } = result;
  try {
    const report = await checkCompleteness(slug, parsed.options);
    if (report.passed) {
      return { exitCode: 0, text: `${slug}: passed completeness check at ${report.tier}.\n` };
    }
    const gapLines = report.gaps.map((g) => `  - ${g.section}: ${g.reason}`).join("\n");
    return {
      exitCode: 1,
      text: `${slug}: incomplete at ${report.tier}.\n\nGaps:\n${gapLines}\n`,
    };
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exitCode: 1, text: `VSA not found: '${slug}'\n` };
    }
    throw error;
  }
}

async function runArchive(args: string[]): Promise<VsaCliResult> {
  const result = parseSlugAction(args, "archive");
  if ("exitCode" in result) return result;
  const { slug, parsed } = result;
  const somaHome = resolveSomaHome(parsed.options);
  const source = vsaPath(somaHome, slug);
  const archived = join(vsaDir(somaHome), ".archived", `${slug}.md`);
  const exists = await stat(source).then(() => true, () => false);
  if (!exists) return { exitCode: 1, text: `VSA not found: '${slug}'\n` };
  // If archiving the currently-active VSA, also clear active state so
  // `soma vsa active` doesn't keep pointing at a moved file (Sage
  // round-2 suggestion).
  const active = await getActiveVsa(parsed.options);
  const wasActive = active?.activeSlug === slug;
  if (parsed.flags["dry-run"] === true) {
    const activeNote = wasActive ? " (would also clear active state)" : "";
    return { exitCode: 0, text: `[dry-run] Would archive ${slug} → ${archived}${activeNote}\n` };
  }
  await mkdir(dirname(archived), { recursive: true });
  await rename(source, archived);
  if (wasActive) {
    await setActiveVsa(null, parsed.options);
  }
  const activeSuffix = wasActive ? " (active state cleared)" : "";
  return { exitCode: 0, text: `Archived ${slug} → ${archived}${activeSuffix}\n` };
}

async function runSkill(args: string[]): Promise<VsaCliResult> {
  if (args.length === 0 || args[0] !== "upgrade") {
    const sub = args.length === 0 ? "" : args[0];
    return { exitCode: 2, text: `Unknown soma vsa skill action: '${sub}'. Use 'upgrade'.\n` };
  }
  const parsed = parseFlags(args.slice(1));
  if (parsed.flags["dry-run"] === true) {
    return { exitCode: 0, text: `[dry-run] Would re-run VSA skill installer.\n` };
  }
  const result = await installVsaSkill({ ...parsed.options, force: true });
  return {
    exitCode: 0,
    text: `VSA skill upgraded: ${result.action} (source ${result.sourceVersion}, runtime ${result.runtimeVersion ?? "(none)"})\n`,
  };
}
