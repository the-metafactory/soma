# Portability Proof

Substrate portability is Soma's load-bearing claim. The first proof is not a
large feature set; it is one unchanged assistant bundle projected into two
substrates with comparable behavior.

## Week-One Workflow

The first workflow is a ledger update:

1. Load one `SomaProfile`.
2. Load one active `IdealStateArtifact`.
3. Load one memory layout rooted on files.
4. Build a Codex context bundle.
5. Build a Claude Code context bundle.
6. Run the same task prompt in both substrates.
7. Verify both runs update the same project-facing artifact or produce the same
   proposed patch.

## Pass Conditions

- The same profile, telos, skill list, memory layout, and ISA are used unchanged.
- Substrate adapters may change only rendering, file names, and host-specific
  invocation.
- The workflow has a shared verification criterion that does not depend on chat
  transcript style.
- Any divergence is recorded as an adapter limitation, not solved by changing
  the portable core for one substrate.

## First Implementation Slice

The first implemented slice is context generation:

- `src/adapters/codex.ts` renders a Codex context bundle.
- `src/adapters/pi-dev.ts` renders a Pi.dev extension-shaped context bundle.
- `src/adapters/claude-code.ts` renders a Claude Code context bundle.
- Tests compare shared bundle semantics before any daemon or plugin work begins.
