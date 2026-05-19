import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { CURSOR_RULES_PATH } from "./adapters/cursor";
import { projectClaudeCodeHome, projectCodexHome, projectCursorHome, projectPiDevHome } from "./adapters";
import { writeProjection } from "./projection";
import { defaultSomaRepoPath } from "./repo-path";
import { DEFAULT_SUBSTRATE_HOMES } from "./adapter-active-isa";
import type { ProjectionInput, SomaHomeProjection, SomaHomeProjectionOptions, SubstrateId, WrittenProjection } from "./types";

export function resolveHomeProjectionPaths(
  substrate: SubstrateId,
  options: SomaHomeProjectionOptions = {},
): Omit<SomaHomeProjection, "bundle"> {
  if (substrate !== "codex" && substrate !== "pi-dev" && substrate !== "claude-code" && substrate !== "cursor") {
    throw new Error(`Home projection is not implemented for substrate: ${substrate}`);
  }

  const homeDir = resolve(options.homeDir ?? homedir());
  const defaultSubstrateHome = DEFAULT_SUBSTRATE_HOMES[substrate];

  return {
    substrate,
    somaHome: resolve(options.somaHome ?? join(homeDir, ".soma")),
    substrateHome: resolve(options.substrateHome ?? join(homeDir, defaultSubstrateHome)),
  };
}

export function buildCodexHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("codex", options);
  const homeDir = resolve(options.homeDir ?? homedir());
  const somaRepoPath = resolve(options.somaRepoPath ?? defaultSomaRepoPath());

  return {
    ...paths,
    bundle: projectCodexHome(input, paths.somaHome, homeDir, somaRepoPath),
  };
}

export async function installCodexHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildCodexHomeProjection(input, options);
  return writeProjection(projection.bundle, projection.substrateHome);
}

export function buildPiDevHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("pi-dev", options);

  return {
    ...paths,
    bundle: projectPiDevHome(input, paths.somaHome),
  };
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
  const paths = resolveHomeProjectionPaths("claude-code", options);

  return {
    ...paths,
    bundle: projectClaudeCodeHome(input),
  };
}

export async function installClaudeCodeHomeProjection(
  input: ProjectionInput,
  options: SomaHomeProjectionOptions = {},
): Promise<WrittenProjection> {
  const projection = buildClaudeCodeHomeProjection(input, options);
  return writeProjection(projection.bundle, projection.substrateHome);
}

export function buildCursorHomeProjection(input: ProjectionInput, options: SomaHomeProjectionOptions = {}): SomaHomeProjection {
  const paths = resolveHomeProjectionPaths("cursor", options);

  return {
    ...paths,
    bundle: projectCursorHome(input),
  };
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

export const CURSOR_RULES_BLOCK_BEGIN = "<!-- SOMA_CURSOR_BEGIN -->";
export const CURSOR_RULES_BLOCK_END = "<!-- SOMA_CURSOR_END -->";

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
