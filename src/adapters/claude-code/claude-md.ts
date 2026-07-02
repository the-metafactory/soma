import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEnoent } from "../../fs-utils";
import { loadSomaHome } from "../../soma-home";
import type { InstallPostProjectionContext } from "../../install-spec";
import type { ProjectionInput } from "../../types";
import {
  extractOverlay,
  hasProvenanceHeader,
  renderOverlay,
  withProvenance,
} from "../shared";
import { isClaudeCodeInstallOptions } from "./install-options";

/**
 * Generated `~/.claude/CLAUDE.md` (soma#368). Opt-in via `--claude-md`.
 *
 * The body is a thin pointer: the real projected context lives in the
 * auto-discovered `rules/soma/` bundle (soma#64), so CLAUDE.md only needs to
 * announce provenance and route the reader there. Everything a human wants to
 * keep in CLAUDE.md goes in the overlay block, which survives reprojection.
 */
export const CLAUDE_CODE_CLAUDE_MD_RELATIVE_PATH = "CLAUDE.md";

function renderClaudeMdBody(input: ProjectionInput, overlayBody: string | null): string {
  const displayName = input.profile.assistant.displayName ?? "";
  const assistant = displayName.length > 0 ? displayName : input.profile.assistant.name;
  const generated = [
    `# ${assistant} — Claude Code`,
    "",
    "Soma is the source of truth for assistant identity, purpose, memory, skills, and policy.",
    "The projected context Claude Code auto-discovers lives under `.claude/rules/soma/`:",
    "",
    "- `rules/soma/CONTEXT.md` — identity, principal, purpose, operating rules",
    "- `rules/soma/PURPOSE.md` — mission, goals, principles, commitments",
    "- `rules/soma/SKILLS.md` — available skills",
    "- `rules/soma/POLICY.md` — substrate policy",
    "",
    "Refresh this projection with `soma install claude-code --apply`.",
  ].join("\n");
  return withProvenance(
    "claude-code",
    [generated, "", renderOverlay(overlayBody)].join("\n"),
  );
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Decide what overlay content to carry into the regenerated file.
 *
 * - An existing overlay block is preserved verbatim (idempotency + hand edits
 *   inside the markers survive).
 * - A pre-existing, non-Soma CLAUDE.md is preserved WHOLESALE into the overlay
 *   on first conversion — this is the lossless-migration guarantee: converting
 *   a hand-maintained CLAUDE.md never drops its content, it moves under the
 *   marker for later curation.
 * - Otherwise (greenfield, or an already-Soma file with no overlay) there is
 *   nothing to carry.
 */
export function resolveClaudeMdOverlay(existing: string | null): string | null {
  if (existing === null) return null;
  const existingOverlay = extractOverlay(existing);
  if (existingOverlay !== null) return existingOverlay;
  if (!hasProvenanceHeader(existing) && existing.trim().length > 0) {
    return [
      "Preserved from the pre-Soma CLAUDE.md on first projection. Curate or move into ~/.soma.",
      "",
      existing.trim(),
    ].join("\n");
  }
  return null;
}

/**
 * postProjection step: write the generated CLAUDE.md when `--claude-md` is set.
 * No-op otherwise, so the default install still leaves CLAUDE.md untouched
 * (the soma#64 stance) until a caller explicitly opts in.
 */
export async function installClaudeCodeClaudeMd(context: InstallPostProjectionContext): Promise<string[]> {
  if (!(isClaudeCodeInstallOptions(context.options) && context.options.claudeMd === true)) {
    return [];
  }
  const target = join(context.substrateHome, CLAUDE_CODE_CLAUDE_MD_RELATIVE_PATH);
  const existing = await readOrNull(target);
  const overlay = resolveClaudeMdOverlay(existing);
  const input = await loadSomaHome(context.somaHome);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${renderClaudeMdBody(input, overlay).trimEnd()}\n`, "utf8");
  return [target];
}
