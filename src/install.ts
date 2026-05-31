import { homedir } from "node:os";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  installClaudeCodeHomeProjection,
  installCodexHomeProjection,
  installCursorHomeProjection,
  installPiDevHomeProjection,
} from "./home-projection";
import { buildSomaStartupContext, runSomaLifecycleAlgorithmUpdated } from "./lifecycle";
import { SOMA_MEMORY_CATEGORIES } from "./memory-readmes";
import { defaultSomaRepoPath } from "./repo-path";
import { bootstrapSomaHome } from "./soma-home";
import { installIsaSkillProjection } from "./isa-skill-installer";
import { loadActiveIsaForBundle } from "./adapter-active-isa";
import { isEnoent } from "./fs-errors";
import {
  type ImplementedUninstallSpec,
  type InstallSubstrate,
  type LifecycleProjectionSpec,
  type SubstrateInstallSpec,
  type UninstallContext,
} from "./install-spec";
import { defaultSubstrateHome, installSpecFor } from "./install-spec-registry";
import type { ProjectionInput, SomaInstallOptions, SomaInstallPlan, SomaInstallResult } from "./types";

const SOMA_BOOTSTRAP_FILES = [
  "profile/assistant.md",
  "profile/principal.md",
  "profile/telos.md",
  "policy/README.md",
  "skills/README.md",
  "projections/README.md",
] as const;

// #88 / DD-2: canonical PAI v5.0.0 memory taxonomy. The per-category list
// + README content live in `memory-readmes.ts` so install planner, soma-home
// bootstrap, and tests share one source of truth. 17 substrate-neutral +
// 2 PAI-bound = 19 categories.
const SOMA_BOOTSTRAP_DIRECTORIES = [
  ...SOMA_MEMORY_CATEGORIES.map((category) => `memory/${category}`),
  "projections/codex",
  "projections/pi-dev",
  "projections/claude-code",
  "projections/cursor",
] as const;

function resolveInstallHomes(substrate: InstallSubstrate, options: SomaInstallOptions): { somaHome: string; substrateHome: string } {
  const homeDir = options.homeDir;
  const defaultHome = defaultSubstrateHome(substrate);
  const somaHome = options.somaHome ?? `${homeDir ?? "~"}/.soma`;
  const defaultRoot = defaultHome === "." ? (homeDir ?? "~") : `${homeDir ?? "~"}/${defaultHome}`;
  const substrateHome = options.substrateHome ?? defaultRoot;

  return {
    somaHome,
    substrateHome,
  };
}

// soma#73 pre-flight is shared with the codex adapter — see
// `src/bun-probe.ts` for the discovery + remediation logic.
import { requireBunInPath } from "./bun-probe";

export function planSomaInstall(
  substrate: InstallSubstrate,
  options: SomaInstallOptions = {},
): SomaInstallPlan {
  const spec = installSpecFor(substrate);
  const homes = resolveInstallHomes(substrate, options);

  return {
    substrate,
    apply: false,
    somaHome: homes.somaHome,
    substrateHome: homes.substrateHome,
    somaDirectories: SOMA_BOOTSTRAP_DIRECTORIES.map((path) => `${homes.somaHome}/${path}`),
    somaFiles: SOMA_BOOTSTRAP_FILES.map((path) => `${homes.somaHome}/${path}`),
    substrateFiles: spec.homeFiles.map((path) => `${homes.substrateHome}/${path}`),
  };
}

export function planSomaForCodexInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("codex", options);
}

export function planSomaForPiDevInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("pi-dev", options);
}

export function planSomaForClaudeCodeInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("claude-code", options);
}

export function planSomaForCursorInstall(options: SomaInstallOptions = {}): SomaInstallPlan {
  return planSomaInstall("cursor", options);
}

