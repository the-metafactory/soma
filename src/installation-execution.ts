import type { InstallSubstrate, SomaHomeBootstrapResult, SomaInstallResult, WrittenProjection } from "./types";
import type { InstalledSkill, UninstallableSkillReport } from "./types";

/** Exact ordered operation currently performed by the substrate-neutral installer. */
export type SomaInstallOperation =
  | "require-bun"
  | "bootstrap-soma-home"
  | "stage-runtime-artifact"
  | "prepare-soma-home-skills"
  | "validate-substrate"
  | "install-vsa-skill"
  | "build-projection-input"
  | "write-home-projection"
  | "remove-obsolete-home-files"
  | "run-post-projection"
  | "install-lifecycle-projection"
  | "reconcile-owned-subtrees"
  | "project-registry-skills";

/** Durable prefix of an installation, suitable for safe re-run recovery. */
export interface SomaPartialInstallResult {
  substrate: InstallSubstrate;
  runtimeArtifact?: { path: string; hash: string; previous?: string };
  somaHome?: SomaHomeBootstrapResult;
  substrateHome?: WrittenProjection;
  projectedSkills?: InstalledSkill[];
  unprojectableSkills?: UninstallableSkillReport[];
}

function snapshotPartial(result: SomaPartialInstallResult): SomaPartialInstallResult {
  return {
    ...result,
    runtimeArtifact: result.runtimeArtifact ? { ...result.runtimeArtifact } : undefined,
    substrateHome: result.substrateHome ? { ...result.substrateHome, files: [...result.substrateHome.files] } : undefined,
    projectedSkills: result.projectedSkills?.map((skill) => ({ ...skill })),
    unprojectableSkills: result.unprojectableSkills?.map((report) => ({ ...report })),
  };
}

/**
 * An installation failed after an earlier operation made state durable. The
 * partial result is intentionally a recovery receipt, not a rollback promise:
 * callers can inspect it, report it, and safely re-run installation.
 */
export class SomaInstallError extends Error {
  readonly operation: SomaInstallOperation;
  readonly partial: SomaPartialInstallResult;

  constructor(input: { operation: SomaInstallOperation; partial: SomaPartialInstallResult; cause: unknown }) {
    const detail = input.cause instanceof Error && input.cause.message.length > 0 ? ` ${input.cause.message}` : "";
    super(`Soma install failed during ${input.operation}.${detail}`, { cause: input.cause });
    this.name = "SomaInstallError";
    this.operation = input.operation;
    this.partial = snapshotPartial(input.partial);
  }
}

/**
 * Substrate-neutral installation execution. Adapter facts stay in each
 * SubstrateInstallSpec; this module owns ordered operations and their failure
 * receipt at the installer seam.
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
