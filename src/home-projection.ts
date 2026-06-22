import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { CURSOR_RULES_BLOCK_BEGIN, CURSOR_RULES_BLOCK_END, CURSOR_RULES_PATH } from "./adapters/cursor";
import { projectClaudeCodeHome, projectCodexHome, projectCursorHome, projectGrokHome, projectPiDevHome } from "./adapters";
import { isGrokPortableSkillProjectionPath } from "./adapters/grok/install";
import { reconcileGrokPortableSkillProjection, writeGrokInstallManifest } from "./adapters/grok/install-manifest";
import { writeProjection } from "./projection";
import { defaultSomaRepoPath } from "./repo-path";
import { defaultSubstrateHome } from "./install-spec-registry";
import type { Projection, ProjectionInput, SomaHomeProjection, SomaHomeProjectionOptions, SubstrateId, WrittenProjection } from "./types";

export function resolveHomeProjectionPaths(
  substrate: SubstrateId,
  options: SomaHomeProjectionOptions = {},
): Omit<SomaHomeProjection, "bundle"> {
  if (substrate !== "codex" && substrate !== "pi-dev" && substrate !== "claude-code" && substrate !== "cursor" && substrate !== "grok") {
    throw new Error(`Home projection is not implemented for substrate: ${substrate}`);
  }

  const homeDir = resolve(options.homeDir ?? homedir());
  const defaultHome = defaultSubstrateHome(substrate);

  return {
    substrate,
    somaHome: resolve(options.somaHome ?? join(homeDir, ".soma")),
    substrateHome: resolve(options.substrateHome ?? join(homeDir, defaultHome)),
  };
}

function buildHomeProjectionFor(
  substrate: Extract<SubstrateId, "codex" | "pi-dev" | "claude-code" | "cursor" | "grok">,
  options: SomaHomeProjectionOptions,
  project: (paths: Omit<SomaHomeProjection, "bundle">) => Projection,
): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths(substrate, options);

  return {
    ...paths,
    bundle: project(paths),
  };
}

export function buildCodexHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const homeDir = resolve(options.homeDir ?? homedir());
  const somaRepoPath = resolve(options.somaRepoPath ?? defaultSomaRepoPath());

  return buildHomeProjectionFor("codex", options, (paths) => projectCodexHome(input, paths.somaHome, homeDir, somaRepoPath));
}

export async function installCodexHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildCodexHomeProjection(input, options);
  return writeProjection(projection.bundle, projection.substrateHome);
}

export function buildPiDevHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("pi-dev", options, (paths) => projectPiDevHome(input, paths.somaHome));
}

export async function installPiDevHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildPiDevHomeProjection(input, options);
  return writeProjection(projection.bundle, projection.substrateHome);
}

/**
 * Claude Code home projection (#37 minimal). For now this bundle is
 * just the active-ISA file at `PAI/ACTIVE_ISA.md`; the full home
 * install lands in #29 with the `.claude/rules/` pivot.
 */
export function buildClaudeCodeHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): SomaHomeProjection {
  return buildHomeProjectionFor("claude-code", options, () => projectClaudeCodeHome(input));
}

export async function installClaudeCodeHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildClaudeCodeHomeProjection(input, options);
  return writeProjection(projection.bundle, projection.substrateHome);
}

export function buildCursorHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  return buildHomeProjectionFor("cursor", options, () => projectCursorHome(input));
}

export function buildGrokHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const homeDir = resolve(options.homeDir ?? homedir());
  const somaRepoPath = resolve(options.somaRepoPath ?? defaultSomaRepoPath());

  // The hook surface embeds install-time absolutes, so the
  // resolved substrate home — including a substrateHome override — and
  // the trusted repo path flow into the projection.
  return buildHomeProjectionFor("grok", options, (paths) =>
    projectGrokHome(input, paths.somaHome, { homeDir, somaRepoPath, grokHome: paths.substrateHome }),
  );
}

export async function installGrokHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildGrokHomeProjection(input, options);
  const portableFiles = projection.bundle.files.filter((file) => isGrokPortableSkillProjectionPath(file.path));
  const written = await writeProjection(projection.bundle, projection.substrateHome);
  // U6 follow-up: the manifest records the dynamically-named
  // portable-skill files (path + content hash) on the Soma side so
  // uninstall can round-trip them. Before refreshing it, reconcile:
  // files the previous install recorded that this projection no longer
  // contains (skill removed/renamed in the profile) are removed with the
  // same user-edit-preserving guards uninstall uses — otherwise they
  // stay orphaned in ~/.grok. Reproject/upgrade reuse this installer.
  await reconcileGrokPortableSkillProjection({
    somaHome: projection.somaHome,
    substrateHome: projection.substrateHome,
    currentPaths: portableFiles.map((file) => file.path),
  });
  await writeGrokInstallManifest({
    somaHome: projection.somaHome,
    substrateHome: projection.substrateHome,
    files: portableFiles,
  });
  return written;
}

export async function installCursorHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildCursorHomeProjection(input, options);
  const cursorRules = projection.bundle.files.find((file) => file.path === CURSOR_RULES_PATH);
  const projectionWithoutCursorRules = {
    ...projection.bundle,
    files: projection.bundle.files.filter((file) => file.path !== CURSOR_RULES_PATH),
  };
  const written = await writeProjection(projectionWithoutCursorRules, projection.substrateHome);

  if (cursorRules) {
    const target = resolve(projection.substrateHome, CURSOR_RULES_PATH);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await mergeCursorRulesFile(target, cursorRules.content), "utf8");
    written.files.push(target);
  }

  return written;
}

export { CURSOR_RULES_BLOCK_BEGIN, CURSOR_RULES_BLOCK_END };

function renderCursorRulesBlock(content: string): string {
  return `${CURSOR_RULES_BLOCK_BEGIN}\n${content.trimEnd()}\n${CURSOR_RULES_BLOCK_END}`;
}

function replaceCursorRulesBlock(existing: string, generated: string): string {
  const start = existing.indexOf(CURSOR_RULES_BLOCK_BEGIN);
  if (start === -1) return `${existing.trimEnd()}\n\n${renderCursorRulesBlock(generated)}\n`;
  const end = existing.indexOf(CURSOR_RULES_BLOCK_END, start);
  if (end === -1) return `${existing.trimEnd()}\n\n${renderCursorRulesBlock(generated)}\n`;
  const before = existing.slice(0, start).trimEnd();
  const after = existing.slice(end + CURSOR_RULES_BLOCK_END.length).trimStart();
  const next = [before, renderCursorRulesBlock(generated), after.trimEnd()].filter((part) => part.length > 0).join("\n\n");
  return `${next}\n`;
}

async function mergeCursorRulesFile(target: string, generated: string): Promise<string> {
  const existing = await readFile(target, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return "";
    }
    throw error;
  });

  if (existing.length === 0 || existing.startsWith("# Soma Cursor Projection")) {
    return `${generated.trimEnd()}\n`;
  }

  return replaceCursorRulesBlock(existing, generated);
}
