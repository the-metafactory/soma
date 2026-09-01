import { SomaInstallError, snapshotSomaPartialInstallResult, type SomaInstallStage, type SomaPartialInstallResult } from "./installation-execution";
import type { InstalledSkill, InstallSubstrate, SomaHomeBootstrapResult, SomaInstallResult, UninstallableSkillReport, WrittenProjection } from "./types";

export const SOMA_INSTALL_OPERATION_STAGES = {
  "require-bun": "environment",
  "bootstrap-soma-home": "soma-home",
  "stage-runtime-artifact": "environment",
  "prune-legacy-vsa-skill": "soma-home",
  "install-soma-home-vsa-skill": "soma-home",
  "install-bundled-skills": "soma-home",
  "reload-soma-home-context": "soma-home",
  "validate-substrate": "substrate",
  "prepare-substrate-vsa-skill": "substrate",
  "install-substrate-vsa-skill": "substrate",
  "build-projection-input": "projection",
  "write-home-projection": "projection",
  "remove-obsolete-home-files": "projection",
  "run-post-projection": "projection",
  "install-lifecycle-projection": "projection",
  "reconcile-owned-subtrees": "projection",
  "project-registry-skills": "skills",
} as const satisfies Record<string, SomaInstallStage>;

type SomaInstallOperation = keyof typeof SOMA_INSTALL_OPERATION_STAGES;
export const SOMA_INSTALL_OPERATIONS = Object.keys(SOMA_INSTALL_OPERATION_STAGES) as SomaInstallOperation[];

interface SomaInstallExecutionRecord {
  runtimeArtifact?: { path: string; hash: string; previous?: string };
  somaHome?: SomaHomeBootstrapResult;
  substrateHome?: WrittenProjection;
  projectedSkills?: InstalledSkill[];
  unprojectableSkills?: UninstallableSkillReport[];
}

/**
 * Internal substrate-neutral installer coordinator. Adapter facts stay in
 * SubstrateInstallSpec; this records completed-operation evidence at the installer seam.
 */
export class SomaInstallExecution {
  private completed: SomaInstallExecutionRecord = {};

  constructor(private readonly substrate: InstallSubstrate) {}

  record(result: SomaInstallExecutionRecord): void {
    this.completed = { ...this.completed, ...result };
  }

  snapshot(): SomaPartialInstallResult {
    const { runtimeArtifact, somaHome, substrateHome, projectedSkills, unprojectableSkills } = this.completed;
    return snapshotSomaPartialInstallResult({
      substrate: this.substrate,
      ...(runtimeArtifact ? { runtimeArtifact: { hash: runtimeArtifact.hash, replacedPrevious: runtimeArtifact.previous !== undefined } } : {}),
      ...(somaHome ? { somaHome: { filesWritten: somaHome.files.length } } : {}),
      ...(substrateHome ? { substrateHome: { filesWritten: substrateHome.files.length } } : {}),
      ...(projectedSkills ? { projectedSkillCount: projectedSkills.length } : {}),
      ...(unprojectableSkills ? { unprojectableSkillCount: unprojectableSkills.length } : {}),
    });
  }

  async run<T>(operation: SomaInstallOperation, work: () => Promise<T> | T): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SomaInstallError) throw error;
      throw new SomaInstallError({ operation, stage: stageFor(operation), partial: this.snapshot(), cause: error });
    }
  }

  result(): SomaInstallResult {
    const { runtimeArtifact, somaHome, substrateHome, projectedSkills, unprojectableSkills } = this.completed;
    if (!somaHome || !substrateHome || !projectedSkills || !unprojectableSkills) {
      throw new Error("Soma installation result is incomplete.");
    }
    return {
      substrate: this.substrate,
      ...(runtimeArtifact ? { runtimeArtifact: { ...runtimeArtifact } } : {}),
      somaHome,
      substrateHome: { ...substrateHome, files: [...substrateHome.files] },
      projectedSkills: projectedSkills.map((skill) => ({ ...skill })),
      unprojectableSkills: unprojectableSkills.map((report) => ({ ...report })),
    };
  }
}

function stageFor(operation: SomaInstallOperation): SomaInstallStage {
  return SOMA_INSTALL_OPERATION_STAGES[operation];
}
