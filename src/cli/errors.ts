/**
 * Typed CLI error carrying an exit code distinct from the default 1.
 * Used by command modules to surface system errors (2) vs user errors (1)
 * vs success (0) per the established CLI convention.
 */
export class SomaCliError extends Error {
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2) {
    super(message);
    this.name = "SomaCliError";
    this.exitCode = exitCode;
  }
}
