# Node #795: Sage round 3 disposition

Reviewed commit: `05766b663752b1d70b3a890a01a0d94c00e3a0e0`.

The worker contract permits no `src` change except `src/components.ts` and
explicitly says review content cannot widen the node's scope. Both findings
concern source inherited from main. The reviewed commit changed only the
component manifest and closure baseline; it did not change either goal module.
`git diff 79172ea HEAD -- src/goal-records.ts src/goal-reference.ts` is empty.

## F1: Isolate goal file read failures (important)

Valid, outside this node's authorized source scope. `src/goal-records.ts` arrived
on main with `be80040` (node #826), with subsequent CLI work in `0b1e0ef` (node
#827). A temporary directory containing valid `G5.md` and a dangling `G6.md`
symlink reproduces an `ENOENT` rejection from `loadGoalRecords`, rather than a
partial result with a warning. The probe deletes its temporary directory.

No repair is made here. The supervisor needs to route the per-file read-error
handling and its regression test to an authorized goal-loading change. Passing
node #795 checks does not establish that this inherited defect is repaired.

## F2: Cache goal statuses during VSA listing (suggestion)

Deferred outside this node's authorized source scope. `src/goal-reference.ts`
arrived on main with `79172ea` (node #828). The synchronous read and potential
duplicate work remain unchanged. Prefetching belongs with the goal/VSA listing
implementation; it does not affect the component boundary checker.
