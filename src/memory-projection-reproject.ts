import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPaths } from "./paths";
import { buildSubstrateHomeProjection } from "./home-projection";
import { isRegisteredInstallSubstrate } from "./install-spec-registry";
import { loadMemoryIndexForProjection, reindexMemoryIfStale } from "./memory-index";
import { loadSomaHome } from "./soma-home";
import type { ProjectionInput, SubstrateId } from "./types";

export interface ReprojectSubstrateMemoryProjectionOptions {
  substrate: SubstrateId;
  homeDir?: string;
  somaHome?: string;
  substrateHome?: string;
  /** Injected clock, forwarded to a triggered {@link reindexMemoryIfStale} rebuild. */
  now?: Date;
}

export interface ReprojectSubstrateMemoryProjectionResult {
  /** Whether `memory/INDEX.md` was rebuilt (see {@link reindexMemoryIfStale}). */
  reindexed: boolean;
  /** Absolute path of the substrate memory file written, or `null` if nothing was projected. */
  projected: string | null;
}

/**
 * SessionStart's memory reproject (M8): keep a substrate's projected memory file
 * (e.g. claude-code's `rules/soma/MEMORY.md`) current without a full reproject.
 * Exactly two effects, both soft:
 *
 * 1. {@link reindexMemoryIfStale} — rebuild `memory/INDEX.md` only if stale.
 * 2. Re-render the FULL substrate home projection in memory (never write it),
 *    then write out ONLY the one file whose content is the verbatim rendered
 *    index — CONTEXT.md, PURPOSE.md, SKILLS.md, POLICY.md, etc. are left
 *    untouched on disk. Matching by content (not by a hardcoded per-adapter
 *    path) is deliberate: each adapter that supports memory projection places
 *    it somewhere different (claude-code `rules/soma/MEMORY.md`, codex
 *    `memories/soma/memory-index.md`, …), and this stays correct without this
 *    module needing to know every adapter's layout.
 *
 * No-ops with `projected: null` (never throws for this reason) when: memory
 * projection is disabled or the index is empty (nothing to project), or
 * `substrate` has no registered install spec/home-projection builder — true
 * for the two SubstrateId values that aren't installable substrates ("cortex",
 * "custom") and, today, for substrates with no memory-consuming adapter file
 * (cursor, grok, pi-dev). A genuine failure (e.g. the substrate home is not
 * writable) is NOT swallowed here — it rejects, and the caller (session-start
 * lifecycle, the CLI) decides how to handle it.
 */
export async function reprojectSubstrateMemoryProjection(
  options: ReprojectSubstrateMemoryProjectionOptions,
): Promise<ReprojectSubstrateMemoryProjectionResult> {
  const reindexResult = await reindexMemoryIfStale({
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    now: options.now,
  });
  const reindexed = reindexResult.rebuilt;

  const indexContent = await loadMemoryIndexForProjection({ homeDir: options.homeDir, somaHome: options.somaHome });
  if (indexContent === undefined) return { reindexed, projected: null };

  // "cortex"/"custom" are valid SubstrateId values with no install spec (no
  // default home, no home-projection builder) — nothing to project.
  if (!isRegisteredInstallSubstrate(options.substrate)) return { reindexed, projected: null };

  const somaHome = createPaths(options).root();
  const profileInput = await loadSomaHome(somaHome);
  const input: ProjectionInput = { ...profileInput, memory: { indexContent } };

  const projection = buildSubstrateHomeProjection(options.substrate, input, {
    homeDir: options.homeDir,
    somaHome: options.somaHome,
    substrateHome: options.substrateHome,
  });

  const memoryFile = projection.bundle.files.find((file) => file.content === indexContent);
  if (!memoryFile) return { reindexed, projected: null };

  // Same on-disk normalization `writeProjectionFile` (install.ts) applies to
  // every projected file, so a reproject produces byte-identical output to what
  // a full install/reproject would write for this one file.
  const target = join(projection.substrateHome, memoryFile.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${memoryFile.content.trimEnd()}\n`, "utf8");

  return { reindexed, projected: target };
}