async function installSomaForSubstrate(
  substrate: InstallSubstrate,
  options: SomaInstallOptions = {},
): Promise<SomaInstallResult> {
  const spec = installSpecFor(substrate);
  // soma#73 pre-flight: every soma substrate hook now runs under Bun
  // (#!/usr/bin/env bun shebang). The adopter rejects loud + early
  // when bun is missing rather than producing a half-broken install
  // that fails at hook fire time. Always probes `which bun` — sage
  // r1 caught a bypass that trusted `process.versions.bun`, which
  // doesn't prove anything about the hook's later spawn environment.
  requireBunInPath();
  const somaHome = await bootstrapSomaHome(options);
  const somaRepoPath = options.somaRepoPath ?? defaultSomaRepoPath();
  // Install ISA skill into Soma home (canonical baseline) so other
  // tooling reading <somaHome>/skills/ISA continues to work.
  await installIsaSkillProjection({
    homeDir: options.homeDir,
    somaHome: somaHome.somaHome,
    somaRepoPath,
  });
  const projectionOptions = {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrateHome: options.substrateHome,
    somaRepoPath,
  };
  // Per-substrate skill projection (#37 AC-3). Each substrate gets the
  // versioned ISA skill under its native skills dir, with independent
  // baseline tracking via `skillDestinationDir`. AC-5: drift detection
  // inherits installIsaSkill's local-edits-preserved contract.
  const resolvedHomeDir = resolve(options.homeDir ?? homedir());
  const substrateRoot = resolve(options.substrateHome ?? join(resolvedHomeDir, spec.defaultHome));
  await spec.validator?.(substrateRoot);
  await spec.isaSkillProjection.prepare?.(substrateRoot);
  await installIsaSkillProjection({
    homeDir: options.homeDir,
    somaHome: somaHome.somaHome,
    somaRepoPath,
    skillDestinationDir: spec.isaSkillProjection.destinationDir(substrateRoot),
    skillNameOverride: spec.isaSkillProjection.skillNameOverride,
    projectionSubstrate: substrate,
  });
  // Populate the projection input with the active ISA so each
  // substrate writes its `active-isa.md` file (#37 AC-1/AC-2).
  const contextWithActiveIsa: ProjectionInput = {
    ...somaHome.context,
    activeIsa: (await loadActiveIsaForBundle({ somaHome: somaHome.somaHome })) ?? undefined,
  };
  const substrateHome = await installHomeProjectionFor(substrate, contextWithActiveIsa, projectionOptions);
  const postProjectionFiles = await runPostProjectionSteps(spec, {
    homeDir: options.homeDir,
    somaHome: somaHome.somaHome,
    somaRepoPath: projectionOptions.somaRepoPath,
    substrateHome: substrateHome.rootDir,
  });
  const lifecycleSpec = spec.lifecycleProjection;
  const lifecycleFiles = lifecycleSpec
    ? await installLifecycleProjection(lifecycleSpec, substrateHome.rootDir, {
        homeDir: options.homeDir,
        somaHome: somaHome.somaHome,
        somaRepoPath: projectionOptions.somaRepoPath,
        substrate,
      })
    : [];

  return {
    substrate,
    somaHome,
    substrateHome: {
      ...substrateHome,
      files: [...substrateHome.files, ...postProjectionFiles, ...lifecycleFiles],
    },
  };
}

async function runPostProjectionSteps(
  spec: SubstrateInstallSpec,
  context: { homeDir?: string; somaHome: string; somaRepoPath: string; substrateHome: string },
): Promise<string[]> {
  const files: string[] = [];
  for (const step of spec.postProjection ?? []) {
    files.push(...(await step.run(context)));
  }
  return files;
}

async function installHomeProjectionFor(
  substrate: InstallSubstrate,
  context: ProjectionInput,
  options: { homeDir?: string; somaHome?: string; substrateHome?: string; somaRepoPath: string },
) {
  switch (substrate) {
    case "codex":
      return installCodexHomeProjection(context, options);
    case "pi-dev":
      return installPiDevHomeProjection(context, options);
    case "claude-code":
      return installClaudeCodeHomeProjection(context, options);
    case "cursor":
      return installCursorHomeProjection(context, options);
  }
}

