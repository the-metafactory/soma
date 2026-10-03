# Charting work for an autonomous walker

A map can be walked by a headless walker: a process that claims frontier nodes, runs a worker session on each, and closes them through the gate. Ranger is one. The human resolves the decisions (grillings, prototypes, decision nodes), and the walker builds what those decisions spawn. That division only holds if the build work is charted so the walker can see it and take it. These rules come from a live walk on 2026-10-03, and each names the miss it prevents.

## Leave filed work unclaimed

When a closed decision makes build work specifiable, file it below the decision node, as fog.md's scaffold rule says, and **do not claim it** unless this session is about to build it. A claim takes a node off the frontier, and a walker never takes another identity's claim. A follow-up the deciding session filed and then claimed "for next" is invisible to the walker until a human releases it.

## Chart build work as build work

- **Kind:** `task` or `build`. A `grilling`, `prototype` or `decision` node stays human whatever its autonomy, so build work charted as a grilling never reaches the walker.
- **Split bundles.** A node that needs both an investigation and a choice ("measure X, then decide A or B") is two or three nodes:
  1. a measurement node whose output is a findings artifact;
  2. the decision, blocked by the measurement;
  3. the build, filed once the decision is made, because its content depends on the answer.
  Bundled, the whole node is HITL and the walker can touch none of it.
- **Autonomy is the human's grant.** `auto` is granted at charting time by the human, never minted by an agent for itself. Whether a walker takes `propose` build nodes (with a human's merge as the ratification) is that walker's configuration; chart honestly and let the walker decide.

## Write the body as the worker's whole brief

The worker session reads the node body and the map's Destination, Constraints and Notes, and nothing else. State:

- the deliverable;
- the files or modules it touches;
- the rule the decision settled;
- what is out of scope.

One node should be one PR-sized change. Work that a person must judge by eye or ear needs that said where the walker reads it. A walker that merges its own gate-passed PRs merges everything it is not told to hold back. For ranger, that means the issue label `ranger:needs-eye`: ranger still builds and gates the node, but leaves the merge to the human.

## Probes a walker can satisfy

- Prefer ungated probes that hold after a squash merge: `artifact-exists` with `atRef: main` on a file the work creates.
- `git-merged-into` on a feature branch fails after a squash merge, because the branch's commits are never ancestors of `main`.
- A `command` probe needs a registry entry for the walker's own checkout, which is a provisioning step, not a charting one.
- Wire `--blocked-by` to anything that must land first; the frontier is the walker's scheduler.
