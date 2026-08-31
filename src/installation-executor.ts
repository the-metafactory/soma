import { SomaInstallError, type SomaInstallOperation, type SomaPartialInstallResult } from "./installation-execution";
import type { InstallSubstrate, SomaInstallResult } from "./types";

/**
 * Internal substrate-neutral installer coordinator. Adapter facts stay in
 * SubstrateInstallSpec; this records the durable prefix at the installer seam.
 */
export class SomaInstallExecution {
  private partial: SomaPartialInstallResult;

  constructor(substrate: InstallSubstrate) {
    this.partial = { substrate };
  }

  record(result: Omit<Partial<SomaPartialInstallResult>, "substrate">): void {
    this.partial = { ...this.partial, ...result };
  }

  snapshot(): SomaPartialInstallResult {
    return snapshotPartial(this.partial);
  }

  async run<T>(operation: SomaInstallOperation, work: () => Promise<T> | T): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SomaInstallError) throw error;
      throw new SomaInstallError({ operation, partial: this.snapshot(), cause: error });
    }
  }

  result(): SomaInstallResult {
    const { somaHome, substrateHome, projectedSkills, unprojectableSkills } = this.partial;
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

function snapshotPartial(result: SomaPartialInstallResult): SomaPartialInstallResult {
  return {
    ...result,
    runtimeArtifact: result.runtimeArtifact ? { ...result.runtimeArtifact } : undefined,
    somaHome: result.somaHome ? { ...result.somaHome, files: [...result.somaHome.files] } : undefined,
    substrateHome: result.substrateHome ? { ...result.substrateHome, files: [...result.substrateHome.files] } : undefined,
    projectedSkills: result.projectedSkills?.map((skill) => ({ ...skill })),
    unprojectableSkills: result.unprojectableSkills?.map((report) => ({ ...report })),
  };
}
