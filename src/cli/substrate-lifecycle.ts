import { homedir } from "node:os";
import { basename, join as pathJoin, relative as pathRelative, resolve as pathResolve } from "node:path";
import { cursorWorkspaceSubstrateHome } from "../adapters/cursor";
import {
  buildAnthropicCoworkHomeProjection,
  buildClaudeCodeHomeProjection,
  buildCodexHomeProjection,
  buildCursorHomeProjection,
  buildDshHomeProjection,
  buildGrokHomeProjection,
  buildPiDevHomeProjection,
} from "../home-projection";
import {
  installSomaForAnthropicCowork,
  installSomaForClaudeCode,
  installSomaForCodex,
  installSomaForCursor,
  installSomaForDsh,
  installSomaForGrok,
  installSomaForPiDev,
  planSomaForAnthropicCoworkInstall,
  planSomaForClaudeCodeInstall,
  planSomaForCodexInstall,
  planSomaForCursorInstall,
  planSomaForDshInstall,
  planSomaForGrokInstall,
  planSomaForPiDevInstall,
  uninstallSomaForAnthropicCowork,
  uninstallSomaForClaudeCode,
  uninstallSomaForCursor,
  uninstallSomaForGrok,
  type UninstallAnthropicCoworkResult,
  type UninstallClaudeCodeOptions,
  type UninstallClaudeCodeResult,
  type UninstallCursorResult,
  type UninstallGrokResult,
} from "../install";
import type { ClaudeCodeInstallOptions } from "../adapters/claude-code/install-options";
import { projectVsaSkillBundleFiles } from "../vsa-skill-installer";
import { defaultSubstrateHome, installSpecFor } from "../install-spec-registry";
import { loadSomaHome } from "../soma-home";
import { scanRegistrySkills, type UnprojectableRegistrySkill } from "../skill-projection";
import type {
  InstallSubstrate,
  ProjectionInput,
  SomaInstallOptions,
  SomaInstallPlan,
  SomaInstallResult,
} from "../types";
import { SomaCliError } from "./errors";
import { readOption } from "./parse-utils";

export type { InstallSubstrate } from "../types";
type InstallCliOptions = SomaInstallOptions &
  Partial<Pick<ClaudeCodeInstallOptions, "modeClassifier" | "policyGuard" | "claudeMd" | "feedbackCapture">>;
type ProjectionLifecycleSubstrate = Exclude<InstallSubstrate, "anthropic-cowork">;

export interface ParsedInstallArgs {
  command: "install";
  substrate: InstallSubstrate;
  apply: boolean;
  workspace: boolean;
  /** Official skill names (under `~/.soma/skills/`) to project on install. */
  skills: string[];
  options: InstallCliOptions;
}

export interface ParsedUninstallArgs {
  command: "uninstall";
  substrate: InstallSubstrate;
  workspace: boolean;
  options: SomaInstallOptions & UninstallClaudeCodeOptions;
}

export interface ParsedReprojectArgs {
  command: "reproject";
  substrate: ProjectionLifecycleSubstrate;
  workspace: boolean;
  options: SomaInstallOptions;
}

export interface ParsedUpgradeArgs {
  command: "upgrade";
  substrate: ProjectionLifecycleSubstrate;
  workspace: boolean;
  options: SomaInstallOptions;
}

export interface ParsedExportArgs {
  command: "export";
  substrate: InstallSubstrate;
  out?: string;
  options: SomaInstallOptions;
}

export interface ParsedDaemonArgs {
  command: "daemon";
}

export type ParsedSubstrateLifecycleArgs =
  | ParsedInstallArgs
  | ParsedUninstallArgs
  | ParsedReprojectArgs
  | ParsedUpgradeArgs
  | ParsedExportArgs
  | ParsedDaemonArgs;

