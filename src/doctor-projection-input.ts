import { listBundledSkills } from "./bundled-skills";
import { loadActiveVsaForBundle } from "./adapter-active-vsa";
import { isEnoent } from "./fs-utils";
import { loadMemoryIndexForProjection } from "./memory-index";
import { loadSomaHome } from "./soma-home";
import type { ProjectionInput } from "./types";

export interface LoadProjectionInputForDoctorOptions {
  somaHome: string;
  somaRepoPath: string;
}

/**
 * Thrown ONLY when the Soma HOME cannot be loaded because it is not
 * installed / incomplete (an ENOENT reading the profile files under
 * `somaHome`). This is the precise "Soma is not installed here" signal
 * `soma doctor` turns into a non-fatal `not-diagnosable` finding.
 *
 * It deliberately does NOT cover a failure reading the soma REPO PATH (the
 * source checkout) or any other internal error — those are setup/internal
 * faults, not a user "not installed" state, and must surface as themselves
 * rather than be disguised as "run soma install" (sage#450 r5).
 */
export class SomaHomeNotLoadableError extends Error {
  constructor(readonly somaHome: string, readonly cause: unknown) {
    super(`Soma home is not installed or is incomplete at ${somaHome}`);
    this.name = "SomaHomeNotLoadableError";
  }
}

/**
 * Read-only load of the `ProjectionInput` a real `soma install` would have
 * used for the current Soma home — the READ half of
 * `installSomaForSubstrate`'s context assembly in `install.ts`, without any
 * of its WRITE side effects (home creation, VSA-skill baseline, bundled-skill
 * copy). `soma doctor` (soma#370 content-compare drift) uses this to project a
 * substrate in memory and diff it against what is actually on disk, so it must
 * construct the SAME input install does or every file would spuriously read as
 * stale.
 *
 * Deliberately does not create or mutate the Soma home: a doctor run that
 * silently repaired state before diagnosing it would defeat the point of a
 * read-only diagnostic. If the Soma home was never installed (bundled skills
 * never copied in, no VSA skill baseline), the loaded input legitimately
 * differs from a fresh install's — that surfaces as findings, which is
 * correct, not a bug to work around here.
 */
export async function loadProjectionInputForDoctor(
  options: LoadProjectionInputForDoctorOptions,
): Promise<ProjectionInput> {
  // Load the Soma home FIRST and in isolation: an ENOENT here (missing/empty
  // profile) is the one and only "Soma not installed" signal, wrapped in a
  // distinct typed error so the caller can react to it precisely. Wrapping the
  // whole loader instead would let an ENOENT from an UNRELATED source — most
  // notably `listBundledSkills(somaRepoPath)` reading the source checkout — be
  // misread as "the user's Soma home is not installed" (sage#450 r5). Only
  // ENOENT is treated as "not installed"; any other loadSomaHome failure
  // (permissions, a file where a dir belongs) propagates as the genuine fault.
  let context: Awaited<ReturnType<typeof loadSomaHome>>;
  try {
    context = await loadSomaHome(options.somaHome);
  } catch (error) {
    if (isEnoent(error)) throw new SomaHomeNotLoadableError(options.somaHome, error);
    throw error;
  }

  // The home loaded, so the rest is genuinely present-or-soft-failing: the VSA
  // and memory loaders return null/undefined when their optional sources are
  // absent, and `listBundledSkills` swallows a missing repo path to `[]`. Any
  // error that DOES escape here is a real internal fault and must propagate,
  // never be disguised as "not installed".
  const [activeVsa, memoryIndexContent, bundledSkillNames] = await Promise.all([
    loadActiveVsaForBundle({ somaHome: options.somaHome }),
    loadMemoryIndexForProjection({ somaHome: options.somaHome }),
    listBundledSkills(options.somaRepoPath),
  ]);

  return {
    ...context,
    activeVsa: activeVsa ?? undefined,
    memory: memoryIndexContent !== undefined ? { indexContent: memoryIndexContent } : undefined,
    bundledSkillNames,
  };
}
