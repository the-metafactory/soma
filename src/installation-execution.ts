import type { InstalledSkill, InstallSubstrate, UninstallableSkillReport } from "./types";

/** Stable category for an installation failure. */
export type SomaInstallStage = "environment" | "soma-home" | "substrate" | "projection" | "skills";

/** Safe-to-report details of a completed Soma-home bootstrap. */
export interface SomaHomeInstallReceipt {
  readonly somaHome: string;
  readonly files: readonly string[];
}

/** Safe-to-report details of a completed substrate projection. */
export interface SomaSubstrateInstallReceipt {
  readonly rootDir: string;
  readonly files: readonly string[];
}

/**
 * Safe-to-report evidence from operations completed before an installation
 * failure. It intentionally does not claim to inventory writes from the
 * operation that threw; installations converge by safe re-run instead.
 */
export interface SomaPartialInstallResult {
  readonly substrate: InstallSubstrate;
  readonly runtimeArtifact?: Readonly<{ path: string; hash: string; previous?: string }>;
  readonly somaHome?: SomaHomeInstallReceipt;
  readonly substrateHome?: SomaSubstrateInstallReceipt;
  readonly projectedSkills?: readonly InstalledSkill[];
  readonly unprojectableSkills?: readonly UninstallableSkillReport[];
}

/** Return an immutable, safe-to-report copy of completed-operation evidence. */
export function snapshotSomaPartialInstallResult(result: SomaPartialInstallResult): SomaPartialInstallResult {
  return Object.freeze({
    ...result,
    runtimeArtifact: result.runtimeArtifact ? Object.freeze({ ...result.runtimeArtifact }) : undefined,
    somaHome: result.somaHome
      ? Object.freeze({ somaHome: result.somaHome.somaHome, files: Object.freeze([...result.somaHome.files]) })
      : undefined,
    substrateHome: result.substrateHome
      ? Object.freeze({ ...result.substrateHome, files: Object.freeze([...result.substrateHome.files]) })
      : undefined,
    projectedSkills: result.projectedSkills ? Object.freeze(result.projectedSkills.map((skill) => Object.freeze({ ...skill }))) : undefined,
    unprojectableSkills: result.unprojectableSkills
      ? Object.freeze(result.unprojectableSkills.map((report) => Object.freeze({ ...report })))
      : undefined,
  });
}

/**
 * An installation failed after earlier operations completed. The partial result
 * is completed-operation evidence, not a rollback promise or an inventory of
 * failed-operation writes. Callers can report it and safely re-run the
 * convergent installation.
 */
export class SomaInstallError extends Error {
  /** Exact internal label for diagnosis; intentionally not a public enum. */
  readonly operation: string;
  readonly stage: SomaInstallStage;
  readonly partial: SomaPartialInstallResult;

  constructor(input: { operation: string; stage: SomaInstallStage; partial: SomaPartialInstallResult; cause: unknown }) {
    const detail = input.cause instanceof Error && input.cause.message.length > 0 ? ` ${input.cause.message}` : "";
    super(`Soma install failed during ${input.operation}.${detail}`, { cause: input.cause });
    this.name = "SomaInstallError";
    this.operation = input.operation;
    this.stage = input.stage;
    this.partial = snapshotSomaPartialInstallResult(input.partial);
  }
}