export const PROJECTION_LIFECYCLE_SUBSTRATES = ["codex", "pi-dev", "claude-code", "cursor", "grok", "dsh"] as const satisfies readonly ProjectionLifecycleSubstrate[];
export const INSTALL_SUBSTRATES = [...PROJECTION_LIFECYCLE_SUBSTRATES, "anthropic-cowork"] as const satisfies readonly InstallSubstrate[];

const substrateList = INSTALL_SUBSTRATES.join("|");
const projectionLifecycleSubstrateList = PROJECTION_LIFECYCLE_SUBSTRATES.join("|");
const installOptions = "[--dry-run] [--apply] [--workspace] [--code-only] [--no-mode-classifier] [--no-policy-guard] [--no-feedback-capture] [--claude-md] [--skills <name[,name…]>] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";
// Shared by uninstall and projection verbs for common workspace/home flags.
const workspaceVerbOptions = "[--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";
const projectionVerbOptions = "[--workspace] [--code-only] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";
const uninstallOptions = workspaceVerbOptions;

function lifecycleUsage(command: string, target: string, options: string): string {
  return `Usage: soma ${command} ${target} ${options}`;
}

function lifecycleSubcommandUsage(command: string, options: string): Record<InstallSubstrate, string> {
  return Object.fromEntries(
    INSTALL_SUBSTRATES.map((substrate) => [
      substrate,
      lifecycleUsage(command, substrate, options),
    ]),
  ) as Record<InstallSubstrate, string>;
}

interface ProjectionOptions { homeDir?: string; somaHome?: string; substrateHome?: string }
interface ProjectionFile { path: string; content: string }
interface UninstallResult { substrateHome: string; removed: string[] }

const installPlanners: Record<InstallSubstrate, (options: SomaInstallOptions) => SomaInstallPlan> = {
  codex: planSomaForCodexInstall,
  "pi-dev": planSomaForPiDevInstall,
  "claude-code": planSomaForClaudeCodeInstall,
  cursor: planSomaForCursorInstall,
  grok: planSomaForGrokInstall,
  dsh: planSomaForDshInstall,
  "anthropic-cowork": planSomaForAnthropicCoworkInstall,
};

const installers: Record<InstallSubstrate, (options: SomaInstallOptions) => Promise<SomaInstallResult>> = {
  codex: installSomaForCodex,
  "pi-dev": installSomaForPiDev,
  "claude-code": installSomaForClaudeCode,
  cursor: installSomaForCursor,
  grok: installSomaForGrok,
  dsh: installSomaForDsh,
  "anthropic-cowork": installSomaForAnthropicCowork,
};

const projectionBuilders: Record<
  InstallSubstrate,
  (input: ProjectionInput, options: ProjectionOptions) => readonly ProjectionFile[]
> = {
  codex: (input, options) => buildCodexHomeProjection(input, options).bundle.files,
  "pi-dev": (input, options) => buildPiDevHomeProjection(input, options).bundle.files,
  "claude-code": (input, options) => buildClaudeCodeHomeProjection(input, options).bundle.files,
  cursor: (input, options) => buildCursorHomeProjection(input, options).bundle.files,
  grok: (input, options) => buildGrokHomeProjection(input, options).bundle.files,
  dsh: (input, options) => buildDshHomeProjection(input, options).bundle.files,
  "anthropic-cowork": (input, options) => buildAnthropicCoworkHomeProjection(input, options).bundle.files,
};

export const SUBSTRATE_LIFECYCLE_COMMAND_HELP: Record<
  "install" | "uninstall" | "reproject" | "upgrade" | "export" | "daemon",
  { usage: string; subcommands?: Record<string, string> }
