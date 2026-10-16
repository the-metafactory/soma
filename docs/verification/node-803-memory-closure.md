# Memory relocation closure evidence (node #803)

The relocation raises two closure ceilings relative to `main`: `substrates`
from 40,000 to 42,500 and `flows` from 52,500 to 55,500. Passing the boundary
check depends on those increases. They accommodate runtime imports through
the required `src/memory/index.ts` public entry. The separate
`src/memory/types.ts` entry prevents that expansion for shared-type consumers.

Measured on 2026-10-16 against merge base
`d4a8da3acfc10e825b510f4e82fbee0cfec559d0` (`main` at measurement time), with
relocation source at `4f38c637f793654c3697c03a3ffab653c6722c85`:

| Component | Base closure LOC | Relocated closure LOC | Delta | Base ceiling | Relocated ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| memory | 11,603 | 11,596 | -7 | 12,500 | 12,500 |
| substrates | 37,811 | 40,381 | +2,570 | 40,000 | 42,500 |
| flows | 50,542 | 53,504 | +2,962 | 52,500 | 55,500 |

Every other component retains its base ceiling. These measurements supersede
the node's earlier approximate 40,303 / 52,697 figures against an older base.
This review pass changes no source files or ceilings.

## Cause of each remaining increase

`substrates` now enters the runtime public entry from the Claude Code and
Codex session-digest adapters and `doctor-projection-input.ts`. Previously
those callers imported individual memory implementation files. The barrel's
re-exports add these previously unreachable implementation files to the
component's closure (paths below are relative to `src/memory/`):

| File | LOC newly reachable by substrates | LOC newly reachable by flows |
| --- | ---: | ---: |
| memory.ts | 261 | 261 |
| memory-recall.ts | 252 | 252 |
| memory-journal.ts | 243 | 243 |
| memory-consolidate.ts | 815 | 815 |
| episodic-digest.ts | 78 | 78 |
| memory-backfill.ts | 520 | 520 |
| memory-audit.ts | 389 | 389 |
| memory-episodic.ts | already reachable | 389 |
| Total | 2,558 | 2,947 |

`flows` enters the same runtime entry through `home-bootstrap.ts`, `install.ts`,
`memory-projection-reproject.ts`, and `memory-promotion.ts`, plus the transitive
`doctor-projection-input.ts` import. It additionally gains
`memory-episodic.ts`, which the substrates already reached through their
session-digest adapters. These are runtime imports of functions or constants;
the types entry cannot replace them under the two-entry contract.

For `substrates`, the exact delta is 2,558 implementation lines + 15 barrel
lines + 727 extracted type lines - 722 lines removed from `src/types.ts` - 8
net lines from import formatting = **2,570**. For `flows`, it is 2,947 + 15 +
727 - 722 - 5 = **2,962**. The added type file mostly offsets declarations
removed from the shared spine; it does not explain the runtime expansion.
Memory itself changes by 727 + 15 - 722 - 27 = **-7**.

## Measurement and enforcement

The comparison uses `checkBoundaries` with each revision's real component
manifest: the base's `src/` and boundary JSON files were extracted with
`git archive` into a temporary directory, and the branch was checked in place.
The checker counts every reachable source file once, including type-only
edges. File-set comparison treats `src/memory/<original-name>.ts` as the moved
version of `src/<original-name>.ts`; the two new public entries remain new
files. LOC counting uses the checker's convention (no extra line for a trailing
newline). Closure size measures source context, not runtime latency.

`bun run check:boundaries` passes with four existing violations and zero new
ones. None has memory as its source. `test/boundaries.test.ts` also proves that
the transitive closure from `src/types.ts` reaches only `src/memory/types.ts`
inside memory, accepts both public entries, and rejects every other memory
file on the real manifest. Thus the two raised ceilings are disclosed costs
of the runtime public face; they do not hide a shared-types route through it.

The supervisor should include the two ceiling changes, measured deltas, and
runtime-import causes above in the PR description.
