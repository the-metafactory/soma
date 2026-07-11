import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPaths } from "./paths";
import { buildSubstrateHomeProjection } from "./home-projection";
import { isRegisteredInstallSubstrate } from "./install-spec-registry";
import { loadMemoryIndexForProjection, reindexMemoryIfStale } from "./memory-index";
import { appendSomaMemoryEvent } from "./memory";
import { loadSomaHome } from "./soma-home";
import type { ProjectionInput, SubstrateId } from "./types";

/**
 * Note-pointer count for the `memory.projection` event: the rendered index lists
 * one `- <slug> — …` bullet per admitted note under its `## <Store>` header, so
 * top-level bullets count the projected notes without re-parsing the corpus.
 */
function countIndexPointers(indexContent: string): number {
  return indexContent.split("\n").filter((line) => /^-\s+\S/.test(line)).length;
}

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
 *    then write out ONLY the memory file — CONTEXT.md, PURPOSE.md, SKILLS.md,
 *    POLICY.md, etc. are left untouched on disk. The memory file is identified
 *    by its DEFINING property: it is the one file projected as the verbatim
 *    rendered index (`indexContent`), so `file.content === indexContent` selects
 *    it. This leans on that invariant rather than hardcoding each adapter's path
 *    (claude-code `rules/soma/MEMORY.md`, codex `memories/soma/memory-index.md`,
 *    …); the early empty-index guard above rules out a spurious match on empty
 *    content. (A dedicated adapter-level memory-file accessor would be a cleaner
 *    contract than content equality — deferred; see PR #443 follow-ups.)
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

  const target = join(projection.substrateHome, memoryFile.path);
  // Same on-disk normalization `writeProjectionFile` (install.ts) applies to
  // every projected file, so a reproject produces byte-identical output to what
  // a full install/reproject would write for this one file.
  const desired = `${memoryFile.content.trimEnd()}\n`;
  // Idempotent: when the projection is already current, skip the write so an
  // idle SessionStart reproject touches no disk at all (no churn, no mtime bump).
  // The file is still "projected" — return its path regardless.
  const existing = await readFile(target, "utf8").catch(() => undefined);
  if (existing !== desired) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, desired, "utf8");
  }

  // ONE observational `memory.projection` event per projection (audit fix, T2):
  // the MEMORY.md bundle is injected into a substrate's session context. This is
  // passive context loading, NOT deliberate use — it is deliberately NOT counted
  // by memory_loop_closure (only recall/promotion/verify move that). It records
  // the note count so projection frequency is visible against read frequency.
  // Best-effort: telemetry must never fail an otherwise-successful projection.
  try {
    await appendSomaMemoryEvent(somaHome, {
      timestamp: options.now?.toISOString(),
      substrate: options.substrate,
      kind: "memory.projection",
      summary: `Projected ${countIndexPointers(indexContent)} memory note(s) into ${options.substrate}`,
      metadata: {
        substrate: options.substrate,
        noteCount: countIndexPointers(indexContent),
        reindexed,
      },
    });
  } catch {
    // best-effort telemetry
  }

  return { reindexed, projected: target };
}
