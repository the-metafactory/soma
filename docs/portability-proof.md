# Portability Proof

Substrate portability is Soma's load-bearing claim. The first proof is not a
large feature set; it is one unchanged Soma projected into two substrates with
comparable behavior. See [CONTEXT.md](../CONTEXT.md) for glossary.

## Week-One Workflow

The first workflow is a ledger update:

1. Load one `SomaProfile`.
2. Load one active `IdealStateArtifact`.
3. Load one memory layout rooted on files.
4. Project Soma into Codex.
5. Project Soma into Claude Code.
6. Run the same task prompt in both substrates.
7. Verify both runs update the same project-facing artifact or produce the same
   proposed patch.

## Pass Conditions

- The same profile, telos, skill list, memory layout, and ISA are used unchanged.
- Substrate adapters may change only projection shape, file names, and
  host-specific invocation.
- The workflow has a shared verification criterion that does not depend on chat
  transcript style.
- Any divergence is recorded as an adapter limitation, not solved by changing
  the portable core for one substrate.

## First Implementation Slice

The first implemented slice is projection:

- `src/adapters/codex.ts` projects Soma into Codex shape.
- `src/adapters/pi-dev.ts` projects Soma into a Pi.dev extension shape.
- `src/adapters/claude-code.ts` projects Soma into Claude Code shape.
- Tests compare shared projection semantics before any daemon or plugin work
  begins.

## CI Proof

The V0 CI proof is deterministic and does not require live substrate runtimes.
It is implemented in `test/portability-ci.test.ts` and run by the
`Portability` GitHub Actions workflow on pull requests and pushes to `main`.

The CI suite verifies:

- Project projections for Codex, Pi.dev, Claude Code, and Cursor preserve the
  same semantic Soma content from one `ProjectionInput`.
- Portable skills pass the existing static smoke verifier for the CI-supported
  smoke targets, Codex and Pi.dev.
- Active ISA state survives a project -> writeback -> reproject round trip
  across all shipping home projections.

This is intentionally not a live behavioral equivalence test. Running the same
task inside real Codex, Pi.dev, Claude Code, and Cursor sessions is a V2+
runtime harness because it needs installed hosts, model execution, and
substrate-specific authentication.
