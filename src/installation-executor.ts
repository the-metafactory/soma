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
  private partial: SomaPartialInstallResult;
  private somaHome?: SomaHomeBootstrapResult;
  private substrateHome?: WrittenProjection;
  private runtimeArtifact?: { path: string; hash: string; previous?: string };
  private projectedSkills?: InstalledSkill[];
  private unprojectableSkills?: UninstallableSkillReport[];

  constructor(substrate: InstallSubstrate) {
    this.partial = { substrate };
  }

  record(result: SomaInstallExecutionRecord): void {
    if (result.somaHome) this.somaHome = result.somaHome;
    if (result.substrateHome) this.substrateHome = result.substrateHome;
    if (result.runtimeArtifact) this.runtimeArtifact = result.runtimeArtifact;
    if (result.projectedSkills) this.projectedSkills = result.projectedSkills;
    if (result.unprojectableSkills) this.unprojectableSkills = result.unprojectableSkills;
    this.partial = {
      ...this.partial,
      ...(result.runtimeArtifact ? { runtimeArtifact: { hash: result.runtimeArtifact.hash, replacedPrevious: result.runtimeArtifact.previous !== undefined } } : {}),
      ...(result.somaHome ? { somaHome: { filesWritten: result.somaHome.files.length } } : {}),
      ...(result.substrateHome ? { substrateHome: { filesWritten: result.substrateHome.files.length } } : {}),
      ...(result.projectedSkills ? { projectedSkillCount: result.projectedSkills.length } : {}),
      ...(result.unprojectableSkills ? { unprojectableSkillCount: result.unprojectableSkills.length } : {}),
    };
  }

  snapshot(): SomaPartialInstallResult {
    return snapshotSomaPartialInstallResult(this.partial);
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
    const somaHome = this.somaHome;
    const substrateHome = this.substrateHome;
    const projectedSkills = this.projectedSkills;
    const unprojectableSkills = this.unprojectableSkills;
    if (!somaHome || !substrateHome || !projectedSkills || !unprojectableSkills) {
      throw new Error("Soma installation result is incomplete.");
    }
    return {
      substrate: this.partial.substrate,
      ...(this.runtimeArtifact ? { runtimeArtifact: { ...this.runtimeArtifact } } : {}),
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