> = {
  install: {
    usage: lifecycleUsage("install", `<${substrateList}>`, installOptions),
    subcommands: lifecycleSubcommandUsage("install", installOptions),
  },
  uninstall: {
    usage: lifecycleUsage("uninstall", `<${substrateList}>`, uninstallOptions),
    subcommands: lifecycleSubcommandUsage("uninstall", uninstallOptions),
  },
  reproject: {
    usage: lifecycleUsage("reproject", `<${projectionLifecycleSubstrateList}>`, projectionVerbOptions),
  },
  upgrade: {
    usage: lifecycleUsage("upgrade", `<${projectionLifecycleSubstrateList}>`, projectionVerbOptions),
  },
  export: {
    usage: lifecycleUsage("export", `<${substrateList}>`, "[--out <dir>] [--home-dir <dir>] [--soma-home <dir>]"),
  },
  daemon: {
    usage: "Usage: soma daemon  (not yet implemented - placeholder reserves the runtime mode)",
  },
};

export function isInstallSubstrate(value: string | undefined): value is InstallSubstrate {
  return value !== undefined && (INSTALL_SUBSTRATES as readonly string[]).includes(value);
}

function isProjectionLifecycleSubstrate(value: string | undefined): value is ProjectionLifecycleSubstrate {
  return value !== undefined && (PROJECTION_LIFECYCLE_SUBSTRATES as readonly string[]).includes(value);
}

export function parseOnboardingSubstrate(value: string): InstallSubstrate {
  if (isInstallSubstrate(value)) return value;
  throw new Error("--substrate must be one of codex, pi-dev, claude-code, cursor, grok, dsh, or anthropic-cowork.");
}

function commandUsage(command: keyof typeof SUBSTRATE_LIFECYCLE_COMMAND_HELP): string {
  return SUBSTRATE_LIFECYCLE_COMMAND_HELP[command].usage;
}

function workspaceSubstrateHome(substrate: InstallSubstrate): string {
  // CONTEXT.md Runtime modes: workspace projection lives at
  // `./.{codex,pi,claude,grok}/soma` — a soma-scoped subdir so it doesn't
  // collide with substrate-native workspace files the principal may
  // already have for that repo. The folder derives from the adapter-owned
  // defaultHome in the install-spec registry, so a newly registered
  // substrate can never silently fall through to another substrate's home.
  // Cursor is the one structural exception: its defaultHome is the home
  // root itself, so its workspace home has a dedicated resolver.
  //
  // dsh is the second exception, for a discovery reason rather than a
  // collision one: DSH scans `<projectRoot>/.dsh/skills` natively, so the
  // default `./.dsh/soma` convention would land skills where the loader
  // never looks. Its workspace home is `<cwd>/.dsh` — the same root shape
  // as the home projection, discovered by the same loader.
  if (substrate === "cursor") return cursorWorkspaceSubstrateHome();
  if (substrate === "dsh") return resolveJoin(process.cwd(), defaultSubstrateHome("dsh"));
  return resolveJoin(process.cwd(), defaultSubstrateHome(substrate), "soma");
}

function resolveJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function parseSubstrateLifecycleOptions<TOptions extends SomaInstallOptions = SomaInstallOptions>(
  substrate: InstallSubstrate,
  rest: string[],
  extra: (arg: string, index: number, options: TOptions) => boolean,
  parserOptions: { allowCodeOnly?: boolean } = {},
): { workspace: boolean; options: TOptions } {
  const options = {} as TOptions;
  let workspace = false;
  let substrateHomeExplicit = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];

    switch (arg) {
      case "--workspace":
        workspace = true;
        continue;
      case "--code-only":
        if (parserOptions.allowCodeOnly !== true) break;
        options.codeOnly = true;
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

    if (extra(arg, index, options)) continue;

    throw new Error(`Unknown option: ${arg}`);
  }

  if (workspace && !substrateHomeExplicit) {
    options.substrateHome = workspaceSubstrateHome(substrate);
  }

  return { workspace, options };
}

