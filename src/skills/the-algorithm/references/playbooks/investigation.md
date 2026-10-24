# Playbook: Investigation

**Task shape:** a question about how or why something works, or a choice between alternatives. No change requested.
**You own:** the answer. It is cited, and it is read-only.

## Steps

1. Restate the question in one sentence. If the premise looks wrong, say so before answering it.
2. Recall prior work on the topic before reading fresh (the registry's `RecallPriorWork`).
3. Read the code, docs and records the answer depends on. Cite each claim with `file:line`, a command or a URL. For a how question, trace it through the registry's `TraceMechanics`; for a why question, through `TraceIntent`.
4. Separate what you read from what you infer; mark inference as such.
5. For a choice between alternatives, compare them in a table with the dimensions that decide it.
6. Give your own judgment with reasons, not only the evidence.
7. Change no file, branch or tracker. If the answer calls for a change, end there and route the change to the matching card.

## Criteria

- C1: Every claim about code carries a citation from a read in this run (probe: the reply against the read log).
- C2: The reply answers the question as restated in step 1 (probe: re-read the request).
- Anti: No file, branch or tracker changed (probe: `git status`, tracker activity).

## Principles

`references/principles/analysis-is-read-only.md`, `references/principles/ground-claims-in-this-session.md`; when the question rests on a doubtful belief, `references/principles/attack-the-premise.md`.

**Reply:** the answer with citations, your judgment and its reasons, and any premise you challenged.
