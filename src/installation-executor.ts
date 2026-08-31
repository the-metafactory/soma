import { SomaInstallError, snapshotSomaPartialInstallResult, type SomaInstallStage, type SomaPartialInstallResult } from "./installation-execution";
import type { InstallSubstrate, SomaHomeBootstrapResult, SomaInstallResult, WrittenProjection } from "./types";

export const SOMA_INSTALL_OPERATIONS = [
  "require-bun",
  "bootstrap-soma-home",
  "stage-runtime-artifact",
  "prune-legacy-vsa-skill",
  "install-soma-home-vsa-skill",
  "install-bundled-skills",
  "reload-soma-home-context",
  "validate-substrate",
  "prepare-substrate-vsa-skill",
  "install-substrate-vsa-skill",
  "build-projection-input",
  "write-home-projection",
  "remove-obsolete-home-files",
  "run-post-projection",
  "install-lifecycle-projection",
  "reconcile-owned-subtrees",
  "project-registry-skills",
] as const;

type SomaInstallOperation = typeof SOMA_INSTALL_OPERATIONS[number];

type SomaInstallExecutionRecord = Omit<Partial<SomaPartialInstallResult>, "substrate" | "somaHome"> & {
  somaHome?: SomaHomeBootstrapResult;
  substrateHome?: WrittenProjection;
};

/**
 * Internal substrate-neutral installer coordinator. Adapter facts stay in
 * SubstrateInstallSpec; this records the durable prefix at the installer seam.
 */
export class SomaInstallExecution {
  private partial: SomaPartialInstallResult;
  private somaHome?: SomaHomeBootstrapResult;
  private substrateHome?: WrittenProjection;

  constructor(substrate: InstallSubstrate) {
    this.partial = { substrate };
  }

  record(result: SomaInstallExecutionRecord): void {
    if (result.somaHome) this.somaHome = result.somaHome;
    if (result.substrateHome) this.substrateHome = result.substrateHome;
    this.partial = {
      ...this.partial,
      ...result,
      ...(result.somaHome ? { somaHome: { somaHome: result.somaHome.somaHome, files: [...result.somaHome.files] } } : {}),
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
    const { projectedSkills, unprojectableSkills } = this.partial;
    const somaHome = this.somaHome;
    const substrateHome = this.substrateHome;
    if (!somaHome || !substrateHome || !projectedSkills || !unprojectableSkills) {
      throw new Error("Soma installation result is incomplete.");
    }
    return {
      substrate: this.partial.substrate,
      ...(this.partial.runtimeArtifact ? { runtimeArtifact: { ...this.partial.runtimeArtifact } } : {}),
      somaHome,
      substrateHome: { ...substrateHome, files: [...substrateHome.files] },
      projectedSkills: projectedSkills.map((skill) => ({ ...skill })),
      unprojectableSkills: unprojectableSkills.map((report) => ({ ...report })),
    };
  }
}

function stageFor(operation: SomaInstallOperation): SomaInstallStage {
  if (operation === "require-bun" || operation === "stage-runtime-artifact") return "environment";
  if (operation === "bootstrap-soma-home" || operation.includes("soma-home")) return "soma-home";
  if (operation === "validate-substrate" || operation.includes("substrate-vsa")) return "substrate";
  if (operation === "project-registry-skills") return "skills";
  return "projection";
}