async function writeProjectionFile(root: string, relativePath: string, content: string): Promise<string> {
  const path = join(root, relativePath);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${content.trimEnd()}\n`, "utf8");

  return path;
}

async function installLifecycleProjection(
  lifecycle: LifecycleProjectionSpec,
  substrateHome: string,
  options: { homeDir?: string; somaHome: string; somaRepoPath: string; substrate: InstallSubstrate },
): Promise<string[]> {
  await runSomaLifecycleAlgorithmUpdated(options);
  const startup = await buildSomaStartupContext(options);
  const files = [await writeProjectionFile(substrateHome, lifecycle.startupContextPath, startup.context)];

  if (lifecycle.somaRepoPathPath) {
    files.push(await writeProjectionFile(substrateHome, lifecycle.somaRepoPathPath, options.somaRepoPath));
  }

  return files;
}

export async function installSomaForCodex(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("codex", options);
}

export async function installSomaForPiDev(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("pi-dev", options);
}

/**
 * Claude Code substrate installer (#29). Bootstraps Soma home,
 * installs the ISA skill into `~/.claude/skills/ISA/`, and writes the
 * full projection skeleton at `~/.claude/rules/soma/` (auto-discovered
 * by Claude Code, per the soma#64 pivot away from `@`-imports).
 * It also installs Soma-owned lifecycle/writeback hooks and patches
 * `~/.claude/settings.json` idempotently. CLAUDE.md composition remains
 * intentionally out of scope.
 */
export async function installSomaForClaudeCode(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("claude-code", options);
}

export async function installSomaForCursor(options: SomaInstallOptions = {}): Promise<SomaInstallResult> {
  return installSomaForSubstrate("cursor", options);
}

/**
 * Uninstall Soma's projection from a Claude Code home (#29). Removes
 * `<substrateHome>/rules/soma/` and `<substrateHome>/skills/ISA/`
 * entirely. Returns the list of paths actually removed (empty when
 * Soma was never installed). Never touches files outside those two
 * directories — by construction, those are the only paths the
 * installer writes.
 */
export interface UninstallClaudeCodeOptions {
  homeDir?: string;
  substrateHome?: string;
}

export interface UninstallClaudeCodeResult {
  substrate: "claude-code";
  substrateHome: string;
  removed: string[];
}

export interface UninstallCursorOptions {
  homeDir?: string;
  substrateHome?: string;
}

export interface UninstallCursorResult {
  substrate: "cursor";
  substrateHome: string;
  removed: string[];
}

type ImplementedUninstallSubstrate = "claude-code" | "cursor";
interface ImplementedUninstallOptions { homeDir?: string; substrateHome?: string }
interface ImplementedUninstallResult<S extends ImplementedUninstallSubstrate> {
  substrate: S;
  substrateHome: string;
  removed: string[];
}

async function removeExistingTargets(
  targets: readonly string[],
  shouldRemove: (target: string) => boolean | Promise<boolean> = () => true,
): Promise<string[]> {
  const removed: string[] = [];
  for (const target of targets) {
    try {
      await stat(target);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (!(await shouldRemove(target))) continue;
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
  }
  return removed;
}

async function runImplementedUninstall(
  spec: ImplementedUninstallSpec,
  context: UninstallContext,
): Promise<string[]> {
  const targets = spec.remove.map((target) => resolve(context.substrateHome, target));
  const removed = await removeExistingTargets(targets, async (target) => spec.shouldRemove?.(target, context) ?? true);
  removed.push(...(await spec.postRemove?.(context) ?? []));
  return removed;
}

async function uninstallSomaForSubstrate<S extends ImplementedUninstallSubstrate>(
  substrate: S,
  options: ImplementedUninstallOptions = {},
): Promise<ImplementedUninstallResult<S>> {
  const resolvedHomeDir = resolve(options.homeDir ?? homedir());
  const substrateHome = resolve(options.substrateHome ?? join(resolvedHomeDir, defaultSubstrateHome(substrate)));
  const spec = installSpecFor(substrate).uninstall;
  const removed = spec.kind === "implemented" ? await runImplementedUninstall(spec, { homeDir: options.homeDir, substrateHome }) : [];
  return { substrate, substrateHome, removed };
}

export async function uninstallSomaForClaudeCode(
  options: UninstallClaudeCodeOptions = {},
): Promise<UninstallClaudeCodeResult> {
  return uninstallSomaForSubstrate("claude-code", options);
}

export async function uninstallSomaForCursor(
  options: UninstallCursorOptions = {},
): Promise<UninstallCursorResult> {
  return uninstallSomaForSubstrate("cursor", options);
}
