/**
 * Adapter active-ISA projection (#37).
 *
 * Single source of truth for the active-ISA file that every substrate
 * projects into its own home. Using `serializeIsa` guarantees the file
 * is BYTE-identical across substrates — that's AC-4's portability
 * contract (run a scaffold once, install for all three substrates,
 * the resulting active-isa.md files are exact byte equals).
 *
 * When no active ISA is set the file is OMITTED from the bundle
 * entirely (AC-2) rather than written empty — adapters must filter the
 * `null` result before adding to their files list.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getActiveIsa, readIsa } from "./isa";
import { serializeIsa } from "./isa-parse";
import type { IdealStateArtifact, SubstrateId } from "./types";

export interface LoadActiveIsaOptions {
  homeDir?: string;
  somaHome?: string;
}

/**
 * Resolve the active ISA from the Soma home, or null when no slug is
 * set. Used by per-substrate installers to populate `input.activeIsa`
 * before invoking the adapter's `project*Home`.
 */
export async function loadActiveIsaForBundle(
  options: LoadActiveIsaOptions = {},
): Promise<IdealStateArtifact | null> {
  const somaHome = resolve(options.somaHome ?? join(options.homeDir ?? homedir(), ".soma"));
  const state = await getActiveIsa({ somaHome });
  if (state?.activeSlug == null) return null;
  return readIsa(state.activeSlug, { somaHome });
}

/**
 * The byte-portable rendering of an active ISA — `serializeIsa` is the
 * same renderer used to write the on-disk file, so every substrate
 * projection ends up with identical bytes when scaffolded from the same
 * ISA. Adapters MUST call this (not their own serializer) to satisfy
 * AC-4 portability.
 */
export function renderActiveIsaFile(isa: IdealStateArtifact): string {
  return serializeIsa(isa);
}

/**
 * Per-substrate relative path inside the substrate home for the active
 * ISA file. Aligned with the #37 issue specification table.
 *
 * | Substrate    | Path                              |
 * |--------------|-----------------------------------|
 * | codex        | memories/soma/active-isa.md       |
 * | pi-dev       | agent/soma/active-isa.md          |
 * | claude-code  | rules/soma/ACTIVE_ISA.md          |
 * | cursor       | .cursor/rules/soma/ACTIVE_ISA.md  |
 *
 * The Claude Code path moved from `PAI/ACTIVE_ISA.md` (the original
 * #37 spec) to `rules/soma/ACTIVE_ISA.md` per the soma#64 pivot (#29).
 *
 * Throws on unsupported substrates so a new substrate must be added
 * here explicitly rather than silently picking a default.
 */
export function activeIsaProjectionPath(substrate: SubstrateId): string {
  switch (substrate) {
    case "codex":
      return "memories/soma/active-isa.md";
    case "pi-dev":
      return "agent/soma/active-isa.md";
    case "claude-code":
      return "rules/soma/ACTIVE_ISA.md";
    case "cursor":
      return ".cursor/rules/soma/ACTIVE_ISA.md";
    case "grok":
      return "skills/soma/active-isa.md";
    case "cortex":
    case "custom":
      throw new Error(`activeIsaProjectionPath: unsupported substrate '${substrate}'`);
  }
}

/**
 * Convenience for adapter `project*Home` functions (#37 sage r1):
 * returns the single-entry bundle file array when `activeIsa` is set,
 * empty array otherwise. Lets adapters spread `...activeIsaBundleFile(...)`
 * instead of re-implementing the conditional and path lookup.
 */
export function activeIsaBundleFile(
  substrate: SubstrateId,
  activeIsa: IdealStateArtifact | undefined,
): { path: string; content: string }[] {
  if (!activeIsa) return [];
  return [{ path: activeIsaProjectionPath(substrate), content: renderActiveIsaFile(activeIsa) }];
}