export function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const [command, substrate, ...rawRest] = args;

  if (command !== "install" || !isInstallSubstrate(substrate)) {
    throw new Error(commandUsage("install"));
  }

  // `--skills` carries a value, which the shared lifecycle parser (boolean
  // extras only) can't consume — pull it out first, then parse the remainder.
  const { value: skillsCsv, rest } = extractValueFlag(rawRest, "--skills");
  const skills = skillsCsv === undefined ? [] : parseSkillNames(skillsCsv);

  let apply = false;
  const { workspace, options } = parseSubstrateLifecycleOptions<InstallCliOptions>(substrate, rest, (arg, _index, parsedOptions) => {
    switch (arg) {
      case "--dry-run":
        apply = false;
        return true;
      case "--apply":
        apply = true;
        return true;
      // soma#369: mode classifier + policy guard are default-on. The explicit
      // enable flags are accepted for back-compat but behaviorally inert: they
      // only set the (already-default) `true` when no value is set yet, so a
      // `--no-*` flag ALWAYS wins regardless of order and the enable flag can
      // never flip an opt-out (sage#379). They remain recognized so the
      // non-claude-code guard below still rejects them.
      case "--mode-classifier":
        parsedOptions.modeClassifier ??= true;
        return true;
      case "--no-mode-classifier":
        parsedOptions.modeClassifier = false;
        return true;
      case "--policy-guard":
        parsedOptions.policyGuard ??= true;
        return true;
      case "--no-policy-guard":
        parsedOptions.policyGuard = false;
        return true;
      case "--claude-md":
        parsedOptions.claudeMd = true;
        return true;
      case "--feedback-capture":
        parsedOptions.feedbackCapture ??= true;
        return true;
      case "--no-feedback-capture":
        parsedOptions.feedbackCapture = false;
        return true;
    }
    return false;
  }, { allowCodeOnly: true });
  if (options.modeClassifier !== undefined && substrate !== "claude-code") {
    throw new Error("--mode-classifier / --no-mode-classifier is only supported for claude-code installs.");
  }
  if (options.policyGuard !== undefined && substrate !== "claude-code") {
    throw new Error("--policy-guard / --no-policy-guard is only supported for claude-code installs.");
  }
  if (options.feedbackCapture !== undefined && substrate !== "claude-code") {
    throw new Error("--feedback-capture / --no-feedback-capture is only supported for claude-code installs.");
  }
  if (options.claudeMd === true && substrate !== "claude-code") {
    throw new Error("--claude-md is only supported for claude-code installs.");
  }

  return { command, substrate, apply, workspace, skills, options };
}

