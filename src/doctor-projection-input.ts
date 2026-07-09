import { listBundledSkills } from "./bundled-skills";
import { loadActiveVsaForBundle } from "./adapter-active-vsa";
import { loadMemoryIndexForProjection } from "./memory-index";
import { loadSomaHome } from "./soma-home";
import type { ProjectionInput } from "./types";

export interface LoadProjectionInputForDoctorOptions {
  somaHome: string;
  somaRepoPath: string;
}

/**
 * Read-only reconstruction of the `ProjectionInput` a real `soma install`
 * would have built for the current Soma home — the READ half of
 * `installSomaForSubstrate`'s context assembly in `install.ts`, without any
 * of its WRITE side effects (bootstrap, VSA-skill baseline, bundled-skill
 * copy). `soma doctor` (soma#370 content-compare drift) uses this to
 * re-render a substrate's projection in memory and diff it against what is
 * actually on disk, so it must construct the SAME input install does or
 * every file would spuriously read as stale.
 *
 * Deliberately does not bootstrap or mutate the Soma home: a doctor run
 * that silently repaired state before diagnosing it would defeat the point
 * of a read-only diagnostic. If the Soma home was never installed (bundled
 * skills never copied in, no VSA skill baseline), the reconstructed input
 * legitimately differs from a fresh install's — that surfaces as findings,
 * which is correct, not a bug to work around here.
 */
export async function loadProjectionInputForDoctor(
  options: LoadProjectionInputForDoctorOptions,
): Promise<ProjectionInput> {
  const [context, activeVsa, memoryIndexContent, bundledSkillNames] = await Promise.all([
    loadSomaHome(options.somaHome),
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
