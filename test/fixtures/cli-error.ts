import { runSomaCli, SomaCliError } from "../../src/cli";

/**
 * Run `soma <args>` expecting a non-zero exit, and return the thrown
 * `SomaCliError` (carrying `.exitCode` and the formatted `.message`) for the
 * caller to assert on. Fails loudly if the command exits 0 or throws a
 * non-CLI error.
 *
 * soma#370: `soma doctor` now exits 1 for drift and 2 for errors (a rendered
 * projection file missing on disk), mirroring the `vsa` command's
 * `SomaCliError(text, exitCode)` convention — so any CLI-level doctor
 * assertion beyond the clean case catches the thrown error rather than
 * awaiting a resolved string. Shared by the doctor test files so the
 * catch/assert boilerplate lives in one place.
 */
export async function expectSomaCliError(args: string[]): Promise<SomaCliError> {
  try {
    await runSomaCli(args);
  } catch (error) {
    if (error instanceof SomaCliError) return error;
    throw error;
  }
  throw new Error(`expected \`soma ${args.join(" ")}\` to exit non-zero`);
}