/** Pull a `--flag <value>` pair out of an arg list, returning the value and the remaining args. */
function extractValueFlag(args: string[], flag: string): { value?: string; rest: string[] } {
  const index = args.indexOf(flag);
  if (index === -1) return { rest: args };
  const value = args[index + 1] as string | undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return { value, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function parseSkillNames(csv: string): string[] {
  const names = csv.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (names.length === 0) throw new Error("--skills requires at least one skill name.");
  for (const name of names) {
    // Reject any separator or dot-segment anywhere — the slot is derived as
    // `~/.soma/skills/<name>`, so a name is a single path segment, never a path.
    if (name.includes("/") || name.includes("\\") || name.includes("..") || name === ".") {
      throw new Error(`--skills takes skill names, not paths (got "${name}").`);
    }
  }
  return names;
}

function parseLifecycleVerbArgs(
  verb: "uninstall",
  args: string[],
): { substrate: InstallSubstrate; workspace: boolean; options: SomaInstallOptions };
function parseLifecycleVerbArgs(
  verb: "reproject" | "upgrade",
  args: string[],
): { substrate: ProjectionLifecycleSubstrate; workspace: boolean; options: SomaInstallOptions };
function parseLifecycleVerbArgs(
  verb: "uninstall" | "reproject" | "upgrade",
  args: string[],
): { substrate: InstallSubstrate | ProjectionLifecycleSubstrate; workspace: boolean; options: SomaInstallOptions } {
  const [command, substrate, ...rest] = args;

  if (command !== verb) {
    throw new Error(commandUsage(verb));
  }

  const parsedSubstrate = verb === "uninstall"
    ? (isInstallSubstrate(substrate) ? substrate : undefined)
    : (isProjectionLifecycleSubstrate(substrate) ? substrate : undefined);
  if (parsedSubstrate === undefined) {
    throw new Error(commandUsage(verb));
  }

  const { workspace, options } = parseSubstrateLifecycleOptions(parsedSubstrate, rest, () => false, {
    allowCodeOnly: verb === "reproject" || verb === "upgrade",
  });
  return { substrate: parsedSubstrate, workspace, options };
}

export function parseUninstallArgs(args: string[]): ParsedUninstallArgs {
  const { substrate, workspace, options } = parseLifecycleVerbArgs("uninstall", args);
  return { command: "uninstall", substrate, workspace, options };
}

export function parseReprojectArgs(args: string[]): ParsedReprojectArgs {
  const { substrate, workspace, options } = parseLifecycleVerbArgs("reproject", args);
  return { command: "reproject", substrate, workspace, options };
}

export function parseUpgradeArgs(args: string[]): ParsedUpgradeArgs {
  const { substrate, workspace, options } = parseLifecycleVerbArgs("upgrade", args);
  return { command: "upgrade", substrate, workspace, options };
}

export function parseExportArgs(args: string[]): ParsedExportArgs {
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

  return { command, substrate, out, options };
}

export function parseDaemonArgs(args: string[]): ParsedDaemonArgs {
  if (args[0] !== "daemon" || args.length > 1) {
    throw new Error(commandUsage("daemon"));
  }
  return { command: "daemon" };
}

export async function runSubstrateLifecycleCli(parsed: ParsedSubstrateLifecycleArgs): Promise<string> {
  if (parsed.command === "daemon") {
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
    //
    // soma#638: skills project here too. Once ~/.soma/skills is the curated set a
    // loader substrate holds whole, "I added a skill, resync this home" is the
    // main reason to reproject — a reproject that re-emitted the rules files but
    // left the loader stale would silently do nothing about the one change the
    // principal ran it for. The install layer does the linking; this only renders
    // what it reports.
    return formatInstallWithSkills(await runInstall(parsed.substrate, parsed.options));
  }

  if (!parsed.apply) {
    const plan = formatPlan(planInstall(parsed.substrate, parsed.options));
    // Name the skills the apply will link. The plan is a promise about what lands
    // (the greenfield install test enforces exactly that), and since soma#638 the
    // skill projection is the largest thing --apply does — reporting it only when
    // --skills was passed would leave a default install's plan describing a
    // fraction of the work.
    const { names, unprojectable } = await plannedSkills(parsed.substrate, parsed.skills, parsed.options);
    const skills = names.length === 0 ? "" : `\n\nSkills to project (on --apply): ${names.join(", ")}`;
    return `${plan}${skills}${formatUnprojectable(unprojectable)}`;
  }

  return formatInstallWithSkills(
    await runInstall(parsed.substrate, { ...parsed.options, skills: parsed.skills }),
  );
}

/** Render an install/reproject result plus whatever skills the install layer linked. */
function formatInstallWithSkills(result: SomaInstallResult): string {
  const base = formatInstallResult(result);
  const skipped = formatUnprojectable(result.unprojectableSkills);
  if (result.projectedSkills.length === 0) return `${base}${skipped}`;
  const projected = [
    "Projected skills:",
    ...result.projectedSkills.map((skill) => `- ${skill.skill}: ${skill.status} ${skill.path}`),
  ].join("\n");
  return `${base}\n\n${projected}${skipped}`;
}

/**
 * What the apply will link, for the dry-run plan only — the install layer owns
 * the projection itself (soma#638).
 *
 * `~/.soma/skills` is the curated set, so a substrate whose loader IS its
 * discovery mechanism gets ALL of it by default: with no catalog to name an
 * unprojected skill, anything left out of the loader is unreachable. `--skills`
 * narrows that to an explicit subset. A `catalog` substrate is unchanged — its
 * catalog already advertises the whole registry, so its loader stays opt-in.
 *
 * On the scan path `names` are the LOADER SLOT names, resolved from frontmatter,
 * because a dir `foo` holding `name: Bar` lands at `Bar` and a plan printed from
 * basenames would promise a path the apply never creates. On the `--skills` path
 * they are the names the principal typed: install resolves those dirs directly
 * and a name that does not resolve should surface as an error, not be silently
 * renamed in the plan.
 */
async function plannedSkills(
  substrate: InstallSubstrate,
  selected: string[],
  options: SomaInstallOptions,
): Promise<{ names: string[]; unprojectable: UnprojectableRegistrySkill[] }> {
  if (selected.length > 0) return { names: selected, unprojectable: [] };
  if (installSpecFor(substrate).skillsDiscovery !== "loader") return { names: [], unprojectable: [] };
  const scan = await scanRegistrySkills(options.somaHome ?? defaultSomaHomePath(options.homeDir));
  return { names: scan.skills.map((skill) => skill.name), unprojectable: scan.unprojectable };
}

/**
 * Registry entries the scan could not project, rendered so they are never dropped
 * silently — a curated skill that never reaches the harness is exactly the failure
 * this whole feature exists to prevent.
 */
function formatUnprojectable(rows: UnprojectableRegistrySkill[]): string {
  if (rows.length === 0) return "";
  return ["", "", "Skipped (not projectable):", ...rows.map((row) => `- ${basename(row.dir)}: ${row.reason}`)].join(
    "\n",
  );
}


function planInstall(substrate: InstallSubstrate, options: SomaInstallOptions): SomaInstallPlan {
  return installPlanners[substrate](options);
}

async function runInstall(substrate: InstallSubstrate, options: SomaInstallOptions): Promise<SomaInstallResult> {
  return installers[substrate](options);
}

async function runUninstall(parsed: ParsedUninstallArgs): Promise<string> {
  if (parsed.substrate === "claude-code") {
    return formatClaudeUninstallResult(await uninstallSomaForClaudeCode(parsed.options));
  }
  if (parsed.substrate === "cursor") {
    return formatCursorUninstallResult(await uninstallSomaForCursor(parsed.options));
  }
  if (parsed.substrate === "grok") {
    return formatGrokUninstallResult(await uninstallSomaForGrok(parsed.options));
  }
  if (parsed.substrate === "anthropic-cowork") {
    return formatAnthropicCoworkUninstallResult(await uninstallSomaForAnthropicCowork(parsed.options));
  }
  // Remaining uninstallers are reserved. The CLI surface exists so
  // CONTEXT.md's "Lifecycle verbs" table maps one-to-one (#54 AC); the
  // message derives from the adapter-owned uninstall spec so it stays
  // accurate as substrates land real uninstallers.
  const uninstallSpec = installSpecFor(parsed.substrate).uninstall;
  const detail =
    uninstallSpec.kind === "reserved"
      ? uninstallSpec.reason
      : "The adapter implements uninstall but the CLI wiring for it has not landed yet.";
  throw new SomaCliError(`soma uninstall ${parsed.substrate} is not yet implemented. ${detail}`, 1);
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
  // The VSA skill has a dedicated managed projection at install
  // time (installVsaSkillProjection) and is therefore excluded from the
  // generic portable-skill loop the projection builders run. Export runs
  // only that loop, so without this the bundle's skills.md lists the VSA
  // skill while its files are absent — an incomplete projection that does
  // not match an installed home. Append the same VSA files install writes,
  // as in-memory bundle entries, so `soma export` is a complete, installable
  // set.
  const vsaFiles = await buildExportVsaProjection(substrate, options);
  return [...files, ...vsaFiles].map((f) => ({ path: f.path, content: f.content }));
}

async function buildExportVsaProjection(
  substrate: InstallSubstrate,
  options: SomaInstallOptions,
): Promise<{ path: string; content: string }[]> {
  const spec = installSpecFor(substrate);
  // Resolve the substrate root the same way install does, then derive the
  // VSA destination relative to it so the bundle path matches an installed
  // home (e.g. codex → `skills/VSA`, cursor → `.cursor/rules/soma/skills/VSA`).
  const resolvedHomeDir = pathResolve(options.homeDir ?? homedir());
  const substrateRoot = pathResolve(options.substrateHome ?? pathJoin(resolvedHomeDir, spec.defaultHome));
  const destinationPrefix = pathRelative(substrateRoot, spec.vsaSkillProjection.destinationDir(substrateRoot));
  return projectVsaSkillBundleFiles({
    somaRepoPath: options.somaRepoPath,
    skillNameOverride: spec.vsaSkillProjection.skillNameOverride,
    projectionSubstrate: substrate,
    destinationPrefix,
  });
}

function projectionFilesFor(
  substrate: InstallSubstrate,
  input: ProjectionInput,
  options: ProjectionOptions,
): readonly ProjectionFile[] {
  return projectionBuilders[substrate](input, options);
}

function defaultSomaHomePath(homeDir?: string): string {
  const base = homeDir ?? process.env.HOME ?? process.cwd();
  return resolveJoin(base, ".soma");
}

function resolveAbsolute(path: string): string {
  if (path.startsWith("/")) return path;
  // soma#315: when soma is launched through an arc-generated shim, the
  // shim `cd`s into the repo before exec, so process.cwd() is the repo
  // root — not the directory the user ran `soma export` from. The shim
  // exports the caller's directory as ARC_INVOCATION_CWD; resolve a
  // relative --out against it, falling back to process.cwd() for direct
  // (non-shim) invocations.
  const base = process.env.ARC_INVOCATION_CWD ?? process.cwd();
  return resolveJoin(base, path);
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

export function formatPlan(plan: SomaInstallPlan): string {
  const title = plan.apply ? "Soma install plan" : "Soma install PLAN (no changes written) - pass --apply to apply";
  const footer = plan.apply ? [] : ["", "No changes were written. Re-run with --apply to apply this plan."];
  return [
    title,
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
    ...footer,
  ].join("\n");
}

export function formatInstallResult(result: SomaInstallResult): string {
  return [
    "Soma install applied",
    `substrate: ${result.substrate}`,
    `somaHome: ${result.somaHome.somaHome}`,
    `substrateHome: ${result.substrateHome.rootDir}`,
    ...(result.runtimeArtifact ? [`runtimeArtifact: ${result.runtimeArtifact.hash} (${result.runtimeArtifact.path})`, `runtimeRollback: soma runtime rollback --soma-home ${result.somaHome.somaHome}`] : []),
    "",
    "Soma files:",
    ...result.somaHome.files.map((path) => `- ${path}`),
    "",
    "Substrate files:",
    ...result.substrateHome.files.map((path) => `- ${path}`),
  ].join("\n");
}

export function formatClaudeUninstallResult(result: UninstallClaudeCodeResult): string {
  return formatUninstallResult("soma adopt claude — uninstall", result);
}

function formatCursorUninstallResult(result: UninstallCursorResult): string {
  return formatUninstallResult("soma uninstall cursor", result);
}

function formatGrokUninstallResult(result: UninstallGrokResult): string {
  return formatUninstallResult("soma uninstall grok", result);
}

function formatAnthropicCoworkUninstallResult(result: UninstallAnthropicCoworkResult): string {
  return formatUninstallResult("soma uninstall anthropic-cowork", result);
}

function formatUninstallResult(title: string, result: UninstallResult): string {
  if (result.removed.length === 0) {
    return [
      title,
      "",
      `Substrate home: ${result.substrateHome}`,
      "Nothing to remove — Soma was not installed at this substrate home.",
      "",
    ].join("\n");
  }
  return [
    title,
    "",
    `Substrate home: ${result.substrateHome}`,
    "",
    "Removed:",
    ...result.removed.map((p) => `  - ${p}`),
    "",
  ].join("\n");
}
