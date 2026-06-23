/**
 * Adapter active-VSA projection (#37).
 *
 * Single source of truth for the active-VSA file that every substrate
 * projects into its own home. Using `serializeVsa` guarantees the file
 * is BYTE-identical across substrates — that's AC-4's portability
 * contract (run a scaffold once, install for all three substrates,
 * the resulting active-vsa.md files are exact byte equals).
 *
 * When no active VSA is set the file is OMITTED from the bundle
 * entirely (AC-2) rather than written empty — adapters must filter the
 * `null` result before adding to their files list.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getActiveVsa, readVsa } from "./vsa";
import { serializeVsa } from "./vsa-parse";
import type { VerificationStateArtifact, SubstrateId } from "./types";

export interface LoadActiveVsaOptions {
  homeDir?: string;
  somaHome?: string;
}

/**
 * Resolve the active VSA from the Soma home, or null when no slug is
 * set. Used by per-substrate installers to populate `input.activeVsa`
 * before invoking the adapter's `project*Home`.
 */
export async function loadActiveVsaForBundle(
  options: LoadActiveVsaOptions = {},
): Promise<VerificationStateArtifact | null> {
  const somaHome = resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
  const state = await getActiveVsa({ somaHome });
  if (state?.activeSlug == null) return null;
  return readVsa(state.activeSlug, { somaHome });
}

/**
 * The byte-portable rendering of an active VSA — `serializeVsa` is the
 * same renderer used to write the on-disk file, so every substrate
 * projection ends up with identical bytes when scaffolded from the same
 * VSA. Adapters MUST call this (not their own serializer) to satisfy
 * AC-4 portability.
 */
export function renderActiveVsaFile(isa: VerificationStateArtifact): string {
  return serializeVsa(isa);
}

/**
 * Per-substrate relative path inside the substrate home for the active
 * VSA file. Aligned with the #37 issue specification table.
 *
 * | Substrate    | Path                              |
 * |--------------|-----------------------------------|
 * | codex        | memories/soma/active-vsa.md       |
 * | pi-dev       | agent/soma/active-vsa.md          |
 * | claude-code  | rules/soma/ACTIVE_VSA.md          |
 * | cursor       | .cursor/rules/soma/ACTIVE_VSA.md  |
 *
 * The Claude Code path moved from `PAI/ACTIVE_VSA.md` (the original
 * #37 spec) to `rules/soma/ACTIVE_VSA.md` per the soma#64 pivot (#29).
 *
 * Throws on unsupported substrates so a new substrate must be added
 * here explicitly rather than silently picking a default.
 */
export function activeVsaProjectionPath(substrate: SubstrateId): string {
  switch (substrate) {
    case "codex":
      return "memories/soma/active-vsa.md";
    case "pi-dev":
      return "agent/soma/active-vsa.md";
    case "claude-code":
      return "rules/soma/ACTIVE_VSA.md";
    case "cursor":
      return ".cursor/rules/soma/ACTIVE_VSA.md";
    case "grok":
      return "skills/soma/active-vsa.md";
    case "cortex":
    case "custom":
      throw new Error(`activeVsaProjectionPath: unsupported substrate '${substrate}'`);
  }
}

/**
 * Convenience for adapter `project*Home` functions (#37 sage r1):
 * returns the single-entry bundle file array when `activeVsa` is set,
 * empty array otherwise. Lets adapters spread `...activeVsaBundleFile(...)`
 * instead of re-implementing the conditional and path lookup.
 */
export function activeVsaBundleFile(
  substrate: SubstrateId,
  activeVsa: VerificationStateArtifact | undefined,
): { path: string; content: string }[] {
  if (!activeVsa) return [];
  return [{ path: activeVsaProjectionPath(substrate), content: renderActiveVsaFile(activeVsa) }];
}
