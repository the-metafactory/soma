import { cursorWorkspaceSubstrateHome } from "../adapters/cursor";
import {
  buildClaudeCodeHomeProjection,
  buildCodexHomeProjection,
  buildCursorHomeProjection,
  buildPiDevHomeProjection,
  installSomaForClaudeCode,
  installSomaForCodex,
  installSomaForCursor,
  installSomaForPiDev,
  loadSomaHome,
  planSomaForClaudeCodeInstall,
  planSomaForCodexInstall,
  planSomaForCursorInstall,
  planSomaForPiDevInstall,
  uninstallSomaForClaudeCode,
  uninstallSomaForCursor,
  type UninstallClaudeCodeOptions,
  type UninstallClaudeCodeResult,
  type UninstallCursorResult,
} from "../index";
import type {
  ProjectionInput,
  SomaInstallOptions,
  SomaInstallPlan,
  SomaInstallResult,
  SubstrateId,
} from "../types";
import { SomaCliError } from "./errors";
import { readOption } from "./parse-utils";

export type InstallSubstrate = Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor">;

export interface ParsedInstallArgs {
  command: "install";
  substrate: InstallSubstrate;
  apply: boolean;
  workspace: boolean;
  options: SomaInstallOptions;
}

export interface ParsedUninstallArgs {
  command: "uninstall";
  substrate: InstallSubstrate;
  workspace: boolean;
  options: SomaInstallOptions & UninstallClaudeCodeOptions;
}

export interface ParsedReprojectArgs {
  command: "reproject";
  substrate: InstallSubstrate;
  workspace: boolean;
  options: SomaInstallOptions;
}

export interface ParsedUpgradeArgs {
  command: "upgrade";
  substrate: InstallSubstrate;
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

export const INSTALL_SUBSTRATES = ["codex", "pi-dev", "claude-code", "cursor"] as const satisfies readonly InstallSubstrate[];

const substrateList = INSTALL_SUBSTRATES.join("|");
const installOptions = "[--dry-run] [--apply] [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";
const uninstallOptions = "[--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]";

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
};

const installers: Record<InstallSubstrate, (options: SomaInstallOptions) => Promise<SomaInstallResult>> = {
  codex: installSomaForCodex,
  "pi-dev": installSomaForPiDev,
  "claude-code": installSomaForClaudeCode,
  cursor: installSomaForCursor,
};

const projectionBuilders: Record<
  InstallSubstrate,
  (input: ProjectionInput, options: ProjectionOptions) => readonly ProjectionFile[]
> = {
  codex: (input, options) => buildCodexHomeProjection(input, options).bundle.files,
  "pi-dev": (input, options) => buildPiDevHomeProjection(input, options).bundle.files,
  "claude-code": (input, options) => buildClaudeCodeHomeProjection(input, options).bundle.files,
  cursor: (input, options) => buildCursorHomeProjection(input, options).bundle.files,
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
    usage: "Usage: soma reproject <codex|pi-dev|claude-code|cursor> [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
  },
  upgrade: {
    usage: "Usage: soma upgrade <codex|pi-dev|claude-code|cursor> [--workspace] [--home-dir <dir>] [--soma-home <dir>] [--substrate-home <dir>]",
  },
  export: {
    usage: "Usage: soma export <codex|pi-dev|claude-code|cursor> [--out <dir>] [--home-dir <dir>] [--soma-home <dir>]",
  },
  daemon: {
    usage: "Usage: soma daemon  (not yet implemented - placeholder reserves the runtime mode)",
  },
};

export function isInstallSubstrate(value: string | undefined): value is InstallSubstrate {
  return value !== undefined && (INSTALL_SUBSTRATES as readonly string[]).includes(value);
}

export function parseOnboardingSubstrate(value: string): InstallSubstrate {
  if (isInstallSubstrate(value)) return value;
  throw new Error("--substrate must be one of codex, pi-dev, claude-code, or cursor.");
}

function commandUsage(command: keyof typeof SUBSTRATE_LIFECYCLE_COMMAND_HELP): string {
  return SUBSTRATE_LIFECYCLE_COMMAND_HELP[command].usage;
}

function workspaceSubstrateHome(substrate: InstallSubstrate): string {
  // CONTEXT.md Runtime modes: workspace projection lives at
  // `./.{codex,pi,claude}/soma` — a soma-scoped subdir so it doesn't
  // collide with substrate-native workspace files the principal may
  // already have for that repo.
  if (substrate === "cursor") return cursorWorkspaceSubstrateHome();
  const folder = substrate === "pi-dev" ? ".pi" : substrate === "claude-code" ? ".claude" : ".codex";
  return resolveJoin(process.cwd(), folder, "soma");
}

function resolveJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

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

export function parseInstallArgs(args: string[]): ParsedInstallArgs {
  const [command, substrate, ...rest] = args;

  if (command !== "install" || !isInstallSubstrate(substrate)) {
    throw new Error(commandUsage("install"));
  }

  let apply = false;
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

function parseLifecycleVerbArgs(
  verb: "uninstall" | "reproject" | "upgrade",
  args: string[],
): { substrate: InstallSubstrate; workspace: boolean; options: SomaInstallOptions } {
  const [command, substrate, ...rest] = args;

  if (command !== verb || !isInstallSubstrate(substrate)) {
    throw new Error(commandUsage(verb));
  }

  const { workspace, options } = parseSubstrateLifecycleOptions(substrate, rest, () => false);
  return { substrate, workspace, options };
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
    return formatInstallResult(await runInstall(parsed.substrate, parsed.options));
  }

  if (!parsed.apply) {
    return formatPlan(planInstall(parsed.substrate, parsed.options));
  }

  return formatInstallResult(await runInstall(parsed.substrate, parsed.options));
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
  // Codex and Pi.dev uninstallers are not yet implemented. The CLI
  // surface is reserved so CONTEXT.md's "Lifecycle verbs" table maps
  // one-to-one (#54 AC); functional removal lands in a follow-up.
  throw new SomaCliError(
    `soma uninstall ${parsed.substrate} is not yet implemented (claude-code and cursor are currently the functional uninstallers; codex and pi-dev removal land in a follow-up).`,
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
  options: ProjectionOptions,
): readonly ProjectionFile[] {
  return projectionBuilders[substrate](input, options);
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

export function formatPlan(plan: SomaInstallPlan): string {
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

export function formatInstallResult(result: SomaInstallResult): string {
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

export function formatClaudeUninstallResult(result: UninstallClaudeCodeResult): string {
  return formatUninstallResult("soma adopt claude — uninstall", result);
}

function formatCursorUninstallResult(result: UninstallCursorResult): string {
  return formatUninstallResult("soma uninstall cursor", result);
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
