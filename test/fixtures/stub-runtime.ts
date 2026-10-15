/**
 * A minimal runtime source for tests that install a substrate but do not test
 * runtime staging (node #914). Staging the real soma tree hashes, clones and
 * load-checks ~2,300 files per install; this one is a package manifest and an
 * entry module with no dependencies.
 *
 * Pass it as `runtimeSourceRoot` on an install. It moves the staged runtime
 * only: bundled skills and projections still read the real repo. Its CLI
 * answers `--version` (the staging load check) and exits 1 on every other
 * command. A test that executes the staged runtime (a hook, a policy check,
 * a doctor that rebuilds from the artifact) keeps the real source even when
 * it would pass on the stub: a fail-closed hook denies on that exit 1, so a
 * deny assertion would pass for the wrong reason.
 */
import { join } from "node:path";

export const STUB_RUNTIME_SOURCE = join(import.meta.dir, "stub-runtime");

/** The stub opt-in on its own, for an install or an in-process CLI run that passes nothing else. */
export const STUB_RUNTIME = Object.freeze({ runtimeSourceRoot: STUB_RUNTIME_SOURCE });
