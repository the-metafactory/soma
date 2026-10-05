# Writing a build node

A build node's body is the worker's whole brief (`references/walker.md`). The
worker reads it, the map's Destination, Constraints and Notes, and nothing else,
then opens a PR that a reviewer judges round by round. Every rule below comes
from a review analysis of 77 node → PR pairs (2026-10-05) and names the
miss it prevents. Of the extra review rounds a brief can prevent, two causes
dominated: **design left open in the brief**, which the worker settles by
invention and the reviewer then takes apart one hole per round, and **work too
wide for one review**, either bundled in from the start or added while the PR
was in review. Raw size alone predicted little where briefs were already
detailed; reviewer noise is not a brief problem and is not addressed here.

## Nothing is left to decide

A build node is filed below a closed decision, because the decision made it
specifiable (`references/fog.md`). If writing the brief surfaces a choice the
decision did not settle, the node is not ready:

- file the choice as a `grilling` node below the decision, and the build node
  `--blocked-by` it, or
- leave the build in **Not yet specified** until the choice closes.

Never hand the choice to the worker. A brief with a section headed "Shape (to
settle in the build)" cost ranger#82 seven rounds: the worker hand-rolled a
config-include walker, and each round found a new hole in it (unicode paths,
`~user` expansion, symlinks), until the brief was amended to fail closed and the
walker deleted. A `[NEEDS CLARIFICATION]` marker anywhere in the body means
the same thing: not ready to file as build.

**Name the mechanism at a security or matching boundary.** Where the change
decides what is allowed, matched, or trusted, the brief states the approach:
an allowlist, fail-closed on the unknown case, an exact comparison over a
canonical form. Left to the worker, every fix to an invented scheme opens the
next bypass. ranger#74 took six rounds on 397 lines that way.

## The brief

```markdown
## Deliverable

<one sentence: what exists or behaves differently when this lands, observable
from outside the module>

## Settled by

<the decision node this implements, by name with link, and the rule it settled,
in one or two lines; never restate a map constraint>

## Acceptance criteria

- Given <state>, when <action>, then <observable result>
- Given <a failure case: bad input, missing dependency, denied access>, when …,
  then <the defined failure behaviour>

Test seam: <the interface the tests drive, the highest one that reaches the
behaviour>

## Touches

<modules or areas, not line numbers>

## Assumptions

- <assumption>: if it turns out false, stop and escalate on the node instead of
  working around it

## Out of scope

- <adjacent work this node does not do>
```

- **Acceptance criteria** are testable and observable. "Fast", "robust",
  "clean" are not criteria. At least one criterion is a failure case, and the
  named seam is where the tests drive them; an untested failure path is what
  reviewers flag round after round (seelite#687: "seed 0 only", "printed, not
  asserted").
- **Assumptions** are stop triggers, not a risk register. List only the ones
  whose failure would change the deliverable; `- none` is a real answer.
- **Out of scope** binds the review too. A finding outside the acceptance
  criteria becomes a follow-up node below this one, not another commit on the
  PR. seelite#561 added five features after its seventh round and needed three
  more.

## One slice per node

One node is one vertical slice: a narrow path through every layer it needs,
complete on its own and reviewable in one sitting. The size rule has to be
checkable when the node is filed, before any code exists, so it is
structural, not a line count:

- **One cluster of acceptance criteria.** Criteria that could be met, merged,
  and judged independently are separate nodes.
- **No slices inside a node.** A brief whose plan reads "slice 1 / 2 / 3"
  is three nodes chained with `--blocked-by`. seelite#687 shipped three slices
  in one PR.
- **Split before filing.** If the brief needs more than one Deliverable
  sentence, or Touches lists areas that do not change together, split it now.
  Splitting after a review has started costs the rounds already spent.
- **Wide mechanical changes** (a rename, a schema migration) go expand →
  migrate → contract, one node each, so no single PR has to be reviewed whole.

A line budget belongs to the walker, which can measure the diff; orienteer
cannot.

## After the batch: retro the expensive ones

When a walked batch lands, run `/retro` on any PR that needed four or more
review rounds. The point is not the PR but the environment: a missing check, a
reviewer rule that misfires, a brief section that would have caught it. A fix
that belongs in this doctrine comes back here as a reviewed PR.
