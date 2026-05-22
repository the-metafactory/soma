/**
 * #106 — single-source helper for emitting the
 * `--include-substrate-specific` deprecation warning to stderr. Both
 * `parseImportArgs` (pai-pack surface) and `parseMigrateArgs`
 * (migrate-pai surface) accept the legacy flag for one release and
 * route through this helper so the wording stays consistent and the
 * test surface has a single text to assert on.
 *
 * Goes to stderr (not the CLI's returned stdout string) because
 * (a) it's a side-channel warning, not part of the command output,
 * and (b) it must not corrupt machine-parseable stdout content.
 */
export function warnDeprecatedSubstrateFlag(): void {
  process.stderr.write(
    "Warning: --include-substrate-specific is deprecated; use --include-unrecognized.\n",
  );
}
