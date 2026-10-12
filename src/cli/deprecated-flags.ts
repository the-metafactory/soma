/**
 * `soma init --yes` was the only mutating command not using the
 * `--dry-run`/`--apply` pair (user feedback, 2026-06-12). `--apply` is
 * canonical now; `--yes` stays accepted for one release with this warning.
 */
export function warnDeprecatedYesFlag(): void {
  process.stderr.write("Warning: --yes is deprecated; use --apply.\n");
}
